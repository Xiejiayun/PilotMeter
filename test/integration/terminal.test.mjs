import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cachedStatus } from '../../dist/cli/terminal.js';
import { VERSION } from '../../dist/shared/runtime.js';

const terminalModule = new URL('../../dist/cli/terminal.js', import.meta.url).href;
const snapshot = () => ({
  period: new Date().toISOString().slice(0, 7), updatedAt: new Date().toISOString(), demo: false,
  local: { sessionCount: 2, unknownCalls: 1, pendingCalls: 0 },
  display: { label: '本机记录', percentage: null, used: '123', unit: 'nano AIU', reason: null },
});

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pilotmeter-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function eventually(predicate, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('statusline reads small current caches and rejects oversized or invalid cache files', async t => {
  const dir = await temporary(t);
  await writeFile(join(dir, 'status.json'), JSON.stringify(snapshot()));
  assert.match(await cachedStatus(dir), /123 nano AIU.*缓存可能陈旧/);
  await writeFile(join(dir, 'status.json'), ' '.repeat(65537));
  assert.equal(await cachedStatus(dir), 'PilotMeter · 本地快照暂不可用');
  await writeFile(join(dir, 'status.json'), JSON.stringify(snapshot()));
  await writeFile(join(dir, 'instance.json'), ' '.repeat(8193));
  assert.equal(await cachedStatus(dir), 'PilotMeter · 本地快照暂不可用');
  await writeFile(join(dir, 'instance.json'), '{broken');
  assert.equal(await cachedStatus(dir), 'PilotMeter · 本地快照暂不可用');
});

test('statusline deadline kills a blocked reader before returning its fallback', async t => {
  const dir = await temporary(t);
  const marker = join(dir, 'reader.pid');
  const preload = join(dir, 'blocked-reader.cjs');
  // Block the actual cache-reader process before it can complete a system call.
  await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`);
  const oldOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require="${preload.replaceAll('\\', '/')}"`;
  let value;
  const start = Date.now();
  try { value = await cachedStatus(dir); }
  finally { if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions; }
  assert.equal(value, 'PilotMeter · 本地快照暂不可用');
  assert.ok(Date.now() - start < 2000, 'A blocked reader must not hold the statusline open');
  const pid = Number(await readFile(marker, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

async function fakeInstance(t, dir, instanceId) {
  const instance = { app: 'pilotmeter', version: VERSION, pid: process.pid, instanceId, url: '', managementToken: 'synthetic' };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/health' ? instance : snapshot()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  instance.url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(dir, 'instance.json'), JSON.stringify(instance));
  return instance;
}

function syntheticTerminal(t, dir) {
  const script = `
    import { watch } from ${JSON.stringify(terminalModule)};
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'columns', { value: 160 });
    process.stdin.isRaw = false;
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; if (value) process.stdout.write('RAW_READY\\n'); };
    await watch(process.argv[1]);
    process.stdout.write('RAW_RESTORED=' + process.stdin.isRaw + '\\n');
    // This harness uses a pipe in place of a real TTY; release that synthetic handle.
    process.stdin.destroy();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SSH_CONNECTION: 'synthetic-terminal', PILOTMETER_NO_OSC8: '1' },
  });
  const terminal = { child, stdout: '', stderr: '', exited: once(child, 'exit') };
  child.stdout.setEncoding('utf8').on('data', chunk => { terminal.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { terminal.stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await terminal.exited; });
  return terminal;
}

test('watch publishes URLs after offline start and restart, o uses the new instance, and Ctrl+C restores input', { timeout: 15_000 }, async t => {
  const dir = await temporary(t);
  const terminal = syntheticTerminal(t, dir);
  await eventually(() => terminal.stdout.includes('RAW_READY'), 'watch should enter input mode');
  assert.match(terminal.stdout, /PilotMeter 已离线/);
  const first = await fakeInstance(t, dir, 'first');
  await eventually(() => terminal.stdout.includes(first.url), 'the first available daemon URL should appear');
  const second = await fakeInstance(t, dir, 'second');
  await eventually(() => terminal.stdout.includes(second.url), 'the restarted daemon URL should replace the old link');
  terminal.child.stdin.write('o');
  await eventually(() => terminal.stdout.includes(`${second.url}（远程环境`), 'o should open the current instance');
  terminal.child.stdin.write('\u0003');
  await eventually(() => terminal.stdout.includes('RAW_RESTORED=false'), `watch must restore input after Ctrl+C: ${terminal.stdout}`);
  const [code] = await terminal.exited;
  assert.equal(code, 0);
  assert.match(terminal.stdout, /RAW_RESTORED=false/);
  assert.equal(terminal.stderr, '');
});

test('watch q exits without stopping the service and restores raw input state', { timeout: 10_000 }, async t => {
  const dir = await temporary(t);
  const instance = await fakeInstance(t, dir, 'unchanged');
  const terminal = syntheticTerminal(t, dir);
  await eventually(() => terminal.stdout.includes('RAW_READY'), 'watch should enter input mode');
  terminal.child.stdin.write('q');
  const [code] = await terminal.exited;
  assert.equal(code, 0);
  assert.match(terminal.stdout, /RAW_RESTORED=false/);
  const response = await fetch(`${instance.url}/health`);
  assert.equal((await response.json()).instanceId, 'unchanged');
});
