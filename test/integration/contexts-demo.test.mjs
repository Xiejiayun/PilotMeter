import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { cachedStatus } from '../../dist/cli/terminal.js';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { ensureService, instanceAt, request } from '../../dist/daemon/client.js';
import { serve } from '../../dist/daemon/server.js';
import { month, sourceContextId } from '../../dist/shared/runtime.js';
import { Repository } from '../../dist/storage/repository.js';
import { envelope, nanos, span } from '../fixtures/synthetic-otlp.mjs';

const execute = promisify(execFile);
const bin = resolve('bin/pilotmeter.js');
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));

function currentSpan(id, cost = '1') {
  return span(id, { session: 'synthetic-shared-session-id', cost,
    startTimeUnixNano: nanos(`${month()}-01T00:00:00.000Z`),
    endTimeUnixNano: nanos(`${month()}-01T00:00:01.000Z`) });
}

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'pilotmeter-context-demo-'));
  const state = join(root, 'state');
  t.after(async () => {
    const instance = await instanceAt(state);
    if (instance) await request(instance, '/api/shutdown', 'POST');
    // A closed listener can precede releasing SQLite and the writer lock by a few milliseconds.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(join(state, 'writer.lock')); await pause(25); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, state };
}

function homeContext(home, label = '') {
  const previous = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try { return sourceContextId(label); }
  finally { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; }
}

async function trace(instance, collectorToken, spans) {
  return fetch(`${instance.url}/v1/traces`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pilotmeter-token': collectorToken },
    body: JSON.stringify(envelope(spans)), signal: AbortSignal.timeout(5000) });
}

async function mutation(instance, route, input) {
  const response = await fetch(`${instance.url}${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.managementToken}` },
    body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
  await response.json();
  return response.status;
}

test('source contexts resolve relative homes against cwd and distinguish explicit account labels', async t => {
  const { root } = await temporary(t);
  const a = join(root, 'project-a'); const b = join(root, 'project-b');
  await mkdir(join(a, '.copilot-profile'), { recursive: true });
  await mkdir(join(b, '.copilot-profile'), { recursive: true });
  const originalDirectory = process.cwd();
  const originalHome = process.env.COPILOT_HOME;
  try {
    process.env.COPILOT_HOME = '.copilot-profile';
    process.chdir(a); const first = sourceContextId();
    process.chdir(b); const second = sourceContextId();
    assert.notEqual(first, second, 'different actual configuration homes must not share an identity');
    process.env.COPILOT_HOME = join(a, '.copilot-profile');
    assert.equal(sourceContextId(), first, 'relative and absolute references to the same home must agree');
    assert.notEqual(sourceContextId('another-account'), first);
    if (process.platform === 'win32') {
      process.env.COPILOT_HOME = join(a, '.copilot-profile').toUpperCase();
      assert.equal(sourceContextId(), first, 'Windows path casing must not split a context');
    }
  } finally {
    process.chdir(originalDirectory);
    if (originalHome === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = originalHome;
  }
});

test('one daemon preserves per-home sessions across account binding, token-based import and CLI import', async t => {
  const { root, state } = await temporary(t);
  const instance = await ensureService(state);
  const homeA = join(root, 'home-a'); const homeB = join(root, 'home-b');
  await mkdir(homeA); await mkdir(homeB);
  const idA = homeContext(homeA); const idB = homeContext(homeB, 'synthetic-profile');
  const a = await request(instance, '/api/collector-context', 'POST', { contextId: idA });
  const b = await request(instance, '/api/collector-context', 'POST', { contextId: idB });
  assert.notEqual(a.collectorToken, b.collectorToken);
  assert.equal(a.identity, 'unverified'); assert.equal(b.identity, 'unverified');
  let response = await trace(instance, a.collectorToken, [currentSpan(1, '1')]);
  assert.equal(response.status, 200); await response.json();
  response = await trace(instance, b.collectorToken, [currentSpan(2, '2')]);
  assert.equal(response.status, 200); await response.json();
  let sessions = (await request(instance, `/api/sessions?period=${month()}`)).items;
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(item => item.sessionId === 'synthetic-shared-session-id'));
  assert.deepEqual(new Set(sessions.map(item => item.sourceContext)), new Set([`unverified:${idA}`, `unverified:${idB}`]));

  await request(instance, '/api/account', 'POST', { account: { kind: 'organization', login: 'synthetic-billing-org' } });
  const registeredAgain = await request(instance, '/api/collector-context', 'POST', { contextId: idA });
  assert.equal(registeredAgain.collectorToken, a.collectorToken, 'billing selection must not relabel a collection identity');
  response = await trace(instance, a.collectorToken, [currentSpan(3, '4')]);
  assert.equal(response.status, 200); await response.json();

  const apiFile = join(root, 'synthetic-context-a.jsonl');
  await writeFile(apiFile, `${JSON.stringify(envelope([currentSpan(1, '1'), currentSpan(4, '8')]))}\n`);
  const imported = await request(instance, '/api/import', 'POST', { path: apiFile, collectorToken: a.collectorToken });
  assert.equal(imported.accepted, 1); assert.equal(imported.duplicates, 1);
  await assert.rejects(request(instance, '/api/import', 'POST', { path: apiFile, collectorToken: 'unregistered-token' }), /Unknown import source context/);

  const cliFile = join(root, 'synthetic-context-b.jsonl');
  await writeFile(cliFile, `${JSON.stringify(envelope([currentSpan(5, '16')]))}\n`);
  const cli = await execute(process.execPath, [bin, '--data-dir', state, 'import', cliFile, '--source-label', 'synthetic-profile'], {
    env: { ...process.env, COPILOT_HOME: homeB }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(JSON.parse(cli.stdout).accepted, 1);
  sessions = (await request(instance, `/api/sessions?period=${month()}`)).items;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find(item => item.sourceContext === `unverified:${idA}`).nanoAiu, '13');
  assert.equal(sessions.find(item => item.sourceContext === `unverified:${idB}`).nanoAiu, '18');
  assert.equal((await request(instance, '/api/summary')).local.nanoAiu, '31');
  await request(instance, '/api/account', 'POST', { account: null });
});

test('demo startup rejects an existing real ledger without changing data and releases its lock', { timeout: 5000 }, async t => {
  const { state } = await temporary(t);
  const database = join(state, 'usage.db');
  let repository = new Repository(database);
  repository.ingest(parseOtlp(envelope([currentSpan(1, '2')]), 'synthetic-real-mode-fixture'));
  const before = repository.summary(month());
  repository.close();
  await assert.rejects(serve(state, true), /refusing to modify real data/);
  repository = new Repository(database);
  try {
    assert.deepEqual(repository.summary(month()), before);
    assert.equal(repository.getSetting('settings'), null, 'synthetic unit verification must never be applied to existing events');
    assert.equal(repository.getSetting('demo-period'), null);
  } finally { repository.close(); }
  await assert.rejects(access(join(state, 'writer.lock')), { code: 'ENOENT' });
  const instance = await ensureService(state);
  assert.equal((await request(instance, '/api/summary')).local.nanoAiu, '2');
});

test('a running real service cannot be silently reused as a demo', async t => {
  const { state } = await temporary(t);
  const instance = await ensureService(state);
  await assert.rejects(ensureService(state, true), /separate unused directory/);
  assert.equal((await instanceAt(state)).instanceId, instance.instanceId);
  assert.equal((await request(instance, '/api/summary')).demo, false);
});

test('demo rejects real traces, context registration, imports and account binding', async t => {
  const { state, root } = await temporary(t);
  const instance = await ensureService(state, true);
  const before = await request(instance, '/api/summary');
  assert.equal(before.demo, true); assert.equal(instance.demo, true);
  const response = await trace(instance, instance.collectorToken, [currentSpan(100, '999')]);
  assert.equal(response.status, 409); await response.json();
  assert.equal(await mutation(instance, '/api/collector-context', { contextId: 'a'.repeat(64) }), 409);
  assert.equal(await mutation(instance, '/api/import', { path: join(root, 'does-not-exist.jsonl') }), 409);
  assert.equal(await mutation(instance, '/api/account', { account: { kind: 'organization', login: 'synthetic-org' } }), 409);
  const after = await request(instance, '/api/summary');
  assert.deepEqual(after.local, before.local);
  assert.equal((await request(instance, '/api/settings')).account, null);
});

test('statusline never displays a previous UTC month amount as current usage', async t => {
  const { state } = await temporary(t);
  await mkdir(state);
  const previous = new Date(`${month()}-01T00:00:00.000Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const snapshot = {
    period: previous.toISOString().slice(0, 7), updatedAt: new Date().toISOString(), demo: false, account: null,
    local: { sessionCount: 1, unknownCalls: 0, pendingCalls: 0 },
    display: { percentage: '88.88', used: '87654321.987', unit: 'ai-credits', label: 'Synthetic cached amount', reason: null },
  };
  await writeFile(join(state, 'status.json'), JSON.stringify(snapshot));
  const staleMonth = await cachedStatus(state);
  assert.match(staleMonth, /不计为本月用量/);
  assert.ok(!staleMonth.includes('88.88'));
  assert.ok(!staleMonth.includes('87654321.987'));
  await writeFile(join(state, 'status.json'), JSON.stringify({ ...snapshot, period: month() }));
  assert.match(await cachedStatus(state), /88\.88%/);
});

test('a failed status cache write does not poison later updates or duplicate committed usage', async t => {
  const { state } = await temporary(t);
  const instance = await ensureService(state);
  const cache = join(state, 'status.json');
  await rm(cache);
  await mkdir(cache);
  let response = await trace(instance, instance.collectorToken, [currentSpan(1, '7')]);
  assert.equal(response.status, 500); await response.json();
  assert.equal((await request(instance, '/api/summary')).local.nanoAiu, '7', 'ledger commit must survive a separate cache-write failure');
  await rm(cache, { recursive: true });
  response = await trace(instance, instance.collectorToken, [currentSpan(1, '7')]);
  assert.equal(response.status, 200); await response.json();
  const recovered = JSON.parse(await readFile(cache, 'utf8'));
  assert.equal(recovered.local.nanoAiu, '7');
  assert.equal(recovered.local.knownCalls, 1);
});
