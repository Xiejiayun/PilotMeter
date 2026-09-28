import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { PENDING_CLASSIFICATION_TIMEOUT_MS, Repository } from '../../dist/storage/repository.js';
import { envelope, id, span } from '../fixtures/synthetic-otlp.mjs';

const record = (number = 1, changes = {}) => ({
  ...parseOtlp(envelope([span(number)]), 'synthetic-source')[0], ...changes,
});
const orphan = (number = 1, changes = {}) => record(number, { parentSpanId: id(99), ...changes });
const timeoutDiagnostic = repo => repo.diagnostics().find(item => item.code === 'pending-classification-timeout');
const event = (repo, number = 1, period = '2026-09') => repo.session(repo.sessions(period).items[0].id).events.find(item => item.spanId === id(number));
const oldObservation = () => new Date(Date.now() - PENDING_CLASSIFICATION_TIMEOUT_MS - 60_000).toISOString();

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-pending-'));
  const path = join(directory, 'usage.db');
  const fixture = { repo: new Repository(path), db: new DatabaseSync(path) };
  fixture.reopen = () => { fixture.repo.close(); fixture.repo = new Repository(path); };
  t.after(() => {
    fixture.db.close(); fixture.repo.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

test('pending classification times out exactly 24 hours after first observation and remains excluded', t => {
  const { repo, db } = fixture(t);
  assert.equal(PENDING_CLASSIFICATION_TIMEOUT_MS, 86_400_000);
  repo.ingest([orphan()]);
  const observedAt = Date.parse(db.prepare('SELECT observed_at FROM usage_events').get().observed_at);
  assert.equal(repo.refreshPendingClassifications(new Date(observedAt + PENDING_CLASSIFICATION_TIMEOUT_MS - 1)), 0);
  assert.equal(event(repo).reason, 'unresolved-ancestor');
  assert.equal(timeoutDiagnostic(repo), undefined);
  assert.equal(repo.refreshPendingClassifications(new Date(observedAt + PENDING_CLASSIFICATION_TIMEOUT_MS)), 1);
  assert.equal(event(repo).classification, 'pending');
  assert.equal(event(repo).reason, 'pending-timeout:unresolved-ancestor');
  assert.equal(repo.summary('2026-09').nanoAiu, null);
  assert.equal(repo.summary('2026-09').knownCalls, 0);
  assert.equal(repo.summary('2026-09').pendingCalls, 1);
  assert.equal(timeoutDiagnostic(repo).count, 1);
});

test('newly imported historical telemetry gets its own full observation window', t => {
  const { repo, db } = fixture(t);
  const before = Date.now();
  repo.ingest([orphan(1, { startTime: '2001-01-01T00:00:00.000Z', endTime: '2001-01-01T00:00:01.000Z' })]);
  const observedAt = Date.parse(db.prepare('SELECT observed_at FROM usage_events').get().observed_at);
  assert.ok(observedAt >= before);
  assert.equal(repo.refreshPendingClassifications(), 0);
  assert.equal(event(repo, 1, '2001-01').reason, 'unresolved-ancestor');
  assert.equal(timeoutDiagnostic(repo), undefined);
});

test('ingest diagnoses all stale pending reasons once without renewing observations on replay or restart', t => {
  const data = [orphan(), record(2, { serviceVersion: 'future-version' }), record(3, { serverAddress: null })];
  const f = fixture(t);
  f.repo.ingest(data);
  const observedAt = oldObservation();
  f.db.prepare('UPDATE usage_events SET observed_at = ?').run(observedAt);
  assert.equal(f.repo.ingest(data).duplicates, 3);
  assert.equal(timeoutDiagnostic(f.repo).count, 3);
  assert.equal(event(f.repo, 1).reason, 'pending-timeout:unresolved-ancestor');
  assert.equal(event(f.repo, 2).reason, 'pending-timeout:unsupported-cli-version');
  assert.equal(event(f.repo, 3).reason, 'pending-timeout:missing-root-markers');
  const classified = f.db.prepare('SELECT * FROM span_classification ORDER BY span_id').all();
  const diagnostic = timeoutDiagnostic(f.repo);
  f.reopen();
  assert.equal(f.repo.refreshPendingClassifications(), 0);
  assert.equal(f.repo.ingest(data).duplicates, 3);
  assert.equal(f.repo.refreshPendingClassifications(new Date(0)), 0, 'clock rollback does not remove a recorded timeout');
  assert.deepEqual(f.db.prepare('SELECT * FROM span_classification ORDER BY span_id').all(), classified);
  assert.deepEqual(timeoutDiagnostic(f.repo), diagnostic);
  assert.ok(f.db.prepare('SELECT observed_at FROM usage_events').all().every(row => row.observed_at === observedAt));
});

test('a different unresolved reason keeps the timeout without incrementing its diagnostic', t => {
  const { repo, db } = fixture(t);
  repo.ingest([orphan()]);
  db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
  assert.equal(repo.refreshPendingClassifications(), 1);
  repo.ingest([record(99, { operation: null, nanoAiu: null })]);
  assert.equal(event(repo).reason, 'pending-timeout:unresolved-ancestor-operation');
  assert.equal(timeoutDiagnostic(repo).count, 1);
  assert.equal(repo.refreshPendingClassifications(), 0);
  assert.equal(repo.summary('2026-09').nanoAiu, null);
});

test('late ancestry resolves timed-out calls to root or child and counts only the verified root', t => {
  for (const operation of ['http_request', 'invoke_agent']) {
    const { repo, db } = fixture(t);
    repo.ingest([orphan(1, { nanoAiu: '10000000000' })]);
    db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
    assert.equal(repo.refreshPendingClassifications(), 1);
    repo.ingest([record(99, { operation, nanoAiu: operation === 'invoke_agent' ? '5000000000' : null })]);
    assert.equal(event(repo).classification, operation === 'invoke_agent' ? 'child' : 'root');
    assert.equal(event(repo).reason, null);
    assert.equal(repo.summary('2026-09').nanoAiu, operation === 'invoke_agent' ? '5000000000' : '10000000000');
    assert.equal(repo.summary('2026-09').knownCalls, 1);
    assert.equal(repo.summary('2026-09').pendingCalls, 0);
    assert.equal(timeoutDiagnostic(repo).count, 1);
    assert.equal(repo.refreshPendingClassifications(), 0);
  }
});

test('conflicting evidence replaces a timeout with quarantine and never restores a charge by replay', t => {
  const { repo, db } = fixture(t);
  repo.ingest([orphan()]);
  db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
  repo.refreshPendingClassifications();
  assert.equal(repo.ingest([orphan(1, { nanoAiu: '5' })]).conflicts, 1);
  assert.equal(event(repo).classification, 'conflict');
  assert.equal(event(repo).reason, 'conflicting-event');
  repo.ingest([orphan(), record(99, { operation: 'http_request', nanoAiu: null })]);
  assert.equal(repo.refreshPendingClassifications(), 0);
  assert.equal(repo.summary('2026-09').nanoAiu, null);
  assert.equal(repo.summary('2026-09').unknownCalls, 1);
  assert.equal(repo.summary('2026-09').pendingCalls, 0);
  assert.equal(timeoutDiagnostic(repo).count, 1);
});

test('classification or diagnostic write failure rolls the timeout transaction back and permits one retry', t => {
  for (const target of ['diagnostics', 'span_classification']) {
    const { repo, db } = fixture(t);
    repo.ingest([orphan()]);
    db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
    const when = target === 'diagnostics'
      ? "BEFORE INSERT ON diagnostics WHEN NEW.code = 'pending-classification-timeout'"
      : 'BEFORE UPDATE ON span_classification';
    db.exec(`CREATE TRIGGER fail_timeout ${when} BEGIN SELECT RAISE(ABORT, 'injected timeout failure'); END`);
    assert.throws(() => repo.refreshPendingClassifications(), /injected timeout failure/);
    assert.equal(event(repo).reason, 'unresolved-ancestor');
    assert.equal(timeoutDiagnostic(repo), undefined);
    db.exec('DROP TRIGGER fail_timeout');
    assert.equal(repo.refreshPendingClassifications(), 1);
    assert.equal(timeoutDiagnostic(repo).count, 1);
  }
});

test('a timeout failure during ingestion also rolls back new evidence and deduplication state', t => {
  const { repo, db } = fixture(t);
  repo.ingest([orphan()]);
  db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
  db.exec("CREATE TRIGGER fail_timeout BEFORE INSERT ON diagnostics WHEN NEW.code = 'pending-classification-timeout' BEGIN SELECT RAISE(ABORT, 'injected timeout failure'); END");
  assert.throws(() => repo.ingest([record(2)]), /injected timeout failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
  assert.equal(event(repo).reason, 'unresolved-ancestor');
  assert.equal(timeoutDiagnostic(repo), undefined);
  db.exec('DROP TRIGGER fail_timeout');
  assert.equal(repo.ingest([record(2)]).accepted, 1);
  assert.equal(timeoutDiagnostic(repo).count, 1);
});

test('timeout evidence changes the reconciliation hash once, while maintenance and replay leave it stable', t => {
  const { repo, db } = fixture(t);
  const verification = { cliVersion: '1.0.88', verifiedAt: '2026-09-28T00:00:00.000Z', evidence: 'Synthetic unit evidence only' };
  const basis = () => repo.reconciliationBasis('2026-09', '2026-09-20T00:00:00.000Z', verification);
  repo.ingest([orphan()]);
  const before = basis();
  db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
  assert.equal(repo.refreshPendingClassifications(), 1);
  const timedOut = basis();
  assert.notEqual(timedOut.ledgerHash, before.ledgerHash);
  assert.ok(timedOut.blockers.includes('pending-classification'));
  assert.equal(timedOut.knownNanoAiu, null);
  repo.refreshPendingClassifications();
  repo.ingest([orphan()]);
  assert.deepEqual(basis(), timedOut);
  repo.ingest([record(99, { operation: 'http_request', nanoAiu: null })]);
  const resolved = basis();
  assert.notEqual(resolved.ledgerHash, timedOut.ledgerHash);
  assert.equal(resolved.knownNanoAiu, '2500000000');
  assert.deepEqual(resolved.blockers, [], 'historical timeout diagnostics do not permanently block resolved evidence');
});

test('invalid maintenance times do not change classifications or diagnostics', t => {
  const { repo, db } = fixture(t);
  repo.ingest([orphan()]);
  db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
  for (const at of [new Date(NaN), '2026-09-28', null, new Date('10000-01-01T00:00:00Z')]) {
    assert.throws(() => repo.refreshPendingClassifications(at), /Invalid classification refresh time/);
  }
  assert.equal(event(repo).reason, 'unresolved-ancestor');
  assert.equal(timeoutDiagnostic(repo), undefined);
});

test('timed-out traces still follow retention and their late replay cannot revive usage', t => {
  const { repo, db } = fixture(t);
  repo.ingest([orphan()]);
  db.prepare('UPDATE usage_events SET observed_at = ?').run(oldObservation());
  repo.refreshPendingClassifications();
  assert.equal(repo.applyRetention(1, new Date('2026-09-20T00:00:00.000Z')).prunedTraces, 1);
  assert.equal(repo.refreshPendingClassifications(), 0);
  assert.equal(repo.ingest([orphan(), record(99, { operation: 'http_request', nanoAiu: null })]).rejected, 2);
  assert.equal(repo.summary('2026-09').nanoAiu, null);
  assert.equal(repo.summary('2026-09').pendingCalls, 0);
  assert.equal(timeoutDiagnostic(repo).count, 1);
});
