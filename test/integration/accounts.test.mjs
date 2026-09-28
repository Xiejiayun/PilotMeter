import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ensureService, instanceAt, request } from '../../dist/daemon/client.js';
import { serve } from '../../dist/daemon/server.js';
import { month } from '../../dist/shared/runtime.js';
import { envelope, nanos, span } from '../fixtures/synthetic-otlp.mjs';

async function service(t, demo = false, accounts) {
  const directory = await mkdtemp(join(tmpdir(), 'pilotmeter-accounts-api-'));
  t.after(async () => {
    const running = await instanceAt(directory);
    if (running) await request(running, '/api/shutdown', 'POST');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(join(directory, 'writer.lock')); await delay(25); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  if (accounts) await serve(directory, demo, { accounts });
  const instance = accounts ? await instanceAt(directory) : await ensureService(directory, demo);
  const response = await fetch(`${instance.url}/api/session`);
  const { csrfToken } = await response.json();
  return { directory, instance, browser: { origin: instance.url, 'x-pilotmeter-csrf': csrfToken }, management: { authorization: `Bearer ${instance.managementToken}` } };
}

async function api(instance, route, { method = 'GET', headers = {}, body, raw } = {}) {
  const response = await fetch(`${instance.url}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { ...(body === undefined && raw === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

test('empty account API keeps legacy collection and budget behavior without fabricating a signed-in user', async t => {
  const { instance, directory, browser, management } = await service(t);
  const overview = await api(instance, '/api/auth/accounts');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.data.accounts, []);
  assert.equal(overview.data.activeAccountId, null);
  assert.equal(overview.data.quota, null);
  assert.equal(overview.data.login, null);
  assert.equal(overview.data.refreshing, false);
  assert.equal(overview.data.enabled, true);
  assert.match(overview.data.runCommand, /run --$/);
  await assert.rejects(access(join(directory, 'github-accounts')), { code: 'ENOENT' });
  assert.equal((await api(instance, '/api/auth/run-context', { method: 'POST', headers: management, body: {} })).data.profile, null);
  assert.equal((await api(instance, '/api/auth/refresh', { method: 'POST', headers: browser })).data.quota, null);
  assert.equal((await api(instance, '/api/auth/select', { method: 'POST', headers: browser, body: { accountId: null } })).status, 200);
  const budget = await api(instance, '/api/settings', { method: 'PATCH', headers: browser, body: { monthlyBudget: '125' } });
  assert.equal(budget.status, 200);
  assert.equal(budget.data.monthlyBudget, '125');
  const telemetry = envelope([span(1, { cost: '123', startTimeUnixNano: nanos(`${month()}-01T00:00:00.000Z`), endTimeUnixNano: nanos(`${month()}-01T00:00:01.000Z`) })]);
  assert.equal((await api(instance, '/v1/traces', { method: 'POST', headers: { 'x-pilotmeter-token': instance.collectorToken }, body: telemetry })).status, 200);
  const summary = (await api(instance, '/api/summary')).data;
  assert.equal(summary.githubAccount, null);
  assert.equal(summary.local.nanoAiu, '123');
  assert.equal(summary.account, null);
  const sessions = (await api(instance, '/api/sessions')).data;
  assert.equal(sessions.accountId, null);
  assert.equal(sessions.items.length, 1);
  assert.match(sessions.items[0].sourceContext, /^unverified:/);
  const detail = (await api(instance, `/api/sessions/${sessions.items[0].id}`)).data;
  assert.equal(detail.accountId, null);
  assert.equal(detail.lifetime.nanoAiu, '123');
});

test('account mutations require local CSRF or CLI authority and the launch context is CLI-only', async t => {
  const { instance, browser } = await service(t, false, fakeAccounts().options);
  const unknown = randomUUID();
  const mutations = [
    ['/api/auth/login', 'POST', {}], ['/api/auth/select', 'POST', { accountId: null }],
    ['/api/auth/refresh', 'POST'], [`/api/auth/login/${unknown}/cancel`, 'POST'], [`/api/auth/accounts/${unknown}`, 'DELETE'],
    ['/api/auth/run-context', 'POST', {}],
  ];
  for (const [route, method, body] of mutations) {
    for (const headers of [{}, { origin: instance.url }, { 'x-pilotmeter-csrf': browser['x-pilotmeter-csrf'] },
      { ...browser, 'x-pilotmeter-csrf': 'wrong' }, { authorization: `Bearer ${instance.collectorToken}` },
      { ...browser, origin: 'https://attacker.example' }]) {
      assert.equal((await api(instance, route, { method, headers, body })).status, 403, route);
    }
  }
  assert.equal((await api(instance, '/api/auth/run-context', { method: 'POST', headers: browser, body: {} })).status, 403);
  assert.equal((await api(instance, '/api/auth/refresh', { method: 'POST', headers: browser })).status, 200);
  for (const headers of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await api(instance, '/api/auth/accounts', { headers })).status, 403);
  }
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${instance.url}/api/auth/accounts`, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
  assert.deepEqual((await api(instance, '/api/auth/accounts')).data.accounts, []);
});

test('account API validates login hosts and unknown profiles before starting any provider operation', async t => {
  const fake = fakeAccounts(); const { instance, browser, management } = await service(t, false, fake.options);
  for (const body of [null, [], [{}], 'invalid', 123, { host: 123 }, { accountId: 123 }]) {
    assert.equal((await api(instance, '/api/auth/login', { method: 'POST', headers: browser, body })).status, 400);
  }
  for (const loginHost of ['http://github.com', 'https://github.com.evil.test', 'https://github.com/login/device', 'https://user:secret@github.com', 'https://127.0.0.1']) {
    const result = await api(instance, '/api/auth/login', { method: 'POST', headers: browser, body: { host: loginHost } });
    assert.equal(result.status, 400, loginHost);
    assert.ok(!JSON.stringify(result.data).includes('secret'));
  }
  const unknown = randomUUID();
  for (const [route, body, expected] of [
    ['/api/auth/login', { accountId: 'invalid-id' }, 400], ['/api/auth/login', { accountId: unknown }, 404],
    ['/api/auth/select', { accountId: 'invalid-id' }, 400], ['/api/auth/select', { accountId: unknown }, 404],
    ['/api/auth/select', {}, 400], ['/api/auth/select', [], 400],
    ['/api/auth/run-context', [], 400], ['/api/auth/run-context', 'invalid', 400],
    ['/api/auth/run-context', { accountId: unknown }, 404], ['/api/auth/run-context', { sourceLabel: 'x'.repeat(201) }, 400],
  ]) {
    assert.equal((await api(instance, route, { method: 'POST', headers: management, body })).status, expected, route);
  }
  assert.equal((await api(instance, `/api/auth/accounts/${unknown}`, { method: 'DELETE', headers: browser })).status, 404);
  assert.equal((await api(instance, `/api/auth/login/${unknown}`)).status, 404);
  assert.equal((await api(instance, `/api/auth/login/${unknown}/cancel`, { method: 'POST', headers: browser })).status, 404);
  assert.equal((await api(instance, '/api/auth/login', { method: 'POST', headers: browser, raw: '{bad' })).status, 400);
  assert.equal((await api(instance, '/api/auth/login', { method: 'POST', headers: { ...browser, 'content-type': 'text/plain' }, raw: '{}' })).status, 415);
  assert.equal((await api(instance, '/api/auth/accounts')).data.login, null);
  assert.equal(fake.clients.length, 0);
});

test('demo exposes disabled account state and rejects every real account operation', async t => {
  const { instance, browser, management, directory } = await service(t, true, fakeAccounts().options);
  const before = (await api(instance, '/api/summary')).data;
  const overview = await api(instance, '/api/auth/accounts');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.enabled, false);
  assert.deepEqual(overview.data.accounts, []);
  assert.equal(overview.data.quota, null);
  const unknown = randomUUID();
  for (const [route, method, body] of [
    ['/api/auth/login', 'POST', {}], ['/api/auth/select', 'POST', { accountId: null }], ['/api/auth/refresh', 'POST'],
    [`/api/auth/login/${unknown}`, 'GET'], [`/api/auth/login/${unknown}/cancel`, 'POST'], [`/api/auth/accounts/${unknown}`, 'DELETE'],
    ['/api/auth/run-context', 'POST', {}],
  ]) assert.equal((await api(instance, route, { method, headers: route.endsWith('/run-context') ? management : browser, body })).status, 409, route);
  assert.deepEqual((await api(instance, '/api/summary')).data.local, before.local);
  await assert.rejects(access(join(directory, 'github-accounts')), { code: 'ENOENT' });
});

test('browser account responses and status cache omit capabilities and reject stale profile query IDs', async t => {
  const { instance, directory } = await service(t);
  for (const route of ['/api/auth/accounts', '/api/summary', '/api/sessions', '/api/settings', '/api/desktop', '/api/desktop/records', '/api/widget']) {
    const result = await api(instance, route);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    const text = JSON.stringify(result.data);
    for (const secret of [instance.managementToken, instance.collectorToken, 'selectionId', 'homeId', 'collectorToken', 'managementToken']) assert.ok(!text.includes(secret), `${route}: ${secret}`);
  }
  const snapshot = await readFile(join(directory, 'status.json'), 'utf8');
  assert.ok(!snapshot.includes(instance.managementToken));
  assert.ok(!snapshot.includes(instance.collectorToken));
  const unknown = randomUUID();
  for (const route of ['/api/summary', '/api/sessions', '/api/sessions/missing', '/api/settings', '/api/desktop', '/api/desktop/records', '/api/widget']) {
    assert.equal((await api(instance, `${route}?accountId=${unknown}`)).status, 409, route);
  }
  assert.equal((await api(instance, '/api/summary?accountId=')).status, 200);
});

function fakeAccounts() {
  const fixture = { clients: [], plans: [] };
  fixture.options = { clientFactory: home => {
    const plan = fixture.plans.shift();
    assert.ok(plan, 'Every synthetic provider operation must have an explicit account fixture');
    const client = {
      home, state: null, closed: false,
      async startLogin(host) {
        this.state = { id: randomUUID(), status: 'pending', host, verificationUri: `${host}/login/device`, userCode: 'TEST-CODE',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), error: null };
        return { ...this.state };
      },
      getLogin(id) { return this.state?.id === id ? { ...this.state } : null; },
      cancelLogin(id) { if (this.state?.id === id) this.state = { ...this.state, status: 'cancelled', userCode: null, verificationUri: null }; return this.getLogin(id); },
      async listAccounts() { return [{ selectionId: `private-selection-${plan.login}`, login: plan.login, host: 'https://github.com', isCurrent: true, authType: 'user' }]; },
      async getQuota(selectionId) {
        assert.equal(selectionId, `private-selection-${plan.login}`);
        return { selectionId, scope: 'user', fetchedAt: new Date().toISOString(), snapshots: [{ type: 'chat', unit: null, billingMode: 'unknown',
          usedRequests: plan.used, entitlementRequests: '100', remainingPercentage: 100 - Number(plan.used), overage: '0', isUnlimitedEntitlement: false,
          usageAllowedWithExhaustedQuota: false, overageAllowedWithExhaustedQuota: false, resetDate: null }] };
      },
      async listModels(selectionId) {
        assert.equal(selectionId, `private-selection-${plan.login}`);
        return { selectionId, fetchedAt: new Date().toISOString(), items: [{ id: `${plan.login}-model`, name: 'Synthetic Model',
          status: 'available', reason: 'Synthetic policy enabled', policyState: 'enabled', vision: true, reasoningEffort: false,
          contextWindowTokens: 128000, multiplier: '1', token: 'synthetic-private-token' }] };
      },
      async close() { this.closed = true; },
    };
    fixture.clients.push(client); return client;
  } };
  return fixture;
}

async function signedIn(state, fake, login, used) {
  fake.plans.push({ login, used });
  const started = await api(state.instance, '/api/auth/login', { method: 'POST', headers: state.browser, body: {} });
  assert.equal(started.status, 200);
  assert.equal(started.data.status, 'pending');
  const client = fake.clients.at(-1);
  client.state = { ...client.state, status: 'complete', userCode: null, verificationUri: null };
  const verifying = await api(state.instance, `/api/auth/login/${started.data.id}`);
  assert.equal(verifying.status, 200);
  const end = Date.now() + 4000;
  let overview;
  do {
    overview = (await api(state.instance, '/api/auth/accounts')).data;
    if (overview.login.status === 'complete' && overview.quota && !overview.refreshing) break;
    if (Date.now() >= end) assert.fail('Synthetic HTTP login did not settle');
    await delay(5);
  } while (true);
  assert.equal(overview.accounts.find(item => item.id === overview.activeAccountId).login, login);
  assert.equal(overview.quota.buckets[0].used, used);
  assert.equal(overview.quota.buckets[0].unit, 'unspecified');
  return { id: overview.activeAccountId, client };
}

async function collect(instance, token, number, cost) {
  const telemetry = envelope([span(number, { cost, session: 'same-synthetic-session', startTimeUnixNano: nanos(`${month()}-01T00:00:00.000Z`), endTimeUnixNano: nanos(`${month()}-01T00:00:01.000Z`) })]);
  assert.equal((await api(instance, '/v1/traces', { method: 'POST', headers: { 'x-pilotmeter-token': token }, body: telemetry })).status, 200);
}

test('two authenticated HTTP profiles isolate live collectors, sessions, personal quotas and budgets', async t => {
  const fake = fakeAccounts(); const state = await service(t, false, fake.options);
  const { instance, browser, management } = state;
  const a = await signedIn(state, fake, 'SyntheticAlice', '25');
  const aContext = await api(instance, '/api/auth/run-context', { method: 'POST', headers: management, body: { sourceLabel: 'shared-label' } });
  assert.equal(aContext.status, 200);
  assert.equal(aContext.data.profile.id, a.id);
  assert.equal(aContext.data.home, a.client.home);
  await collect(instance, aContext.data.collectorToken, 1, '10');
  const aSession = (await api(instance, '/api/sessions')).data.items[0];
  assert.match(aSession.sourceContext, new RegExp(`^profile:${a.id}:`));
  assert.equal((await api(instance, `/api/settings?accountId=${a.id}`, { method: 'PATCH', headers: browser, body: { monthlyBudget: '100' } })).status, 200);
  const b = await signedIn(state, fake, 'SyntheticBob', '50');
  const bContext = await api(instance, '/api/auth/run-context', { method: 'POST', headers: management, body: { sourceLabel: 'shared-label' } });
  assert.equal(bContext.data.profile.id, b.id);
  assert.notEqual(aContext.data.home, bContext.data.home);
  assert.notEqual(aContext.data.collectorToken, bContext.data.collectorToken);
  await collect(instance, bContext.data.collectorToken, 2, '20');
  await collect(instance, aContext.data.collectorToken, 3, '7');
  await collect(instance, instance.collectorToken, 4, '900');
  const bSummary = (await api(instance, `/api/summary?accountId=${b.id}`)).data;
  assert.equal(bSummary.githubAccount.id, b.id);
  assert.equal(bSummary.local.nanoAiu, '20');
  assert.equal(bSummary.account, null, 'personal quota is not inserted into organization billing evidence');
  const bDesktop = (await api(instance, `/api/desktop?accountId=${b.id}`)).data;
  assert.equal(bDesktop.activeAccountId, b.id); assert.equal(bDesktop.models.accountId, b.id);
  assert.equal(bDesktop.models.items[0].id, 'SyntheticBob-model'); assert.equal(bDesktop.local.accountId, b.id);
  assert.equal(bDesktop.local.nanoAiu, '20'); assert.equal(bDesktop.local.source, 'local-otel');
  assert.equal(bDesktop.presentation.primary.unit, 'unspecified'); assert.equal(bDesktop.presentation.primary.used, null);
  assert.equal(bDesktop.presentation.primary.remaining, null); assert.equal(bDesktop.presentation.primary.raw.used, '50');
  const bRecords = (await api(instance, `/api/desktop/records?accountId=${b.id}&sort=usage`)).data;
  assert.equal(bRecords.accountId, b.id); assert.equal(bRecords.items.length, 1); assert.equal(bRecords.items[0].nanoAiu, '20');
  assert.equal(bRecords.items[0].credits, null); assert.equal(bRecords.items[0].unitVerified, false);
  assert.equal(bRecords.coverage, 'partial'); assert.equal(bRecords.source, 'local-otel');
  assert.doesNotMatch(JSON.stringify([bDesktop, bRecords]), /synthetic-private|private-selection|sourceContext|events/);
  assert.doesNotMatch(JSON.stringify(bRecords), /inputTokens|outputTokens/);
  const bWidget = (await api(instance, `/api/widget?accountId=${b.id}&quotaKey=chat`)).data;
  assert.equal(bWidget.accountId, b.id); assert.equal(bWidget.accountLogin, 'SyntheticBob'); assert.equal(bWidget.value, '剩余 50%');
  for (const route of ['/api/desktop', '/api/desktop/records', '/api/widget'])
    assert.equal((await api(instance, `${route}?accountId=${a.id}&quotaKey=chat`)).status, 409);
  assert.equal((await api(instance, `/api/auth/refresh?accountId=${a.id}`, { method: 'POST', headers: browser })).status, 409);
  const bSessions = (await api(instance, '/api/sessions')).data;
  assert.equal(bSessions.accountId, b.id);
  assert.equal(bSessions.items.length, 1);
  assert.match(bSessions.items[0].sourceContext, new RegExp(`^profile:${b.id}:`));
  assert.equal((await api(instance, `/api/sessions/${aSession.id}`)).status, 404);
  assert.equal((await api(instance, `/api/summary?accountId=${a.id}`)).status, 409);
  assert.equal((await api(instance, `/api/settings?accountId=${b.id}`, { method: 'PATCH', headers: browser, body: { monthlyBudget: '200' } })).status, 200);
  assert.equal((await api(instance, '/api/settings')).data.monthlyBudget, '200');
  assert.equal((await api(instance, '/api/auth/select', { method: 'POST', headers: browser, body: { accountId: a.id } })).status, 200);
  assert.equal((await api(instance, '/api/summary')).data.local.nanoAiu, '17', 'the old Alice collector remains bound after switching to Bob');
  const aDesktop = (await api(instance, `/api/desktop?accountId=${a.id}`)).data;
  assert.equal(aDesktop.models.items[0].id, 'SyntheticAlice-model'); assert.equal(aDesktop.local.nanoAiu, '17');
  assert.equal((await api(instance, `/api/desktop/records?accountId=${a.id}`)).data.items[0].nanoAiu, '17');
  assert.equal((await api(instance, '/api/settings')).data.monthlyBudget, '100');
  assert.equal((await api(instance, `/api/sessions/${aSession.id}`)).data.lifetime.nanoAiu, '17');
  const overview = (await api(instance, '/api/auth/accounts')).data;
  assert.equal(overview.quota.accountId, a.id);
  assert.equal(overview.quota.buckets[0].used, '25');
  const publicText = JSON.stringify(overview);
  for (const privateValue of [aContext.data.collectorToken, bContext.data.collectorToken, a.client.home, b.client.home, 'selectionId', 'private-selection']) assert.ok(!publicText.includes(privateValue));
  assert.equal((await api(instance, '/api/auth/run-context', { method: 'POST', headers: browser, body: { accountId: a.id } })).status, 403);
  assert.equal((await api(instance, '/api/auth/select', { method: 'POST', headers: browser, body: { accountId: null } })).status, 200);
  const global = (await api(instance, '/api/summary')).data;
  assert.equal(global.githubAccount, null);
  assert.equal(global.local.nanoAiu, '937');
  assert.equal((await api(instance, '/api/settings')).data.monthlyBudget, null);
  assert.equal((await api(instance, '/api/auth/accounts')).data.quota, null);
});

test('a budget request started under one profile cannot land on the account selected during its body upload', async t => {
  const fake = fakeAccounts(); const state = await service(t, false, fake.options);
  const { instance, browser } = state;
  const a = await signedIn(state, fake, 'SyntheticAlice', '25');
  const b = await signedIn(state, fake, 'SyntheticBob', '50');
  await api(instance, '/api/auth/select', { method: 'POST', headers: browser, body: { accountId: a.id } });
  const payload = JSON.stringify({ monthlyBudget: '999' });
  let upload;
  const response = new Promise((resolve, reject) => {
    upload = httpRequest(`${instance.url}/api/settings?accountId=${a.id}`, { method: 'PATCH', headers: {
      ...browser, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
    } }, incoming => { const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => resolve({ status: incoming.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
    upload.on('error', reject); upload.write(payload.slice(0, 1));
  });
  // Ensure the local server has received the request headers and captured its initial profile.
  await new Promise(resolve => upload.once('socket', socket => socket.once('connect', resolve)));
  await delay(15);
  await api(instance, '/api/auth/select', { method: 'POST', headers: browser, body: { accountId: b.id } });
  upload.end(payload.slice(1));
  assert.equal((await response).status, 409);
  assert.equal((await api(instance, '/api/settings')).data.monthlyBudget, null);
  await api(instance, '/api/auth/select', { method: 'POST', headers: browser, body: { accountId: a.id } });
  assert.equal((await api(instance, '/api/settings')).data.monthlyBudget, null);
});
