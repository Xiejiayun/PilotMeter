import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';
import { probeCopilotVersion } from '../../dist/cli/doctor.js';

const realSpawn = crossSpawn.sync;
async function executable(t, { delay = 0, exitCode = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pilotmeter-version-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const capture = join(directory, 'starts.jsonl');
  const command = join(directory, 'synthetic-copilot.cjs');
  await writeFile(command, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + '\\n');
setTimeout(() => { process.stdout.write('GitHub Copilot CLI 1.0.88.'); process.exitCode = ${exitCode}; }, ${delay});
`, { mode: 0o755 });
  return { command, starts: async () => (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
function failed(code, pid = 0) {
  return { pid, status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('synthetic spawn failure'), { code }) };
}

test('bundled version probe allows a real cold startup longer than five seconds', async t => {
  const fixture = await executable(t, { delay: 5500 });
  const result = await probeCopilotVersion(fixture.command, true);
  assert.equal(result.status, 0);
  assert.ok(result.error == null);
  assert.equal(result.stdout, 'GitHub Copilot CLI 1.0.88.');
  assert.deepEqual(await fixture.starts(), [['--no-auto-update', '--version']]);
});

test('explicit version override keeps its five-second limit and is never replayed', async t => {
  const fixture = await executable(t, { delay: 6500 });
  const result = await probeCopilotVersion(fixture.command, false);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.deepEqual(await fixture.starts(), [['--version']]);
});

test('version probe retries busy failures only before the bundled process starts', async t => {
  const fixture = await executable(t);
  const errors = ['EPERM', 'EBUSY'];
  const mocked = t.mock.method(crossSpawn, 'sync', (...args) => errors.length ? failed(errors.shift()) : realSpawn(...args));
  const result = await probeCopilotVersion(fixture.command, true);
  assert.equal(result.status, 0);
  assert.equal(mocked.mock.callCount(), 3);
  assert.deepEqual(await fixture.starts(), [['--no-auto-update', '--version']]);
});

test('version probe never replays timeouts, missing commands, or an already started process', async t => {
  for (const [code, pid, bundled] of [['ETIMEDOUT', 42, true], ['ETIMEDOUT', 0, true], ['ENOENT', 0, true], ['EBUSY', 42, true], ['EPERM', 0, false]]) {
    const failure = failed(code, pid);
    const mocked = t.mock.method(crossSpawn, 'sync', () => failure);
    assert.equal(await probeCopilotVersion('synthetic-command', bundled), failure);
    assert.equal(mocked.mock.callCount(), 1, `${code}, pid=${pid}, bundled=${bundled}`);
    mocked.mock.restore();
  }
});

test('busy version startup retries stop after three failed creation attempts', async t => {
  const failure = failed('EBUSY');
  const mocked = t.mock.method(crossSpawn, 'sync', () => failure);
  assert.equal(await probeCopilotVersion('synthetic-command', true), failure);
  assert.equal(mocked.mock.callCount(), 3);
});

test('a completed nonzero version command is not replayed', async t => {
  const fixture = await executable(t, { exitCode: 7 });
  const result = await probeCopilotVersion(fixture.command, true);
  assert.equal(result.status, 7);
  assert.ok(result.error == null);
  assert.deepEqual(await fixture.starts(), [['--no-auto-update', '--version']]);
});
