import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '../../dist/daemon/server.js';
import { instanceAt, request } from '../../dist/daemon/client.js';

test('native desktop gets a bounded presentation and binds CSRF mutations to the expected daemon', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pilotmeter-native-api-'));
  let instance;
  t.after(async () => {
    if (instance) await request(instance, '/api/shutdown', 'POST');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(join(directory, 'writer.lock')); await delay(25); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await serve(directory, false, { accounts: { clientFactory: () => { throw new Error('A native read must not launch a provider.'); } } });
  instance = await instanceAt(directory);
  const read = await fetch(`${instance.url}/api/desktop`, { headers: { 'x-pilotmeter-instance': instance.instanceId } });
  const view = await read.json();
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(view.app, instance.app); assert.equal(view.version, instance.version); assert.equal(view.instanceId, instance.instanceId);
  assert.equal(view.presentation.primary, null); assert.deepEqual(view.presentation.buckets, []);
  assert.equal(view.models, null); assert.equal(view.local.accountId, null); assert.equal(view.local.source, 'local-otel');
  assert.equal(view.local.nanoAiu, null); assert.equal(view.local.coverage, 'empty');
  for (const privateValue of [instance.managementToken, instance.collectorToken, directory]) assert.equal(JSON.stringify(view).includes(privateValue), false);
  assert.equal('runCommand' in view, false);
  const records = await (await fetch(`${instance.url}/api/desktop/records?period=2026-09&sort=usage`)).json();
  assert.equal(records.app, instance.app); assert.equal(records.instanceId, instance.instanceId);
  assert.equal(records.source, 'local-otel'); assert.equal(records.period, '2026-09'); assert.equal(records.accountId, null);
  assert.deepEqual(records.items, []); assert.equal(records.nextCursor, null);
  assert.equal((await fetch(`${instance.url}/api/desktop/records?sort=invalid`)).status, 400);
  assert.equal((await fetch(`${instance.url}/api/desktop/records?accountId=stale`)).status, 409);
  assert.equal((await fetch(`${instance.url}/api/desktop/records`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${instance.url}/api/desktop/records`, { headers: { 'x-pilotmeter-instance': 'different-instance' } })).status, 409);
  await assert.rejects(access(join(directory, 'github-accounts')), { code: 'ENOENT' });
  for (const headers of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }])
    assert.equal((await fetch(`${instance.url}/api/desktop`, { headers })).status, 403);
  const { csrfToken } = await (await fetch(`${instance.url}/api/session`)).json();
  const headers = { origin: instance.url, 'x-pilotmeter-csrf': csrfToken, 'content-type': 'application/json' };
  // Even a valid current CSRF token cannot mutate a daemon other than the one
  // this native window originally verified (including a restart on the same port).
  const foreign = await fetch(`${instance.url}/api/auth/select`, { method: 'POST', headers: { ...headers, 'x-pilotmeter-instance': 'different-instance' }, body: '{"accountId":null}' });
  assert.equal(foreign.status, 409);
  const own = await fetch(`${instance.url}/api/auth/select`, { method: 'POST', headers: { ...headers, 'x-pilotmeter-instance': instance.instanceId }, body: '{"accountId":null}' });
  assert.equal(own.status, 200);
});
