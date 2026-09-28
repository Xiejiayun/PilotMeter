import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { ensureService, instanceAt, request } from '../../dist/daemon/client.js';

test('background service: concurrent start, authentication, isolation, restart, graceful stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilotmeter-daemon-'));
  let instance;
  try {
    const [a, b] = await Promise.all([ensureService(dir), ensureService(dir)]);
    assert.equal(a.instanceId, b.instanceId); instance = a;
    assert.equal((await request(a, '/api/summary')).local.nanoAiu, null);
    assert.equal((await fetch(`${a.url}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"monthlyBudget":"50"}' })).status, 403);
    assert.equal((await fetch(`${a.url}/api/summary`, { headers: { origin: 'https://attacker.example' } })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => { const req = httpRequest(`${a.url}/health`, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(`${a.url}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const headers = { 'content-type': 'application/json', 'x-pilotmeter-token': a.collectorToken };
    assert.equal((await fetch(`${a.url}/v1/traces`, { method: 'POST', headers, body: '{bad' })).status, 400);
    assert.equal((await fetch(`${a.url}/v1/traces`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-protobuf' }, body: 'abc' })).status, 415);
    assert.equal((await fetch(`${a.url}/v1/metrics`, { method: 'POST', headers, body: '{"resourceMetrics":[]}' })).status, 200);
    const session = await (await fetch(`${a.url}/api/session`)).json();
    const browserHeaders = { origin: a.url, 'content-type': 'application/json', 'x-pilotmeter-csrf': session.csrfToken };
    assert.equal((await fetch(`${a.url}/api/settings`, { method: 'PATCH', headers: browserHeaders, body: '{"monthlyBudget":"0"}' })).status, 200);
    assert.equal((await fetch(`${a.url}/api/shutdown`, { method: 'POST', headers: browserHeaders })).status, 403);
    assert.equal((await fetch(`${a.url}/api/settings`, { method: 'PATCH', headers: browserHeaders, body: '{"account":{"login":"injected"}}' })).status, 400);
    await assert.rejects(request(a, '/api/account', 'POST', { account: { kind: 'user', login: 'company-member' } }), /personal direct billing/);
    await request(a, '/api/account', 'POST', { account: { kind: 'organization', login: 'test-org' } });
    const missingCredential = await request(a, '/api/refresh', 'POST');
    assert.equal(missingCredential.state, 'unknown');
    assert.equal((await request(a, '/api/summary')).display.mode, 'usage');
    await request(a, '/api/account', 'POST', { account: { kind: 'enterprise', login: 'another-company' } });
    assert.equal((await request(a, '/api/summary')).account, null);
    await request(a, '/api/account', 'POST', { account: null });
    await assert.rejects(request(a, '/api/unit-verification', 'POST', { cliVersion: 'unverified', evidence: 'Made-up evidence' }), /supported CLI version/);
    const persisted = await readFile(join(dir, 'status.json'), 'utf8');
    assert.ok(!persisted.includes(a.managementToken)); assert.ok(!persisted.includes(a.collectorToken));
    await request(a, '/api/shutdown', 'POST');
    for (let i = 0; i < 40 && await instanceAt(dir); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 100));
    const restarted = await ensureService(dir); instance = restarted;
    assert.notEqual(restarted.instanceId, a.instanceId);
    assert.equal((await request(restarted, '/api/settings')).monthlyBudget, '0');
  } finally {
    if (instance && await instanceAt(dir)) await request(instance, '/api/shutdown', 'POST');
    await new Promise(r => setTimeout(r, 200));
    await rm(dir, { recursive: true, force: true });
  }
});
