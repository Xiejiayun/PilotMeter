import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ensureService, request } from '../../dist/daemon/client.js';
import { envelope, nanos, span } from '../fixtures/synthetic-otlp.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const period = '2025-01';
const cutoff = '2025-01-15T00:00:00.000Z';
const path = `/api/reconciliation?period=${period}`;
async function absent(file) {
  try { await access(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function stop(instance, directory) {
  await request(instance, '/api/shutdown', 'POST');
  for (let i = 0; i < 100; i++) {
    if (await absent(join(directory, 'instance.json')) && await absent(join(directory, 'writer.lock'))) return;
    await pause(100);
  }
  assert.fail('Owned daemon did not finish shutdown; its directory is retained');
}
function quota(used = '12') {
  return { period, raw: { usedRequests: used, entitlementRequests: '100', resetDate: '2025-02-01T00:00:00.000Z', isUnlimited: false },
    evidence: { billingEntity: 'organization:synthetic', usageSubject: 'organization:synthetic', poolId: 'synthetic-monthly',
      period, poolKind: 'monthly-account', billingMode: 'ai-credits', unit: 'ai-credits', products: ['Copilot AI Credits'],
      identityVerified: true, unitVerified: true, allowanceVerified: true, coverageVerified: true, officialPageCompared: true,
      allowance: '100', unlimited: false, verifiedAt: cutoff, providerUpdatedAt: cutoff,
      evidence: 'Synthetic test evidence; never a real account verification.' } };
}
async function deliver(instance, spans) {
  const response = await fetch(`${instance.url}/v1/traces`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pilotmeter-token': instance.collectorToken },
    body: JSON.stringify(envelope(spans)), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); return response.json();
}
async function verifiedFile(instance) {
  const { template } = await request(instance, `/api/reconciliation/inspect?period=${period}`);
  assert.ok(template);
  return { ...template, identityVerified: true, poolVerified: true, productsVerified: true, timeCoverageVerified: true,
    verifiedAt: new Date().toISOString(), evidence: 'Synthetic bounded fixture: all sources and coverage checked for this test only.' };
}

test('real CLI and daemon expose finite reconciliation without trusting client-supplied totals', async () => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'pilotmeter-reconciliation-api-'));
  const bin = resolve('bin/pilotmeter.js');
  let instance = await ensureService(directory);
  const cli = (...args) => execute(process.execPath, [bin, '--data-dir', directory, 'reconcile', ...args], { windowsHide: true, timeout: 15_000 });
  try {
    const unknown = JSON.parse((await cli('status', '--period', period, '--json')).stdout);
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.difference, null);
    assert.equal((await request(instance, `/api/summary?period=${period}`)).reconciliation.state, 'unknown');
    const csrf = await request(instance, '/api/session');
    for (const [method, route, payload] of [['GET', `/api/reconciliation/inspect?period=${period}`], ['POST', path, {}], ['DELETE', path]]) {
      const response = await fetch(`${instance.url}${route}`, { method,
        headers: { origin: instance.url, 'content-type': 'application/json', 'x-pilotmeter-csrf': csrf.csrfToken },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      assert.equal(response.status, 403); await response.arrayBuffer();
    }
    await request(instance, '/api/account', 'POST', { account: { kind: 'organization', login: 'synthetic' } });
    await request(instance, '/api/unit-verification', 'POST', { cliVersion: '1.0.88', evidence: 'Synthetic integration /usage verification fixture, not real evidence.' });
    const before = span(1, { traceId: '1'.repeat(32), cost: '10000000000', session: 'synthetic-local',
      startTimeUnixNano: nanos('2025-01-02T00:00:00.000Z'), endTimeUnixNano: nanos('2025-01-02T00:00:01.000Z') });
    const after = span(2, { traceId: '2'.repeat(32), cost: '99000000000', session: 'synthetic-after-cutoff',
      startTimeUnixNano: nanos('2025-01-20T00:00:00.000Z'), endTimeUnixNano: nanos('2025-01-20T00:00:01.000Z') });
    await deliver(instance, [before, after]);
    assert.equal((await request(instance, '/api/quota-import', 'POST', quota())).capability.supported, true);
    const evidenceFile = join(directory, 'review.json');
    await cli('inspect', '--period', period, '--output', evidenceFile);
    const template = JSON.parse(await readFile(evidenceFile, 'utf8'));
    assert.equal(template.identityVerified, false); assert.equal(template.timeCoverageVerified, false);
    assert.equal(template.verifiedAt, ''); assert.equal(template.coverageEnd, cutoff);
    await assert.rejects(cli('inspect', '--period', period, '--output', evidenceFile), /EEXIST/);
    await assert.rejects(cli('verify', evidenceFile));
    await writeFile(evidenceFile, JSON.stringify(await verifiedFile(instance)));
    let report = JSON.parse((await cli('verify', evidenceFile)).stdout);
    assert.equal(report.state, 'comparable'); assert.equal(report.localUsed, '10');
    assert.equal(report.accountUsed, '12'); assert.equal(report.difference, '2');
    assert.equal(report.label, '暂未归属'); assert.equal(report.cutoff, cutoff);
    assert.equal((await request(instance, `/api/summary?period=${period}`)).local.credits, '109');
    await assert.rejects(request(instance, '/api/reconciliation', 'POST', { ...JSON.parse(await readFile(evidenceFile, 'utf8')), used: '999' }));
    assert.equal((await request(instance, path)).state, 'comparable', 'rejected edits must preserve previously accepted evidence');
    await deliver(instance, [before, after]);
    assert.equal((await request(instance, path)).state, 'comparable', 'duplicate delivery must not invalidate unchanged metering');
    await stop(instance, directory); instance = null;
    instance = await ensureService(directory);
    assert.equal((await request(instance, path)).state, 'comparable', 'finite evidence and its exact ledger survive restart');
    await request(instance, '/api/quota-import', 'POST', quota('13'));
    report = await request(instance, path);
    assert.equal(report.state, 'unknown'); assert.equal(report.difference, null);
    await request(instance, '/api/reconciliation', 'POST', await verifiedFile(instance));
    assert.equal((await request(instance, path)).difference, '3');
    const late = span(3, { traceId: '3'.repeat(32), cost: '1000000000', session: 'synthetic-late',
      startTimeUnixNano: nanos('2025-01-04T00:00:00.000Z'), endTimeUnixNano: nanos('2025-01-04T00:00:01.000Z') });
    await deliver(instance, [late]);
    assert.equal((await request(instance, path)).state, 'unknown');
    await assert.rejects(cli('verify', evidenceFile), 'old evidence must not silently rebind to changed data');
    await request(instance, '/api/reconciliation', 'POST', await verifiedFile(instance));
    const wholeMonth = quota('115');
    wholeMonth.evidence.verifiedAt = new Date().toISOString();
    wholeMonth.evidence.providerUpdatedAt = '2025-02-01T00:00:00.000Z';
    assert.equal((await request(instance, '/api/quota-import', 'POST', wholeMonth)).capability.supported, true);
    report = await request(instance, '/api/reconciliation', 'POST', await verifiedFile(instance));
    assert.equal(report.cutoff, '2025-02-01T00:00:00.000Z');
    assert.equal(report.localUsed, '110'); assert.equal(report.difference, '5');
    await request(instance, '/api/account', 'POST', { account: { kind: 'organization', login: 'different' } });
    assert.equal((await request(instance, path)).state, 'unknown');
    await cli('clear', '--period', period);
    report = await request(instance, path); assert.equal(report.evidencePresent, false);
    assert.equal((await request(instance, `/api/summary?period=${period}`)).local.credits, '110');
  } finally {
    if (instance) await stop(instance, directory);
    assert.equal(dirname(resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
