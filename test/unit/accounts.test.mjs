import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AccountError, AccountsManager, personalQuota } from '../../dist/providers/accounts.js';
import { CopilotClientError } from '../../dist/providers/copilot-client.js';

const timestamp = '2026-09-28T09:00:00.000Z';
const host = 'https://github.com';
const identity = (login, changes = {}) => ({ selectionId: `private-selection-${login}`, host, login, authType: 'user', isCurrent: true, ...changes });
const quota = (used = '25', changes = {}) => ({
  selectionId: 'private-selection-not-for-browser', fetchedAt: timestamp, scope: 'user',
  snapshots: [{ type: 'chat', unit: null, billingMode: 'unknown', usedRequests: used, entitlementRequests: '100', remainingPercentage: '75',
    overage: '0', isUnlimitedEntitlement: false, usageAllowedWithExhaustedQuota: false, overageAllowedWithExhaustedQuota: false,
    resetDate: '2026-10-01T00:00:00.000Z' }], ...changes,
});
const models = (id = 'synthetic-model') => ({ selectionId: 'private-selection-not-for-browser', fetchedAt: timestamp,
  items: [{ id, name: 'Synthetic Model', status: 'available', reason: 'Synthetic policy enabled', policyState: 'enabled',
    vision: true, reasoningEffort: false, contextWindowTokens: 128000, multiplier: '1' }] });

async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail('Synthetic account operation did not settle');
    await delay(2);
  }
}

class FakeClient {
  constructor(home, login) {
    this.home = home; this.accounts = [identity(login)]; this.data = quota(); this.modelData = models();
    this.listCalls = 0; this.quotaCalls = []; this.closeCalls = 0; this.cancelCalls = [];
    this.listImpl = null; this.quotaImpl = null; this.startError = null; this.modelsImpl = null; this.modelsCalls = [];
  }
  async startLogin(loginHost) {
    if (this.startError) throw this.startError;
    this.state = { id: randomUUID(), status: 'pending', host: loginHost, verificationUri: `${loginHost}/login/device`, userCode: 'TEST-CODE',
      expiresAt: '2026-09-28T09:15:00.000Z', error: null };
    return { ...this.state };
  }
  getLogin(id) { return this.state?.id === id ? { ...this.state } : null; }
  cancelLogin(id) {
    this.cancelCalls.push(id);
    if (this.state?.id === id) this.state = { ...this.state, status: 'cancelled', userCode: null, verificationUri: null };
    return this.getLogin(id);
  }
  async listAccounts() { this.listCalls++; return this.listImpl ? this.listImpl() : structuredClone(this.accounts); }
  async getQuota(selectionId) { this.quotaCalls.push(selectionId); return this.quotaImpl ? this.quotaImpl(selectionId) : structuredClone(this.data); }
  async listModels(selectionId) { this.modelsCalls.push(selectionId); return this.modelsImpl ? this.modelsImpl(selectionId) : structuredClone(this.modelData); }
  async close() { this.closeCalls++; }
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-accounts-unit-'));
  const fixture = { directory, file: join(directory, 'github-accounts', 'accounts.json'), now: Date.parse(timestamp), clients: [], managers: [], plans: [], gates: [] };
  fixture.create = () => {
    const manager = new AccountsManager(directory, { now: () => fixture.now, clientFactory: home => {
      const plan = fixture.plans.shift() ?? { login: `test-user-${fixture.clients.length + 1}` };
      const client = new FakeClient(home, plan.login);
      Object.assign(client, plan);
      fixture.clients.push(client); return client;
    } });
    fixture.managers.push(manager); return manager;
  };
  fixture.gate = fallback => {
    let resolve; let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    fixture.gates.push(() => resolve(fallback));
    return { promise, resolve, reject };
  };
  t.after(async () => {
    for (const release of fixture.gates) release();
    for (const manager of fixture.managers) await manager.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

async function login(fixture, manager, loginName, options = {}) {
  fixture.plans.push({ login: loginName, ...options.client });
  const pending = await manager.startLogin(options.host ?? host, options.accountId);
  const client = fixture.clients.at(-1);
  client.state = { ...client.state, status: 'complete', userCode: null, verificationUri: null };
  assert.equal((await manager.loginStatus(pending.id)).status, 'verifying');
  await until(() => ['complete', 'failed'].includes(manager.overview().login.status));
  const finished = manager.overview().login;
  if (finished.status === 'complete') {
    await manager.select(finished.accountId);
    await manager.refresh(finished.accountId);
  }
  return { client, state: manager.overview().login, profile: manager.overview().accounts.find(account => account.id === finished.accountId) };
}

function blockRegistryWrites(fixture) {
  const original = readFileSync(fixture.file, 'utf8');
  rmSync(fixture.file); mkdirSync(fixture.file);
  return () => { rmSync(fixture.file, { recursive: true }); writeFileSync(fixture.file, original); };
}

test('a new manager is read-only until explicit login and exposes no inherited accounts', async t => {
  const f = fixture(t); const manager = f.create();
  await manager.initialize();
  assert.deepEqual(manager.overview().accounts, []);
  assert.equal(manager.active(), null);
  assert.equal(manager.overview().quota, null);
  assert.equal(manager.overview().models, null);
  assert.equal(await manager.runProfile(), null);
  assert.equal(f.clients.length, 0);
  assert.equal(existsSync(join(f.directory, 'github-accounts')), false);
});

test('models are account-bound, cloned, coalesced and stale after five minutes without GET-triggered RPCs', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice');
  assert.deepEqual(a.client.modelsCalls, ['private-selection-Alice']);
  const catalog = manager.overview().models;
  assert.equal(catalog.accountId, a.profile.id); assert.equal(catalog.source, 'copilot-cli-models.list');
  assert.equal(catalog.state, 'available'); assert.equal(catalog.stale, false); assert.equal(catalog.refreshing, false);
  catalog.items[0].name = 'mutated';
  assert.equal(manager.overview().models.items[0].name, 'Synthetic Model');
  f.now += 5 * 60_000;
  assert.equal(manager.overview().models.stale, false);
  f.now++;
  assert.equal(manager.overview().models.stale, true);
  assert.equal(a.client.modelsCalls.length, 1);
  const gate = f.gate(models('refreshed'));
  a.client.modelsImpl = () => gate.promise;
  const first = manager.refresh(a.profile.id); const second = manager.refresh(a.profile.id);
  await until(() => a.client.modelsCalls.length === 2);
  assert.equal(manager.overview().models.refreshing, true);
  gate.resolve({ ...models('refreshed'), fetchedAt: new Date(f.now).toISOString() });
  await Promise.all([first, second]);
  assert.equal(manager.overview().models.stale, false); assert.equal(manager.overview().models.refreshing, false);
  assert.equal(manager.overview().models.items[0].id, 'refreshed');
  await manager.refresh(a.profile.id);
  assert.equal(a.client.modelsCalls.length, 2, 'manual refresh stays subject to per-account throttle');
});

test('model and quota refresh failures retain only their own snapshots independently', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice');
  f.now += 60_001;
  a.client.data = quota('12'); a.client.modelsImpl = () => { throw new CopilotClientError('RPC_UNSUPPORTED', 'Synthetic model RPC unavailable'); };
  await manager.refresh(a.profile.id);
  let view = manager.overview();
  assert.equal(view.quota.state, 'available'); assert.equal(view.quota.buckets[0].used, '12');
  assert.equal(view.models.state, 'error'); assert.equal(view.models.stale, true); assert.equal(view.models.items[0].id, 'synthetic-model');
  assert.equal(view.models.error.code, 'RPC_UNSUPPORTED'); assert.equal(manager.active().status, 'connected');
  f.now += 60_001;
  a.client.modelsImpl = null; a.client.modelData = models('new-model');
  a.client.quotaImpl = () => { throw new Error('private-token'); };
  await manager.refresh(a.profile.id);
  view = manager.overview();
  assert.equal(view.quota.state, 'error'); assert.equal(view.quota.buckets[0].used, '12'); assert.equal(view.quota.stale, true);
  assert.equal(view.models.state, 'available'); assert.equal(view.models.items[0].id, 'new-model');
  assert.equal(view.models.error, null); assert.doesNotMatch(JSON.stringify(view), /private-token/);
  f.now += 60_001;
  a.client.quotaImpl = null;
  a.client.modelsImpl = () => { throw new CopilotClientError('AUTH_REQUIRED', 'Synthetic reauthentication required'); };
  await manager.refresh(a.profile.id);
  assert.equal(manager.active().status, 'reauth-required');
});

test('a late model response is isolated across selection, removal and reauthentication', async t => {
  for (const change of ['select', 'remove', 'reauth']) {
    const f = fixture(t); const manager = f.create(); await manager.initialize();
    const a = await login(f, manager, 'Alice');
    const b = await login(f, manager, 'Bob', { client: { modelData: models('bob-model') } });
    await manager.select(a.profile.id); f.now += 60_001;
    const gate = f.gate(models('late-alice-model')); a.client.modelsImpl = () => gate.promise;
    const before = a.client.modelsCalls.length; const pending = manager.refresh(a.profile.id);
    await until(() => a.client.modelsCalls.length > before);
    if (change === 'select') await manager.select(b.profile.id);
    if (change === 'remove') await manager.remove(a.profile.id);
    if (change === 'reauth') {
      f.plans.push({ login: 'Alice', modelData: models('renewed-model') });
      const attempt = await manager.startLogin(host, a.profile.id); f.clients.at(-1).state.status = 'complete';
      await manager.loginStatus(attempt.id);
      await until(() => manager.overview().login.status === 'complete');
    }
    gate.resolve(models('late-alice-model')); await pending;
    if (change === 'select') { assert.equal(manager.overview().models.accountId, b.profile.id); assert.equal(manager.overview().models.items[0].id, 'bob-model'); }
    if (change === 'remove') { assert.equal(manager.overview().accounts.some(item => item.id === a.profile.id), false); assert.notEqual(manager.overview().models?.accountId, a.profile.id); }
    if (change === 'reauth') {
      assert.notEqual(manager.overview().models?.items[0]?.id, 'late-alice-model');
      await manager.refresh(a.profile.id);
      assert.equal(manager.overview().models.items[0].id, 'renewed-model');
    }
  }
});

test('multiple logins use independent homes, server-confirmed identities and persisted active selection', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice'); const b = await login(f, manager, 'Bob');
  assert.equal(manager.overview().accounts.length, 2);
  assert.notEqual(a.profile.id, b.profile.id);
  assert.notEqual(a.client.home, b.client.home);
  assert.equal(manager.active().login, 'Bob');
  assert.equal(manager.overview().quota.accountId, b.profile.id);
  assert.deepEqual(b.client.quotaCalls, ['private-selection-Bob']);
  await manager.select(a.profile.id);
  assert.equal(manager.active().login, 'Alice');
  await manager.close();
  const reopened = f.create(); await reopened.initialize();
  assert.equal(reopened.active().id, a.profile.id);
  assert.equal(reopened.overview().accounts.length, 2);
  assert.equal(reopened.overview().quota, null, 'quota is not silently restored as fresh from disk');
  await reopened.select(null);
  const unselected = f.create(); await unselected.initialize();
  assert.equal(unselected.active(), null);
  assert.equal(unselected.overview().accounts.length, 2);
});

test('login requires exactly one current identity for the requested host', async t => {
  for (const accounts of [[], [identity('Alice', { isCurrent: false })], [identity('Alice'), identity('Bob')],
    [identity('Alice', { host: 'https://other.ghe.com' })]]) {
    const f = fixture(t); const manager = f.create(); await manager.initialize();
    const result = await login(f, manager, 'Alice', { client: { accounts } });
    assert.equal(result.state.status, 'failed');
    assert.equal(result.state.error.code, 'LOGIN_IDENTITY_UNKNOWN');
    assert.equal(manager.overview().accounts.length, 0);
    assert.equal(manager.active(), null);
    assert.equal(result.client.closeCalls, 1);
    assert.equal(result.client.quotaCalls.length, 0);
  }
});

test('case-insensitive relogin preserves profile identity while a different real identity cannot replace it', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const first = await login(f, manager, 'Alice');
  const failed = await login(f, manager, 'Bob', { accountId: first.profile.id });
  assert.equal(failed.state.status, 'failed');
  assert.equal(failed.state.error.code, 'LOGIN_IDENTITY_MISMATCH');
  assert.equal(manager.active().login, 'Alice');
  assert.equal(manager.overview().accounts.length, 1);
  assert.equal(first.client.closeCalls, 0);
  const before = (await manager.runProfile()).home;
  const renewed = await login(f, manager, 'alice', { accountId: first.profile.id });
  assert.equal(renewed.profile.id, first.profile.id);
  assert.equal(renewed.profile.createdAt, first.profile.createdAt);
  assert.equal(manager.overview().accounts.length, 1);
  assert.notEqual((await manager.runProfile()).home, before);
  assert.equal(first.client.closeCalls, 1);
  await assert.rejects(manager.startLogin('https://other.ghe.com', first.profile.id), error => error instanceof AccountError && error.status === 400);
});

test('login progress, conflicts, cancellation and provider expiry never add a phantom account', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const attempt = await manager.startLogin(); const client = f.clients.at(-1);
  assert.equal(attempt.status, 'pending');
  assert.equal((await manager.loginStatus(attempt.id)).userCode, 'TEST-CODE');
  await assert.rejects(manager.startLogin(), error => error.status === 409);
  const cancelled = await manager.cancelLogin(attempt.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.userCode, null);
  assert.equal(cancelled.verificationUri, null);
  assert.equal(client.closeCalls, 1);
  assert.deepEqual(client.cancelCalls, [attempt.id]);
  client.state.status = 'complete';
  assert.equal((await manager.loginStatus(attempt.id)).status, 'cancelled');
  assert.equal(manager.overview().accounts.length, 0);
  const next = await manager.startLogin(); const expiring = f.clients.at(-1);
  expiring.state = { ...expiring.state, status: 'expired', userCode: null, verificationUri: null, error: { code: 'LOGIN_EXPIRED', message: 'Synthetic timeout' } };
  const expired = await manager.loginStatus(next.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.userCode, null);
  assert.equal(manager.overview().accounts.length, 0);
  await assert.rejects(manager.loginStatus(attempt.id), error => error.status === 404);
  await assert.rejects(manager.cancelLogin('missing'), error => error.status === 404);
});

test('cancelling during identity verification prevents a late success from creating an account', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const gate = f.gate([identity('Alice')]);
  f.plans.push({ login: 'Alice', listImpl: () => gate.promise });
  const attempt = await manager.startLogin(); const client = f.clients.at(-1);
  client.state.status = 'complete';
  assert.equal((await manager.loginStatus(attempt.id)).status, 'verifying');
  await until(() => client.listCalls === 1);
  await manager.cancelLogin(attempt.id);
  gate.resolve([identity('Alice')]);
  await manager.select(null);
  assert.equal(manager.overview().login.status, 'cancelled');
  assert.deepEqual(manager.overview().accounts, []);
});

test('cancelling identity verification remains cancelled when its abandoned request fails later', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const gate = f.gate([identity('Alice')]);
  f.plans.push({ login: 'Alice', listImpl: () => gate.promise });
  const attempt = await manager.startLogin(); const client = f.clients.at(-1);
  client.state.status = 'complete';
  await manager.loginStatus(attempt.id);
  await until(() => client.listCalls === 1);
  await manager.cancelLogin(attempt.id);
  gate.reject(new CopilotClientError('CLI_CLOSED', 'Synthetic closed request'));
  await manager.select(null);
  assert.equal(manager.overview().login.status, 'cancelled');
  assert.deepEqual(manager.overview().accounts, []);
});

test('concurrent per-account refresh is deduplicated and late responses cannot change the active identity', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice'); const b = await login(f, manager, 'Bob');
  f.now += 60_001;
  const aGate = f.gate(quota('11')); const bGate = f.gate(quota('22'));
  a.client.quotaImpl = () => aGate.promise; b.client.quotaImpl = () => bGate.promise;
  const aBefore = a.client.quotaCalls.length; const bBefore = b.client.quotaCalls.length;
  const refreshA = manager.refresh(a.profile.id); const repeatA = manager.refresh(a.profile.id);
  const refreshB = manager.refresh(b.profile.id);
  await until(() => a.client.quotaCalls.length > aBefore && b.client.quotaCalls.length > bBefore);
  await manager.select(b.profile.id);
  assert.equal(manager.overview().refreshing, true);
  bGate.resolve(quota('22')); await refreshB;
  assert.equal(manager.overview().quota.buckets[0].used, '22');
  assert.equal(manager.overview().refreshing, false);
  aGate.resolve(quota('11')); await Promise.all([refreshA, repeatA]);
  assert.equal(manager.active().id, b.profile.id);
  assert.equal(manager.overview().quota.accountId, b.profile.id);
  assert.equal(manager.overview().quota.buckets[0].used, '22');
  assert.equal(a.client.quotaCalls.length, aBefore + 1);
  await manager.select(a.profile.id);
  assert.equal(manager.overview().quota.accountId, a.profile.id);
  assert.equal(manager.overview().quota.buckets[0].used, '11');
});

test('removing an account prevents an in-flight refresh from restoring its profile or quota', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice');
  f.now += 60_001; const gate = f.gate(quota('99')); a.client.quotaImpl = () => gate.promise;
  const before = a.client.quotaCalls.length; const pending = manager.refresh(a.profile.id);
  await until(() => a.client.quotaCalls.length > before);
  await manager.remove(a.profile.id);
  assert.equal(manager.active(), null);
  gate.resolve(quota('99')); await pending;
  assert.deepEqual(manager.overview().accounts, []);
  assert.equal(manager.overview().quota, null);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).profiles, []);
  await assert.rejects(manager.select(a.profile.id), error => error.status === 404);
  await assert.rejects(manager.runProfile(a.profile.id), error => error.status === 404);
});

test('refresh failures retain only their own stale snapshot and require reauth for missing identity', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice'); const b = await login(f, manager, 'Bob');
  f.now += 60_001;
  a.client.accounts = [];
  await manager.refresh(a.profile.id);
  assert.equal(manager.active().id, b.profile.id);
  assert.equal(manager.overview().quota.state, 'available');
  await manager.select(a.profile.id);
  assert.equal(manager.active().status, 'reauth-required');
  assert.equal(manager.overview().quota.state, 'error');
  assert.equal(manager.overview().quota.error.code, 'AUTH_REQUIRED');
  assert.equal(manager.overview().quota.buckets[0].used, '25');
  assert.equal(manager.overview().quota.stale, true);
  f.now += 60_001;
  a.client.accounts = [identity('Alice')]; a.client.quotaImpl = () => { throw new Error('private-path private-token'); };
  await manager.refresh(a.profile.id);
  assert.equal(manager.active().status, 'error');
  assert.equal(manager.overview().quota.error.code, 'ACCOUNT_UNAVAILABLE');
  assert.ok(!JSON.stringify(manager.overview()).includes('private-path'));
});

test('runProfile freezes the selected identity and original home across a UI switch and refuses drift', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice'); const b = await login(f, manager, 'Bob');
  await manager.select(a.profile.id);
  const gate = f.gate([identity('Alice')]); a.client.listImpl = () => gate.promise;
  const before = a.client.listCalls; const starting = manager.runProfile();
  await until(() => a.client.listCalls > before);
  await manager.select(b.profile.id);
  gate.resolve([identity('Alice')]);
  const captured = await starting;
  assert.equal(captured.profile.id, a.profile.id);
  assert.equal(captured.home, a.client.home);
  assert.equal(manager.active().id, b.profile.id);
  a.client.listImpl = null; a.client.accounts = [identity('Bob')];
  await assert.rejects(manager.runProfile(a.profile.id), error => error instanceof AccountError && error.status === 409);
  assert.equal(manager.overview().accounts.find(item => item.id === a.profile.id).status, 'reauth-required');
  assert.equal(manager.active().id, b.profile.id);
});

test('runProfile refuses a removed or replaced launch identity after awaiting the backend', async t => {
  for (const change of ['remove', 'relogin']) {
    const f = fixture(t); const manager = f.create(); await manager.initialize();
    const a = await login(f, manager, 'Alice');
    const gate = f.gate([identity('Alice')]); a.client.listImpl = () => gate.promise;
    const before = a.client.listCalls; const starting = manager.runProfile();
    const rejected = assert.rejects(starting, error => error instanceof AccountError && error.status === 409);
    await until(() => a.client.listCalls > before);
    if (change === 'remove') await manager.remove(a.profile.id);
    else await login(f, manager, 'Alice', { accountId: a.profile.id });
    gate.resolve([identity('Alice')]);
    await rejected;
  }
});

test('a pre-reauth refresh cannot overwrite the replacement identity or its new quota', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice');
  f.now += 60_001;
  const gate = f.gate(quota('999')); a.client.quotaImpl = () => gate.promise;
  const before = a.client.quotaCalls.length; const oldRefresh = manager.refresh(a.profile.id);
  await until(() => a.client.quotaCalls.length > before);
  f.plans.push({ login: 'Alice', data: quota('5') });
  const attempt = await manager.startLogin(host, a.profile.id); const replacement = f.clients.at(-1);
  replacement.state.status = 'complete';
  await manager.loginStatus(attempt.id);
  await until(() => manager.overview().login.status === 'complete');
  await manager.select(a.profile.id);
  gate.resolve(quota('999')); await oldRefresh;
  const current = manager.overview().quota;
  assert.notEqual(current?.buckets[0]?.used, '999');
  assert.equal(manager.active().status, 'connected');
  await manager.refresh(a.profile.id);
  assert.equal(manager.overview().quota.buckets[0].used, '5');
  assert.equal((await manager.runProfile()).home, replacement.home);
});

test('public DTOs and registry persist identities without credential, selection or absolute home values', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice', { client: { accounts: [identity('Alice', { token: 'synthetic-secret-token' })] } });
  const view = manager.overview();
  assert.deepEqual(Object.keys(view.accounts[0]).sort(), ['checkedAt', 'createdAt', 'host', 'id', 'login', 'status']);
  const publicText = JSON.stringify(view);
  const diskText = readFileSync(f.file, 'utf8');
  for (const text of [publicText, diskText]) {
    for (const forbidden of ['selectionId', 'private-selection', 'synthetic-secret-token', a.client.home, f.directory]) assert.ok(!text.includes(forbidden), forbidden);
  }
  assert.ok(!publicText.includes('homeId'));
  view.accounts[0].login = 'Mutated'; view.quota.buckets[0].used = '999';
  assert.equal(manager.active().login, 'Alice');
  assert.equal(manager.overview().quota.buckets[0].used, '25');
});

test('invalid or duplicate registry identities cannot become active profiles on restart', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  await login(f, manager, 'Alice'); await manager.close();
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  const malformed = [
    { ...saved, activeAccountId: randomUUID() },
    { ...saved, profiles: [{ ...saved.profiles[0], homeId: '../outside' }] },
    { ...saved, profiles: [{ ...saved.profiles[0], host: 'https://github.com.evil.test' }] },
    { ...saved, profiles: [...saved.profiles, { ...saved.profiles[0], id: randomUUID(), homeId: randomUUID(), login: 'ALICE' }] },
  ];
  for (const registry of malformed) {
    writeFileSync(f.file, JSON.stringify(registry));
    await assert.rejects(f.create().initialize(), error => /Invalid/.test(error.message) || error.code === 'HOST_INVALID');
  }
});

test('failed selection and removal writes leave the active account, cached quota and client intact', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice'); const b = await login(f, manager, 'Bob');
  const original = manager.overview();
  const restore = blockRegistryWrites(f);
  try {
    await assert.rejects(manager.select(a.profile.id));
    assert.equal(manager.active().id, b.profile.id);
    assert.deepEqual(manager.overview().accounts, original.accounts);
    assert.deepEqual(manager.overview().quota, original.quota);
    await assert.rejects(manager.remove(b.profile.id));
    assert.equal(manager.active().id, b.profile.id);
    assert.deepEqual(manager.overview().accounts, original.accounts);
    assert.deepEqual(manager.overview().quota, original.quota);
    assert.equal(b.client.closeCalls, 0);
    assert.equal((await manager.runProfile()).home, b.client.home);
  } finally { restore(); }
  const reopened = f.create(); await reopened.initialize();
  assert.equal(reopened.active().id, b.profile.id);
  assert.deepEqual(reopened.overview().accounts, original.accounts);
  await manager.select(a.profile.id);
  await manager.remove(b.profile.id);
  assert.equal(manager.active().id, a.profile.id);
  assert.equal(b.client.closeCalls, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).profiles.map(item => item.id), [a.profile.id]);
  await manager.close();
  assert.ok(f.clients.every(client => client.closeCalls > 0));
});

test('a failed new login registry write keeps the original account and closes the uncommitted client', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice');
  const original = manager.overview(); const saved = readFileSync(f.file, 'utf8');
  const restore = blockRegistryWrites(f);
  try {
    const failed = await login(f, manager, 'Bob');
    assert.equal(failed.state.status, 'failed');
    assert.equal(failed.state.accountId, null);
    assert.equal(failed.state.error.code, 'ACCOUNT_UNAVAILABLE');
    assert.deepEqual(manager.overview().accounts, original.accounts);
    assert.equal(manager.active().id, a.profile.id);
    assert.deepEqual(manager.overview().quota, original.quota);
    assert.equal(failed.client.closeCalls, 1);
    assert.equal(a.client.closeCalls, 0);
  } finally { restore(); }
  assert.equal(readFileSync(f.file, 'utf8'), saved);
  const reopened = f.create(); await reopened.initialize();
  assert.equal(reopened.active().id, a.profile.id);
  assert.deepEqual(reopened.overview().accounts, original.accounts);
  const retried = await login(f, manager, 'Bob');
  assert.equal(retried.state.status, 'complete');
  assert.equal(manager.overview().accounts.length, 2);
  await manager.close();
  assert.ok(f.clients.every(client => client.closeCalls > 0));
});

test('failed reauthentication persistence preserves the old home, credentials and quota', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice');
  const original = manager.overview(); const oldHome = (await manager.runProfile()).home;
  const restore = blockRegistryWrites(f);
  try {
    const failed = await login(f, manager, 'Alice', { accountId: a.profile.id });
    assert.equal(failed.state.status, 'failed');
    assert.equal(failed.state.accountId, null);
    assert.equal(failed.client.closeCalls, 1);
    assert.equal(a.client.closeCalls, 0);
    assert.equal((await manager.runProfile()).home, oldHome);
    assert.deepEqual(manager.overview().accounts, original.accounts);
    assert.deepEqual(manager.overview().quota, original.quota);
  } finally { restore(); }
  const reopened = f.create(); await reopened.initialize();
  assert.equal(reopened.active().id, a.profile.id);
  assert.deepEqual(reopened.overview().accounts, original.accounts);
  const retried = await login(f, manager, 'Alice', { accountId: a.profile.id });
  assert.equal(retried.profile.id, a.profile.id);
  assert.notEqual((await manager.runProfile()).home, oldHome);
  assert.equal(a.client.closeCalls, 1);
});

test('failure to prepare the account registry directory closes the new login client', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  writeFileSync(join(f.directory, 'github-accounts'), 'Synthetic file blocking the account directory');
  await assert.rejects(manager.startLogin());
  assert.equal(f.clients.length, 1);
  assert.equal(f.clients[0].closeCalls, 1);
  assert.equal(manager.overview().login, null);
  assert.deepEqual(manager.overview().accounts, []);
});

test('a failed refresh status write cannot replace the last committed quota or identity status', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice'); const original = manager.overview();
  f.now += 60_001; a.client.data = quota('99');
  const restore = blockRegistryWrites(f);
  try {
    await assert.rejects(manager.refresh(a.profile.id));
    assert.deepEqual(manager.overview().accounts, original.accounts);
    assert.deepEqual(manager.overview().quota, original.quota);
    assert.equal(manager.overview().refreshing, false);
    assert.equal(a.client.closeCalls, 0);
  } finally { restore(); }
  f.now += 60_001; await manager.refresh(a.profile.id);
  assert.equal(manager.overview().quota.buckets[0].used, '99');
  assert.notEqual(manager.active().checkedAt, original.accounts[0].checkedAt);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).profiles.map(({ homeId, ...profile }) => profile), manager.overview().accounts);
});

test('runProfile refuses identity drift even when persisting its reauth status fails', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice'); const original = manager.overview();
  a.client.accounts = [identity('Bob')];
  const restore = blockRegistryWrites(f);
  try {
    await assert.rejects(manager.runProfile());
    assert.deepEqual(manager.overview().accounts, original.accounts);
    assert.deepEqual(manager.overview().quota, original.quota);
  } finally { restore(); }
  await assert.rejects(manager.runProfile(), error => error instanceof AccountError && error.status === 409);
  assert.equal(manager.active().status, 'reauth-required');
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).profiles[0].status, 'reauth-required');
});

test('refresh commits queued during another login preserve both registry profiles and active selection', async t => {
  const f = fixture(t); const manager = f.create(); await manager.initialize();
  const a = await login(f, manager, 'Alice');
  f.now += 60_001;
  const quotaGate = f.gate(quota('77')); a.client.quotaImpl = () => quotaGate.promise;
  const before = a.client.quotaCalls.length; const refresh = manager.refresh(a.profile.id);
  await until(() => a.client.quotaCalls.length > before);
  const identityGate = f.gate([identity('Bob')]);
  f.plans.push({ login: 'Bob', listImpl: () => identityGate.promise });
  const attempt = await manager.startLogin(); const bClient = f.clients.at(-1);
  bClient.state.status = 'complete'; await manager.loginStatus(attempt.id);
  await until(() => bClient.listCalls === 1);
  quotaGate.resolve(quota('77'));
  identityGate.resolve([identity('Bob')]);
  await refresh;
  await until(() => manager.overview().login.status === 'complete');
  const bId = manager.overview().login.accountId;
  await manager.select(bId); await manager.refresh(bId);
  assert.equal(manager.active().id, bId);
  assert.equal(manager.overview().accounts.length, 2);
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(saved.activeAccountId, bId);
  assert.deepEqual(saved.profiles.map(profile => profile.id).sort(), [a.profile.id, bId].sort());
  await manager.select(a.profile.id);
  assert.equal(manager.overview().quota.buckets[0].used, '77');
});

test('personal quota preserves percentages and never infers AI Credits from a bucket name', () => {
  const input = quota();
  input.snapshots = ['chat', 'completions', 'premium_interactions', 'ai_credits', 'ai-credits', 'premium_requests'].map(type => ({ ...input.snapshots[0], type, unit: null, remainingPercentage: '12.345' }));
  const result = personalQuota('synthetic-account', input);
  assert.equal(result.scope, 'signed-in-user');
  for (const bucket of result.buckets) {
    assert.equal(bucket.unit, 'unspecified');
    assert.equal(bucket.remainingPercentage, '12.345');
    assert.equal(bucket.usedPercentage, '87.655');
  }
  assert.deepEqual(result.buckets.map(bucket => bucket.label), ['聊天', '代码补全', '高级请求', '其他额度 · ai_credits', '其他额度 · ai-credits', '其他额度 · premium_requests']);
  assert.ok(!JSON.stringify(result).includes('selectionId'));
});

test('personal quota keeps explicit units, exact amounts, zero, unlimited and missing percentages distinct', () => {
  const template = quota().snapshots[0];
  const result = personalQuota('synthetic-account', quota('25', { snapshots: [
    { ...template, unit: 'ai-credits', billingMode: 'ai-credits', usedRequests: '9007199254740993.123456789', entitlementRequests: '18014398509481986.246913578', remainingPercentage: NaN },
    { ...template, unit: 'premium-requests', billingMode: 'premium-requests', usedRequests: '0', entitlementRequests: '0', remainingPercentage: NaN },
    { ...template, usedRequests: '25', entitlementRequests: '-1', isUnlimitedEntitlement: true, remainingPercentage: '0' },
    { ...template, usedRequests: '25', entitlementRequests: '100', remainingPercentage: '200' },
  ] }));
  assert.equal(result.buckets[0].unit, 'ai-credits');
  assert.equal(result.buckets[0].label, '聊天', 'The quota category is independent of its explicitly returned unit.');
  assert.equal(result.buckets[0].used, '9007199254740993.123456789');
  assert.equal(result.buckets[0].usedPercentage, '50');
  assert.equal(result.buckets[1].unit, 'premium-requests');
  assert.equal(result.buckets[1].used, '0');
  assert.equal(result.buckets[1].usedPercentage, null);
  assert.equal(result.buckets[2].used, '25');
  assert.equal(result.buckets[2].limit, null);
  assert.equal(result.buckets[2].remainingPercentage, null);
  assert.equal(result.buckets[2].usedPercentage, null);
  assert.equal(result.buckets[3].remainingPercentage, null);
  assert.equal(result.buckets[3].usedPercentage, '25');
  const unavailable = personalQuota('synthetic-account', quota('0', { snapshots: [] }));
  assert.equal(unavailable.state, 'unavailable');
  assert.deepEqual(unavailable.buckets, []);
  assert.equal(unavailable.error.code, 'QUOTA_EMPTY');
});

test('derived personal quota percentages preserve finite decimals and leave repeating ratios unrounded', () => {
  const template = quota().snapshots[0];
  const examples = [
    ['62000', '2000000', '3.1'], ['1', '128', '0.78125'],
    ['0.00000000000000000001', '100', '0.00000000000000000001'],
    ['99.99999999999999999999', '100', '99.99999999999999999999'],
    ['1', '3', null], ['0', '0', null],
  ];
  const result = personalQuota('synthetic-account', quota('25', { snapshots: examples.map(([used, limit]) => ({
    ...template, usedRequests: used, entitlementRequests: limit, remainingPercentage: null,
  })) }));
  for (const [index, [used, limit, percentage]] of examples.entries()) {
    assert.equal(result.buckets[index].used, used); assert.equal(result.buckets[index].limit, limit);
    assert.equal(result.buckets[index].usedPercentage, percentage);
  }
  const supplied = personalQuota('synthetic-account', quota('25', { snapshots: [{
    ...template, usedRequests: '1', entitlementRequests: '3', remainingPercentage: '66.66666666666666666666',
  }] }));
  assert.equal(supplied.buckets[0].usedPercentage, '33.33333333333333333334');
});

test('personal percentages accept bounded exact strings and cannot reintroduce floating-point rounding', () => {
  const template = { ...quota().snapshots[0], usedRequests: null, entitlementRequests: null };
  const examples = [
    ['99.999999999999999999', '99.999999999999999999', '0.000000000000000001'],
    ['0.000000000000000001', '0.000000000000000001', '99.999999999999999999'],
    ['100.000000000000000001', null, null], ['-0.000000000000000001', null, null],
    ['1e-256', null, null], [99.999999999999999999, null, null], [42.5, null, null],
  ];
  for (const [input, remaining, used] of examples) {
    const result = personalQuota('synthetic-percentage-account', quota('25', { snapshots: [{ ...template, remainingPercentage: input }] })).buckets[0];
    assert.equal(result.remainingPercentage, remaining); assert.equal(result.usedPercentage, used);
  }
});
