import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CopilotClient, copilotEnvironment, copilotHost } from '../../dist/providers/copilot-client.js';
import { personalQuota } from '../../dist/providers/accounts.js';

const command = fileURLToPath(new URL('../fixtures/copilot-runtime.mjs', import.meta.url));
async function clientFor(t, mode = 'normal', options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pilotmeter-copilot-test-'));
  const client = new CopilotClient({ home, command, env: { ...process.env, MOCK_COPILOT_MODE: mode }, requestTimeoutMs: 3000, ...options });
  t.after(async () => { await client.close(); await rm(home, { recursive: true, force: true }); });
  return { client, home };
}
async function waitFor(client, id, predicate) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const state = client.getLogin(id);
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Mock login did not reach expected state');
}
async function requests(home) { return (await readFile(join(home, 'mock-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
const realSpawn = childProcess.spawn;
function mockSpawn(t, implementation) {
  const mocked = t.mock.method(childProcess, 'spawn', implementation);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return mocked;
}
function failedSpawn(code) {
  const child = new EventEmitter();
  process.nextTick(() => { child.emit('error', Object.assign(new Error('synthetic-private-start-error'), { code })); child.emit('close', -1); });
  return child;
}
function heldChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = 0;
  child.kill = () => {
    if (++child.kills === 1) setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

test('launch retries synchronous EPERM and asynchronous EBUSY only before a process starts', async t => {
  let attempts = 0;
  mockSpawn(t, (...args) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('synthetic-private-start-error'), { code: 'EPERM' });
    if (attempts === 2) return failedSpawn('EBUSY');
    return realSpawn(...args);
  });
  const { client } = await clientFor(t);
  assert.equal((await client.listAccounts()).length, 2);
  assert.equal(attempts, 3);
});

test('launch retries are bounded and missing commands and timeouts are not retried', async t => {
  for (const [code, expectedAttempts] of [['EPERM', 3], ['ENOENT', 1], ['ETIMEDOUT', 1]]) {
    await t.test(code, async subtest => {
      const mocked = mockSpawn(subtest, () => failedSpawn(code));
      const { client } = await clientFor(subtest);
      await assert.rejects(client.listAccounts(), error => error.code === 'CLI_START_FAILED' && !/synthetic-private/.test(error.message));
      assert.equal(mocked.mock.callCount(), expectedAttempts);
    });
  }
});

test('initial device output survives spawn handoff and an error after spawn never replays login', async t => {
  const child = heldChild();
  const mocked = mockSpawn(t, () => {
    process.nextTick(() => {
      child.emit('spawn');
      child.stdout.write('Open https://github.com/login/device\n');
      child.stderr.write('First copy your one-time code: ABCD-EFGH\n');
    });
    return child;
  });
  const { client } = await clientFor(t);
  const login = await client.startLogin();
  const state = await waitFor(client, login.id, state => state.status === 'pending');
  assert.equal(state.userCode, 'ABCD-EFGH');
  child.emit('error', Object.assign(new Error('synthetic-private-start-error'), { code: 'EPERM' }));
  assert.equal(client.getLogin(login.id).status, 'failed');
  assert.equal(mocked.mock.callCount(), 1);
});

test('close waits for an in-progress spawn and terminates it before returning', async t => {
  for (const action of ['startLogin', 'listAccounts']) {
    await t.test(action, async subtest => {
      const child = heldChild();
      let spawnEntered;
      const entered = new Promise(resolve => { spawnEntered = resolve; });
      const mocked = mockSpawn(subtest, () => { spawnEntered(); return child; });
      const { client } = await clientFor(subtest);
      const pending = client[action]();
      const rejected = assert.rejects(pending, { code: 'CLIENT_CLOSED' });
      await entered;
      let closed = false;
      const closing = client.close().then(() => { closed = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false);
      child.emit('spawn');
      await Promise.all([closing, rejected]);
      assert.equal(child.kills, 1);
      assert.equal(child.stdin.readableLength, 0, 'Closing during spawn must not send an account RPC.');
      assert.equal(mocked.mock.callCount(), 1);
    });
  }
});

test('closing during a retry delay prevents another process launch', async t => {
  let spawnEntered;
  const entered = new Promise(resolve => { spawnEntered = resolve; });
  const mocked = mockSpawn(t, () => { spawnEntered(); return failedSpawn('EPERM'); });
  const { client } = await clientFor(t);
  const rejected = assert.rejects(client.startLogin(), { code: 'CLIENT_CLOSED' });
  await entered;
  await client.close();
  await rejected;
  assert.equal(mocked.mock.callCount(), 1);
});

test('concurrent queries cannot reopen a runtime while device login is starting', async t => {
  const child = heldChild();
  let spawnEntered;
  const entered = new Promise(resolve => { spawnEntered = resolve; });
  let attempts = 0;
  mockSpawn(t, (...args) => {
    if (++attempts === 1) { spawnEntered(); return child; }
    return realSpawn(...args);
  });
  const { client, home } = await clientFor(t, 'login-pending');
  const first = assert.rejects(client.listAccounts(), { code: 'LOGIN_IN_PROGRESS' });
  await entered;
  const second = assert.rejects(client.listAccounts(), { code: 'LOGIN_IN_PROGRESS' });
  const starting = client.startLogin();
  child.emit('spawn');
  await Promise.all([first, second]);
  const login = await starting;
  await waitFor(client, login.id, state => state.status === 'pending');
  assert.equal(attempts, 2);
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.readableLength, 0);
  const trace = await requests(home);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].args.includes('login'), true);
});

test('close and login wait for a runtime whose idle shutdown has already started', async t => {
  for (const action of ['close', 'startLogin']) {
    await t.test(action, async subtest => {
      let shutdownStarted;
      const shuttingDown = new Promise(resolve => { shutdownStarted = resolve; });
      let exited = false;
      let releaseShutdown;
      let attempts = 0;
      mockSpawn(subtest, (...args) => {
        const child = realSpawn(...args);
        if (++attempts === 1) {
          child.once('close', () => { exited = true; });
          const kill = child.kill.bind(child);
          releaseShutdown = () => kill();
          child.kill = () => { shutdownStarted(); return true; };
        } else assert.equal(exited, true, 'The next login process must wait for the previous account runtime to exit.');
        return child;
      });
      const { client } = await clientFor(subtest, 'login-pending', { idleTimeoutMs: 30 });
      await client.listAccounts();
      await shuttingDown;
      let completed = false;
      const next = client[action]().then(value => { completed = true; return value; });
      await new Promise(resolve => setImmediate(resolve));
      try { assert.equal(completed, false); assert.equal(attempts, 1); }
      finally { releaseShutdown(); }
      const result = await next;
      assert.equal(exited, true);
      if (action === 'startLogin') await waitFor(client, result.id, state => state.status === 'pending');
    });
  }
});

test('Copilot profiles reject default homes and untrusted login hosts', () => {
  for (const home of ['relative', homedir(), join(homedir(), '.copilot')]) assert.throws(() => new CopilotClient({ home }), { code: 'HOME_INVALID' });
  for (const host of ['github.com', 'http://github.com', 'https://github.com.attacker.invalid', 'https://github.com@attacker.invalid', 'https://github.com/login/device', 'https://github.com:444', 'https://company.ghe.com/?a=b']) {
    assert.throws(() => copilotHost(host), { code: 'HOST_INVALID' });
  }
  assert.equal(copilotHost('https://company.ghe.com/'), 'https://company.ghe.com');
});

test('Copilot child environment pins the profile and removes implicit credentials and exporters', () => {
  const env = copilotEnvironment({ PATH: 'kept', COPILOT_HOME: 'wrong', GH_TOKEN: 'private', GITHUB_TOKEN: 'private', COPILOT_GITHUB_TOKEN: 'private', PILOTMETER_GITHUB_TOKEN: 'private', COPILOT_SDK_AUTH_TOKEN: 'private', COPILOT_DISABLE_KEYTAR: '1', OTEL_EXPORTER_OTLP_HEADERS: 'private', NODE_OPTIONS: '--require malicious', NODE_DEBUG: 'net', BASH_ENV: 'malicious' }, 'profile');
  assert.deepEqual(env, { PATH: 'kept', COPILOT_HOME: 'profile', NO_COLOR: '1', FORCE_COLOR: '0' });
});

test('account queries use only official read-only RPCs and discard credential-bearing fields', async t => {
  const { client, home } = await clientFor(t);
  const accounts = await client.listAccounts();
  assert.deepEqual(accounts, [
    { selectionId: 'account-one', host: 'https://github.com', login: 'test-user', authType: 'user', isCurrent: true },
    { selectionId: 'account-two', host: 'https://company.ghe.com', login: 'another-user', authType: 'user', isCurrent: false },
  ]);
  const quota = await client.getQuota('account-two');
  assert.equal(quota.selectionId, 'account-two'); assert.equal(quota.scope, 'user');
  assert.deepEqual(quota.snapshots, [{ type: 'premium_interactions', isUnlimitedEntitlement: false, entitlementRequests: '100',
    usedRequests: '9007199254740993.123456789', remainingPercentage: '42.5', overage: '0.123456789123456789',
    usageAllowedWithExhaustedQuota: true, overageAllowedWithExhaustedQuota: false, resetDate: '2026-10-01T00:00:00Z', unit: null, billingMode: 'unknown' }]);
  assert.doesNotMatch(JSON.stringify({ accounts, quota }), /synthetic-private|token|sensitive/);
  const trace = await requests(home);
  assert.deepEqual(trace[0].overrides, []);
  assert.equal(trace[0].home, home);
  assert.deepEqual(trace.slice(1).map(row => row.method), ['connect', 'auth.getStatus', 'account.getAllUsers', 'account.getQuota']);
  assert.deepEqual(trace.at(-1).params, { selectionId: 'account-two' });
  await assert.rejects(client.getQuota('not-listed'), { code: 'ACCOUNT_NOT_FOUND' });
});

test('fragmented JSON-RPC headers/bodies and additional Content-Type headers remain valid', async t => {
  const { client } = await clientFor(t, 'fragmented');
  assert.equal((await client.listAccounts()).length, 2);
  assert.equal((await client.getQuota('account-one')).snapshots[0].usedRequests, '9007199254740993.123456789');
});

test('models list binds the selected identity and exposes only explicit policy and safe capabilities', async t => {
  const { client, home } = await clientFor(t);
  await client.listAccounts();
  const result = await client.listModels('account-two');
  assert.equal(result.selectionId, 'account-two');
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.deepEqual(result.items.map(item => item.status), ['available', 'disabled', 'unknown', 'unknown']);
  assert.deepEqual(result.items.map(item => item.policyState), ['enabled', 'disabled', 'unconfigured', null]);
  assert.deepEqual(result.items[0], { id: 'synthetic-model', name: 'Synthetic Model', status: 'available', policyState: 'enabled',
    reason: '官方模型策略明确启用；不代表已完成实际调用验证。', vision: true, reasoningEffort: false, contextWindowTokens: 128000,
    multiplier: '0.123456789123456789' });
  assert.equal(result.items[3].vision, null); assert.equal(result.items[3].contextWindowTokens, null); assert.equal(result.items[3].multiplier, null);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|terms|token|metadata/);
  assert.doesNotMatch(result.items[1].reason, /组织禁用|企业禁用/);
  const trace = (await requests(home)).slice(1);
  assert.deepEqual(trace.map(row => row.method), ['connect', 'auth.getStatus', 'account.getAllUsers', 'models.list']);
  assert.deepEqual(trace.at(-1).params, { selectionId: 'account-two' });
  await assert.rejects(client.listModels('not-listed'), { code: 'ACCOUNT_NOT_FOUND' });
});

test('invalid, duplicate and oversized model catalogs fail safely; unsupported RPCs remain explicit', async t => {
  for (const [mode, code] of [['models-invalid', 'MODELS_INVALID'], ['models-duplicate', 'MODELS_INVALID'], ['models-many', 'MODELS_INVALID'],
    ['models-unsupported', 'RPC_UNSUPPORTED'], ['models-error', 'RPC_FAILED']]) {
    const { client } = await clientFor(t, mode);
    await client.listAccounts();
    await assert.rejects(client.listModels('account-one'), error => error.code === code && !/synthetic-private/.test(error.message));
  }
});

test('trusted bare account hostnames normalize to the same HTTPS current identity', async t => {
  const { client } = await clientFor(t, 'bare-hosts');
  assert.deepEqual(await client.listAccounts(), [
    { selectionId: 'account-one', host: 'https://github.com', login: 'test-user', authType: 'user', isCurrent: true },
    { selectionId: 'account-two', host: 'https://company.ghe.com', login: 'another-user', authType: 'user', isCurrent: false },
  ]);
});

test('opaque account selections are invalidated when the official runtime restarts', async t => {
  const { client, home } = await clientFor(t, 'exit-after-list');
  await client.listAccounts();
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(client.getQuota('account-one'), { code: 'ACCOUNT_NOT_FOUND' });
  assert.equal((await requests(home)).filter(row => row.method === 'account.getQuota').length, 0);
  await assert.rejects(client.listModels('account-one'), { code: 'ACCOUNT_NOT_FOUND' });
  assert.equal((await requests(home)).filter(row => row.method === 'models.list').length, 0);
});

test('idle runtimes close after queries, preserve in-flight quota requests, and reconnect with fresh selections', async t => {
  const { client, home } = await clientFor(t, 'slow-quota', { idleTimeoutMs: 50 });
  await client.listAccounts();
  // This RPC takes longer than the idle timeout; an active request must stay alive.
  assert.equal((await client.getQuota('account-one')).snapshots[0].usedRequests, '9007199254740993.123456789');
  assert.equal((await requests(home)).filter(row => row.method === 'connect').length, 1);
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(client.getQuota('account-one'), { code: 'ACCOUNT_NOT_FOUND' });
  await client.listAccounts();
  assert.equal((await client.getQuota('account-one')).snapshots[0].remainingPercentage, '42.5');
  assert.equal((await requests(home)).filter(row => row.method === 'connect').length, 2);
});

test('quota unit remains unknown unless explicitly declared by upstream', async t => {
  const { client } = await clientFor(t, 'quota-unit');
  await client.listAccounts();
  const snapshot = (await client.getQuota('account-one')).snapshots[0];
  assert.equal(snapshot.unit, 'ai-credits'); assert.equal(snapshot.billingMode, 'ai-credits');
  const invalid = await clientFor(t, 'quota-invalid');
  await invalid.client.listAccounts();
  await assert.rejects(invalid.client.getQuota('account-one'), { code: 'QUOTA_INVALID' });
});

test('raw JSON percentage digits survive RPC parsing and exact account complement subtraction', async t => {
  for (const [mode, remaining, used] of [
    ['quota-percentage-nearly-full', '99.999999999999999999', '0.000000000000000001'],
    ['quota-percentage-tiny', '0.000000000000000001', '99.999999999999999999'],
    ['quota-percentage-zero', '0', '100'], ['quota-percentage-full', '100', '0'],
  ]) {
    const { client } = await clientFor(t, mode);
    await client.listAccounts();
    const result = await client.getQuota('account-one');
    assert.equal(result.snapshots[0].remainingPercentage, remaining);
    const projected = personalQuota('synthetic-percentage-account', result).buckets[0];
    assert.equal(projected.remainingPercentage, remaining); assert.equal(projected.usedPercentage, used);
  }
});

test('exact percentage range checks reject values immediately beyond 0 or 100 without rounding them into range', async t => {
  for (const mode of ['quota-percentage-overfull', 'quota-percentage-negative', 'quota-percentage-unbounded', 'quota-percentage-missing']) {
    const { client } = await clientFor(t, mode);
    await client.listAccounts();
    await assert.rejects(client.getQuota('account-one'), { code: 'QUOTA_INVALID' });
  }
});

test('RPC errors and malformed responses produce only safe errors; stalled processes time out', async t => {
  for (const [mode, code] of [['rpc-error', 'RPC_FAILED'], ['unsupported', 'RPC_UNSUPPORTED'], ['wrong-version', 'CLI_INCOMPATIBLE'], ['bad-frame', 'CLI_PROTOCOL'], ['stall', 'CLI_TIMEOUT']]) {
    const { client } = await clientFor(t, mode, { requestTimeoutMs: 500 });
    await assert.rejects(client.listAccounts(), error => error.code === code && !/synthetic-private|credential/.test(error.message));
  }
});

test('device flow parses fragmented output across stdout/stderr and never returns raw diagnostics', async t => {
  const { client, home } = await clientFor(t, 'login-pending');
  const login = await client.startLogin();
  const state = await waitFor(client, login.id, state => state.status === 'pending');
  assert.equal(state.verificationUri, 'https://github.com/login/device');
  assert.equal(state.userCode, 'ABCD-EFGH');
  await assert.rejects(client.listAccounts(), { code: 'LOGIN_IN_PROGRESS' });
  await assert.rejects(client.startLogin(), { code: 'LOGIN_IN_PROGRESS' });
  const trace = await requests(home);
  assert.deepEqual(trace[0].args, ['--no-auto-update', '--no-color', 'login', '--device-code', '--host', 'https://github.com']);
  assert.deepEqual(trace[0].overrides, []);
  const cancelled = client.cancelLogin(login.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.userCode, null); assert.equal(cancelled.verificationUri, null);
  assert.equal(client.getLogin('another-attempt'), null);
});

test('concurrent starts cannot launch two device flows and stale attempts cannot cancel a retry', async t => {
  const { client } = await clientFor(t, 'login-pending');
  const first = client.startLogin();
  await assert.rejects(client.startLogin(), { code: 'LOGIN_IN_PROGRESS' });
  const firstLogin = await first; client.cancelLogin(firstLogin.id);
  const second = await client.startLogin();
  assert.notEqual(second.id, firstLogin.id);
  assert.equal(client.cancelLogin(firstLogin.id), null);
  assert.equal((await waitFor(client, second.id, state => state.status === 'pending')).userCode, 'ABCD-EFGH');
});

test('official command completion clears codes and permits a fresh read-only account check', async t => {
  const { client, home } = await clientFor(t, 'login-complete');
  await client.listAccounts();
  const login = await client.startLogin();
  const completed = await waitFor(client, login.id, state => state.status === 'complete');
  assert.equal(completed.userCode, null); assert.equal(completed.verificationUri, null);
  assert.equal((await client.listAccounts()).length, 2);
  assert.equal((await requests(home)).filter(row => row.method === 'connect').length, 2);
});

test('invalid device output, nonzero exits, and local expiry never report successful login', async t => {
  for (const [mode, expected] of [['login-error', 'failed'], ['login-no-code', 'failed'], ['login-overlong', 'failed'], ['login-conflicting', 'failed'], ['login-bad-url', 'expired'], ['login-pending', 'expired']]) {
    const { client } = await clientFor(t, mode, { loginTimeoutMs: 700 });
    const login = await client.startLogin();
    const state = await waitFor(client, login.id, state => !['starting', 'pending'].includes(state.status));
    assert.equal(state.status, expected, mode); assert.equal(state.userCode, null); assert.equal(state.verificationUri, null);
    assert.doesNotMatch(JSON.stringify(state), /synthetic-private|ABCD-EFGH/);
  }
});

test('known device-login failures explain recovery without forwarding CLI diagnostics', async t => {
  for (const [mode, code, message] of [
    ['login-network-error', 'LOGIN_NETWORK_ERROR', /网络或代理/],
    ['login-certificate-error', 'LOGIN_NETWORK_ERROR', /网络或代理/],
    ['login-denied', 'LOGIN_DENIED', /确认允许访问/],
    ['login-expired', 'LOGIN_EXPIRED', /获取新验证码/],
  ]) {
    const { client } = await clientFor(t, mode);
    const login = await client.startLogin();
    const state = await waitFor(client, login.id, state => !['starting', 'pending'].includes(state.status));
    assert.equal(state.status, code === 'LOGIN_EXPIRED' ? 'expired' : 'failed');
    assert.equal(state.error.code, code); assert.match(state.error.message, message);
    assert.equal(state.userCode, null); assert.equal(state.verificationUri, null);
    assert.doesNotMatch(JSON.stringify(state), /synthetic-private|credential|login\/device\/code|Login failed:/);
  }
});

test('device-code generation has a short deadline that stops once the code is ready', async t => {
  const silent = await clientFor(t, 'login-silent', { loginCodeTimeoutMs: 150, loginTimeoutMs: 2000 });
  const starting = await silent.client.startLogin();
  const failed = await waitFor(silent.client, starting.id, state => state.status === 'failed');
  assert.equal(failed.error.code, 'LOGIN_CODE_TIMEOUT');
  assert.match(failed.error.message, /暂未获取到.*验证码/);
  assert.equal(failed.userCode, null); assert.equal(failed.verificationUri, null);

  const ready = await clientFor(t, 'login-pending', { loginCodeTimeoutMs: 500, loginTimeoutMs: 2000 });
  const login = await ready.client.startLogin();
  await waitFor(ready.client, login.id, state => state.status === 'pending');
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(ready.client.getLogin(login.id).status, 'pending', 'Browser authorization retains its separate waiting period.');
  ready.client.cancelLogin(login.id);
});

test('closing a client cancels its device process and prevents further operations', async t => {
  const { client } = await clientFor(t, 'login-pending');
  const login = await client.startLogin();
  await client.close();
  assert.equal(client.getLogin(login.id).status, 'cancelled');
  await assert.rejects(client.listAccounts(), { code: 'CLIENT_CLOSED' });
  await assert.rejects(client.startLogin(), { code: 'CLIENT_CLOSED' });
});
