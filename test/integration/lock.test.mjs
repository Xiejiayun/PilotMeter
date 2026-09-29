import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { acquireLock } from '../../dist/daemon/lock.js';

function contenderReport(child) {
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (error) reject(error); else resolve(result);
    };
    const onMessage = result => finish(null, result);
    const onError = error => finish(error);
    const onClose = (code, signal) => finish(new Error(`Lock contender closed before reporting: ${code ?? signal}`));
    child.once('message', onMessage);
    child.once('error', onError);
    // exit can arrive before an already-sent IPC message. close waits for the
    // IPC pipe to drain, so only it proves that no report can still arrive.
    child.once('close', onClose);
  });
}

test('a lock contender report may drain after process exit', async () => {
  const child = new EventEmitter();
  const report = contenderReport(child);
  const result = { acquired: false, message: 'A writer already owns this data directory.' };
  child.emit('exit', 0, null);
  child.emit('message', result);
  child.emit('close', 0, null);
  assert.deepEqual(await report, result);
});

test('a lock contender that closes without a report still fails', async () => {
  const child = new EventEmitter();
  const report = contenderReport(child);
  child.emit('exit', 2, null);
  child.emit('close', 2, null);
  await assert.rejects(report, /Lock contender closed before reporting: 2/);
});

test('a lock contender spawn error rejects without waiting for close', async () => {
  const child = new EventEmitter();
  const report = contenderReport(child);
  const error = new Error('synthetic spawn failure');
  child.emit('error', error);
  await assert.rejects(report, candidate => candidate === error);
});

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
      process.once('message',async()=>{await release();process.exit(0);});
      process.send({acquired:true});
    } catch(error) { process.send({acquired:false,message:error.message},()=>process.exit(0)); }
  `;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      // Register immediately: a losing process can exit before all peers report.
      // Unlike events.once(), this completion promise does not reject when an
      // IPC send races with a process that is already shutting down.
      const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      const record = { child, exited, acquired: false };
      children.push(record);
      return contenderReport(child).then(result => {
        record.acquired = result.acquired === true;
        return result;
      });
    }));
    assert.equal(results.filter(result => result.acquired).length, 1);
    const owner = JSON.parse(await fs.promises.readFile(join(dir, 'writer.lock', 'owner.json'), 'utf8'));
    assert.ok(children.some(({ child, acquired }) => acquired && child.pid === owner.pid));
  } finally {
    await Promise.all(children.map(async ({ child, exited, acquired }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const killIfRunning = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
      const deadline = setTimeout(killIfRunning, 5000); deadline.unref();
      // Losers have already started exiting and need no message. connected can
      // be stale even for the winner, so capture asynchronous EPIPE in the send
      // callback and await the exit listener installed when it was spawned.
      if (acquired) {
        if (child.connected) {
          try { child.send('release', error => { if (error) killIfRunning(); }); }
          catch { killIfRunning(); }
        } else killIfRunning();
      }
      try { await exited; } finally { clearTimeout(deadline); }
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
