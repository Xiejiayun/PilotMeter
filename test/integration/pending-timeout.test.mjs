import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Repository } from '../../dist/storage/repository.js';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { ensureService, request } from '../../dist/daemon/client.js';
import { envelope, id, nanos, span } from '../fixtures/synthetic-otlp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
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

test('startup diagnoses old pending calls once and live ancestor delivery restores evidence-based classification', async () => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'pilotmeter-pending-api-'));
  const dbPath = join(directory, 'usage.db');
  const traceId = 'a'.repeat(32);
  const orphan = span(1, { traceId, parentSpanId: id(2), cost: '10000000000', session: 'synthetic-pending',
    startTimeUnixNano: nanos('2025-01-02T00:00:00.000Z'), endTimeUnixNano: nanos('2025-01-02T00:00:01.000Z') });
  const repo = new Repository(dbPath);
  repo.ingest(parseOtlp(envelope([orphan]), 'synthetic-pending-source'));
  const sessionId = repo.sessions('2025-01').items[0].id;
  repo.close();
  // Seed the first-observation time while this isolated fixture has no live daemon.
  const fixture = new DatabaseSync(dbPath);
  fixture.prepare('UPDATE usage_events SET observed_at = ?').run(new Date(Date.now() - 25 * 60 * 60_000).toISOString());
  fixture.close();
  let instance;
  const timeoutDiagnostic = async () => (await request(instance, '/api/diagnostics')).items.find(item => item.code === 'pending-classification-timeout');
  try {
    instance = await ensureService(directory);
    let detail = await request(instance, `/api/sessions/${sessionId}`);
    assert.equal(detail.events[0].classification, 'pending');
    assert.match(detail.events[0].reason, /^pending-timeout:/);
    assert.equal(detail.nanoAiu, null); assert.equal(detail.pendingCalls, 1);
    assert.equal((await timeoutDiagnostic()).count, 1);
    await stop(instance, directory); instance = null;
    instance = await ensureService(directory);
    assert.equal((await timeoutDiagnostic()).count, 1);
    const ancestor = span(2, { traceId, operation: 'execute_tool', cost: null, session: 'synthetic-pending',
      startTimeUnixNano: nanos('2025-01-02T00:00:00.000Z'), endTimeUnixNano: nanos('2025-01-02T00:00:02.000Z') });
    const response = await fetch(`${instance.url}/v1/traces`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pilotmeter-token': instance.collectorToken },
      body: JSON.stringify(envelope([orphan, ancestor])), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); await response.arrayBuffer();
    detail = await request(instance, `/api/sessions/${sessionId}`);
    assert.equal(detail.events[0].classification, 'root'); assert.equal(detail.events[0].reason, null);
    assert.equal(detail.nanoAiu, '10000000000'); assert.equal(detail.pendingCalls, 0);
    assert.equal((await timeoutDiagnostic()).count, 1, 'the retained timeout diagnostic is historical, not a new failure');
    const summary = await request(instance, '/api/summary?period=2025-01');
    assert.equal(summary.local.nanoAiu, '10000000000'); assert.equal(summary.local.knownCalls, 1);
  } finally {
    if (instance) await stop(instance, directory);
    assert.equal(dirname(resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
