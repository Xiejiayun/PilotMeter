import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLock } from '../../dist/daemon/lock.js';

async function staleDirectory() {
  const dir = await fs.promises.mkdtemp(join(tmpdir(), 'pilotmeter-lock-'));
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'exit');
  await fs.promises.mkdir(join(dir, 'writer.lock'));
  await fs.promises.writeFile(join(dir, 'writer.lock', 'owner.json'), JSON.stringify({ pid: child.pid, id: 'dead-owner' }));
  return dir;
}

test('a delayed stale-lock renamer cannot remove another contender\'s live lock', async () => {
  const dir = await staleDirectory();
  const path = join(dir, 'writer.lock');
  const rename = fs.promises.rename;
  let enteredRename; let releaseRename; let renames = 0;
  const entered = new Promise(resolve => { enteredRename = resolve; });
  const gate = new Promise(resolve => { releaseRename = resolve; });
  const releases = [];
  fs.promises.rename = async (from, to) => {
    if (from === path && ++renames === 1) { enteredRename(); await gate; }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const first = acquireLock(dir).then(release => { releases.push(release); return 'acquired'; });
    await entered;
    const second = await acquireLock(dir).then(release => { releases.push(release); return 'acquired'; }, error => error.message);
    releaseRename();
    assert.equal(await first, 'acquired');
    assert.match(second, /recovery is already in progress/);
    assert.equal(releases.length, 1);
    assert.equal(renames, 1);
  } finally {
    releaseRename();
    fs.promises.rename = rename; syncBuiltinESMExports();
    for (const release of releases) await release();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('multiple real processes recovering one dead owner still produce exactly one writer', async () => {
  const dir = await staleDirectory(); const children = [];
  const lockModule = new URL('../../dist/daemon/lock.js', import.meta.url).href;
  const code = `
    const {acquireLock}=await import(${JSON.stringify(lockModule)});
    try {
      const release=await acquireLock(process.argv[1]);
      process.send({acquired:true});
      process.once('message',async()=>{await release();process.exit(0);});
    } catch(error) { process.send({acquired:false,message:error.message}); process.exit(0); }
  `;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      return new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    }));
    assert.equal(results.filter(result => result.acquired).length, 1);
    const owner = JSON.parse(await fs.promises.readFile(join(dir, 'writer.lock', 'owner.json'), 'utf8'));
    assert.ok(children.some(child => child.pid === owner.pid));
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      if (child.connected) child.send('release');
      else child.kill();
      await exited;
    }));
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('a crashed recovery mutex and ownerless lock fail safely with recovery instructions', async () => {
  const dir = await staleDirectory();
  try {
    const recovery = join(dir, 'writer.recovery.lock');
    await fs.promises.writeFile(recovery, '{"pid":2147483647,"id":"crashed-recovery"}');
    await assert.rejects(() => acquireLock(dir), /verify PilotMeter is stopped before removing/);
    assert.equal(JSON.parse(await fs.promises.readFile(join(dir, 'writer.lock', 'owner.json'), 'utf8')).id, 'dead-owner');
    await fs.promises.unlink(recovery);
    await fs.promises.unlink(join(dir, 'writer.lock', 'owner.json'));
    await assert.rejects(() => acquireLock(dir), /starting or incomplete/);
    assert.ok((await fs.promises.stat(join(dir, 'writer.lock'))).isDirectory());
    await assert.rejects(() => fs.promises.stat(recovery), { code: 'ENOENT' });
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
});
