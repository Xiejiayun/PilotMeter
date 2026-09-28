import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { Repository } from '../../dist/storage/repository.js';
import { envelope, id, span } from '../fixtures/synthetic-otlp.mjs';

const runAt = new Date('2026-09-28T00:00:00.000Z');
const cutoff = '2026-09-21T00:00:00.000Z';
const emptyStatus = { lastRunAt: null, cutoff: null, prunedTraces: 0, prunedSpans: 0 };
const traceId = number => number.toString(16).padStart(32, '0');
const record = (trace, number = 1, changes = {}) => ({
  ...parseOtlp(envelope([span(number, { traceId: traceId(trace), session: `session-${trace}` })]), 'retention-test')[0],
  ...changes,
});

function memory(t) {
  const repository = new Repository(':memory:');
  t.after(() => repository.close());
  return repository;
}

function disk(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-retention-'));
  const state = { directory, path: join(directory, 'usage.sqlite'), repository: null };
  t.after(() => {
    state.repository?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  state.repository = new Repository(state.path);
  return state;
}

function downgradeFixture(state) {
  state.repository.close();
  state.repository = null;
  const db = new DatabaseSync(state.path);
  db.exec('DROP TABLE retired_traces; DROP TABLE retention_status; DELETE FROM schema_migrations WHERE version = 2; PRAGMA user_version = 1;');
  db.close();
}

test('retention defaults to disabled and validates its explicit time and day range', t => {
  const repository = memory(t);
  repository.ingest([record(1)]);
  assert.deepEqual(repository.getRetentionStatus(), emptyStatus);
  assert.deepEqual(repository.applyRetention(null, runAt), emptyStatus);
  assert.equal(repository.summary('2026-09').knownCalls, 1);
  for (const days of [0, -1, 1.5, 36501, NaN, Infinity, '7', undefined]) {
    assert.throws(() => repository.applyRetention(days, runAt), /Retention days/);
  }
  assert.throws(() => repository.applyRetention(7, new Date(NaN)), /Invalid retention run time/);
  assert.throws(() => repository.applyRetention(7, new Date('+010000-01-01T00:00:00.000Z')), /Invalid retention run time/);
  assert.throws(() => repository.applyRetention(36500, new Date('0000-01-01T00:00:00.000Z')), /Invalid retention cutoff time/);
  assert.deepEqual(repository.getRetentionStatus(), emptyStatus);
  assert.equal(repository.applyRetention(36500, runAt).prunedTraces, 0);
  assert.equal(repository.applyRetention(1, runAt).prunedTraces, 1);
});

test('retention preserves entire traces crossing cutoff, missing or reversed times, and conflicting copies', t => {
  const repository = memory(t);
  repository.ingest([
    record(1), record(1, 2, { parentSpanId: id(1), operation: 'chat' }),
    record(2), record(2, 2, { parentSpanId: id(1), endTime: '2026-09-22T00:00:00.000Z' }),
    record(3, 1, { endTime: cutoff }),
    record(4, 1, { endTime: null }),
    record(5, 1, { startTime: '2026-09-20T00:00:00.000Z', endTime: '2026-09-19T00:00:00.000Z' }),
    record(6), record(7, 1, { startTime: null }),
  ]);
  repository.ingest([record(6, 1, { endTime: '2026-09-26T00:00:00.000Z' })]);
  const status = repository.applyRetention(7, runAt);
  assert.deepEqual(status, { lastRunAt: runAt.toISOString(), cutoff, prunedTraces: 1, prunedSpans: 2 });
  const remaining = repository.sessions('2026-09').items;
  assert.equal(remaining.some(session => session.sessionId === 'session-1'), false);
  assert.equal(repository.session(remaining.find(session => session.sessionId === 'session-2').id).events.length, 2);
  assert.equal(repository.ingest([record(4, 2)]).accepted, 1, 'missing-time trace remains active');
  for (const trace of [2, 3, 5, 6, 7]) assert.equal(repository.ingest([record(trace, 3)]).accepted, 1);
});

test('cleared ledgers stay unknown, retain history evidence, and never revive from replay or late relatives', t => {
  const repository = memory(t);
  repository.ingest([record(1, 2, { parentSpanId: id(1) })]);
  const session = repository.sessions('2026-09').items[0];
  const status = repository.applyRetention(7, runAt);
  assert.equal(status.prunedTraces, 1);
  assert.equal(repository.hasUsageEvents(), true, 'retired traces prevent demo seeding an emptied ledger');
  assert.equal(repository.session(session.id), null);
  assert.deepEqual(repository.sessions('2026-09').items, []);
  assert.equal(repository.summary('2026-09').nanoAiu, null);
  assert.equal(repository.summary('2026-09').coverage, 'empty');
  assert.deepEqual(repository.applyRetention(7, runAt), status, 'rerunning does not inflate cumulative counts');
  assert.deepEqual(repository.applyRetention(null), status, 'turning retention off preserves cleanup history');
  assert.equal(repository.applyRetention(36500, runAt).prunedTraces, 1);
  const replay = repository.ingest([
    record(1, 2, { parentSpanId: id(1) }),
    record(1, 1),
    record(1, 3, { parentSpanId: id(2), endTime: '2026-09-27T00:00:00.000Z' }),
  ]);
  assert.deepEqual(replay, { accepted: 0, duplicates: 0, conflicts: 0, rejected: 3 });
  assert.equal(repository.summary('2026-09').nanoAiu, null);
  assert.equal(repository.diagnostics().find(item => item.code === 'retired-trace').count, 3);
  assert.equal(repository.ingest([record(2)]).accepted, 1);
  assert.equal(repository.summary('2026-09').knownCalls, 1);
  assert.equal(repository.applyRetention(7, runAt).prunedTraces, 2);
});

test('retention state and minimal trace tombstones persist across restart with atomic import cursors', t => {
  const state = disk(t);
  let repository = state.repository;
  repository.ingest([record(1)]);
  const status = repository.applyRetention(7, runAt);
  repository.close();
  repository = state.repository = new Repository(state.path);
  assert.deepEqual(repository.getRetentionStatus(), status);
  assert.equal(repository.hasUsageEvents(), true);
  const cursor = { fileKey: 'synthetic.jsonl', fileIdentity: '1:2', generation: 0, offset: 100, prefixHash: 'synthetic-hash' };
  assert.deepEqual(repository.ingestImport([record(1), record(2)], cursor),
    { accepted: 1, duplicates: 0, conflicts: 0, rejected: 1, offset: 100 });
  assert.deepEqual(repository.getImportCursor(cursor.fileKey), cursor);
  const db = new DatabaseSync(state.path);
  try {
    const tombstone = db.prepare('SELECT * FROM retired_traces').get();
    assert.deepEqual(Object.keys(tombstone), ['trace_id', 'retired_at', 'cutoff_at', 'span_count']);
    assert.equal(tombstone.trace_id, traceId(1));
    db.exec(`CREATE TRIGGER fail_cursor BEFORE UPDATE ON import_cursors BEGIN SELECT RAISE(ABORT, 'synthetic cursor failure'); END;`);
    assert.throws(() => repository.ingestImport([record(1), record(3)], { ...cursor, offset: 200 }), /synthetic cursor failure/);
    assert.deepEqual(repository.getImportCursor(cursor.fileKey), cursor);
    assert.equal(repository.diagnostics().find(item => item.code === 'retired-trace').count, 1);
    assert.equal(repository.ingest([record(3)]).accepted, 1, 'failed cursor update rolled back the new event');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM retired_traces').get().count, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('cleanup failure rolls back deleted spans, sessions, tombstones and cumulative counts together', t => {
  const state = disk(t);
  const repository = state.repository;
  repository.ingest([record(1), record(1, 2, { parentSpanId: id(1) })]);
  const sessionId = repository.sessions('2026-09').items[0].id;
  const db = new DatabaseSync(state.path);
  try {
    db.exec(`CREATE TRIGGER fail_retention BEFORE UPDATE ON retention_status BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END;`);
    assert.throws(() => repository.applyRetention(7, runAt), /synthetic cleanup failure/);
    assert.deepEqual(repository.getRetentionStatus(), emptyStatus);
    assert.equal(repository.session(sessionId).events.length, 2);
    assert.equal(repository.summary('2026-09').knownCalls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM retired_traces').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
    db.exec('DROP TRIGGER fail_retention');
    assert.equal(repository.applyRetention(7, runAt).prunedSpans, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM span_classification').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  } finally { db.close(); }
});

test('settings and the first retention cleanup commit together or both roll back on failure', t => {
  const state = disk(t);
  const repository = state.repository;
  const original = { monthlyBudget: '100', unitVerification: null, account: null, retentionDays: null, demo: false };
  const next = { ...original, monthlyBudget: '200', retentionDays: 7 };
  repository.setSetting('settings', original);
  repository.ingest([record(1)]);
  const db = new DatabaseSync(state.path);
  try {
    db.exec(`CREATE TRIGGER fail_retention BEFORE UPDATE ON retention_status BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END;`);
    assert.throws(() => repository.saveSettingsWithRetention(next, runAt), /synthetic cleanup failure/);
    assert.deepEqual(repository.getSetting('settings'), original, 'a failed setting request cannot silently enable later cleanup');
    assert.deepEqual(repository.getRetentionStatus(), emptyStatus);
    assert.equal(repository.summary('2026-09').knownCalls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM retired_traces').get().count, 0);
    db.exec('DROP TRIGGER fail_retention');
    const status = repository.saveSettingsWithRetention(next, runAt);
    assert.deepEqual(status, { lastRunAt: runAt.toISOString(), cutoff, prunedTraces: 1, prunedSpans: 1 });
    assert.deepEqual(repository.getSetting('settings'), next);
    assert.equal(repository.summary('2026-09').nanoAiu, null);
    assert.deepEqual(repository.saveSettingsWithRetention(original, runAt), status, 'disabling preserves cleanup evidence');
    assert.equal(repository.getSetting('settings').retentionDays, null);
  } finally { db.close(); }
});

test('v1 upgrades sequentially with a readable backup preserving prior usage, settings and cursor', t => {
  const state = disk(t);
  state.repository.ingest([record(1)]);
  state.repository.setSetting('synthetic-setting', { value: 'preserved' });
  const cursor = { fileKey: 'v1.jsonl', fileIdentity: '1:2', generation: 1, offset: 42, prefixHash: 'v1-prefix' };
  state.repository.ingestImport([], cursor);
  downgradeFixture(state);
  state.repository = new Repository(state.path);
  assert.equal(state.repository.summary('2026-09').knownCalls, 1);
  assert.deepEqual(state.repository.getSetting('synthetic-setting'), { value: 'preserved' });
  assert.deepEqual(state.repository.getImportCursor(cursor.fileKey), cursor);
  assert.deepEqual(state.repository.getRetentionStatus(), emptyStatus);
  const backups = readdirSync(state.directory).filter(name => name.includes('.before-v2-'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(state.directory, backups[0]));
  const current = new DatabaseSync(state.path);
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
    assert.equal(backup.prepare('SELECT byte_offset FROM import_cursors').get().byte_offset, 42);
    assert.deepEqual(current.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2]);
    assert.equal(current.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { backup.close(); current.close(); }
  state.repository.close();
  state.repository = new Repository(state.path);
  assert.equal(readdirSync(state.directory).filter(name => name.includes('.before-v2-')).length, 1, 'current schema does not migrate again');
});

test('failed v1 migration preserves original schema and data plus its pre-upgrade backup', t => {
  const state = disk(t);
  state.repository.ingest([record(1)]);
  downgradeFixture(state);
  let db = new DatabaseSync(state.path);
  db.exec('CREATE TABLE retention_status (synthetic_collision TEXT)');
  db.close();
  assert.throws(() => new Repository(state.path), /retention_status/);
  db = new DatabaseSync(state.path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'retired_traces'").get().count, 0);
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version), [1]);
    assert.equal(readdirSync(state.directory).filter(name => name.includes('.before-v2-')).length, 1);
  } finally { db.close(); }
});
