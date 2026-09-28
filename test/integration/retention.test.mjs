import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ensureService, request } from '../../dist/daemon/client.js';
import { envelope, nanos, span } from '../fixtures/synthetic-otlp.mjs';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function absent(path) {
  try { await access(path); return false; }
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
async function deliver(instance, spans) {
  const response = await fetch(`${instance.url}/v1/traces`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pilotmeter-token': instance.collectorToken },
    body: JSON.stringify(envelope(spans)), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('explicit retention CLI persists policy, rejects browser changes and never revives retired traces', async () => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'pilotmeter-retention-api-'));
  let instance = await ensureService(directory);
  const bin = resolve('bin/pilotmeter.js');
  const old = span(1, { traceId: '1'.repeat(32), cost: '100', session: 'synthetic-old',
    startTimeUnixNano: nanos('2020-01-01T00:00:00.000Z'), endTimeUnixNano: nanos('2020-01-01T00:00:01.000Z') });
  const recentTime = new Date(Date.now() - 1000).toISOString();
  const recent = span(2, { traceId: '2'.repeat(32), cost: '25', session: 'synthetic-new',
    startTimeUnixNano: nanos(recentTime), endTimeUnixNano: nanos(recentTime) });
  try {
    assert.equal((await request(instance, '/api/settings')).retentionDays, null);
    await deliver(instance, [old, recent]);
    assert.equal((await request(instance, '/api/summary?period=2020-01')).local.nanoAiu, '100');
    const csrf = await request(instance, '/api/session');
    const forbidden = await fetch(`${instance.url}/api/settings`, { method: 'PATCH',
      headers: { origin: instance.url, 'content-type': 'application/json', 'x-pilotmeter-csrf': csrf.csrfToken },
      body: '{"retentionDays":7}' });
    assert.equal(forbidden.status, 403); await forbidden.arrayBuffer();
    for (const invalid of [0, -1, 0.5, 36501, '7', true]) {
      await assert.rejects(request(instance, '/api/settings', 'PATCH', { retentionDays: invalid }), /Retention days/);
    }
    await assert.rejects(execute(process.execPath, [bin, '--data-dir', directory, 'config', 'set', 'retention.days', 'NaN'], { windowsHide: true }), /retention.days/);
    assert.equal((await request(instance, '/api/settings')).retentionDays, null);
    const configured = await execute(process.execPath, [bin, '--data-dir', directory, 'config', 'set', 'retention.days', '7'], { windowsHide: true });
    assert.match(configured.stdout, /7 天/);
    let summary = await request(instance, '/api/summary?period=2020-01');
    assert.equal(summary.local.nanoAiu, null);
    assert.equal(summary.display.percentage, null);
    assert.match(summary.display.reason, /历史明细已清理/);
    assert.equal(summary.retention.days, 7);
    assert.equal(summary.retention.prunedTraces, 1);
    assert.equal(summary.retention.prunedSpans, 1);
    assert.equal((await request(instance, `/api/summary?period=${recentTime.slice(0, 7)}`)).local.nanoAiu, '25');
    assert.equal((await deliver(instance, [old])).partialSuccess.rejectedSpans, '1');
    assert.equal((await request(instance, '/api/summary?period=2020-01')).local.nanoAiu, null);
    await stop(instance, directory); instance = null;
    instance = await ensureService(directory);
    assert.equal((await request(instance, '/api/settings')).retentionDays, 7);
    await execute(process.execPath, [bin, '--data-dir', directory, 'config', 'set', 'retention.days', 'null'], { windowsHide: true });
    summary = await request(instance, '/api/summary?period=2020-01');
    assert.equal(summary.retention.days, null);
    assert.equal(summary.retention.prunedSpans, 1);
    assert.match(summary.display.reason, /历史明细已清理/);
    assert.equal((await deliver(instance, [old])).partialSuccess.rejectedSpans, '1');
  } finally {
    if (instance) await stop(instance, directory);
    assert.equal(dirname(resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
