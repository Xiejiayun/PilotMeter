import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { Repository } from '../../dist/storage/repository.js';
import { envelope, id, span } from '../fixtures/synthetic-otlp.mjs';

const cutoff = '2026-09-20T00:00:00.000Z';
const verification = { cliVersion: '1.0.88', verifiedAt: '2026-09-28T00:00:00.000Z', evidence: 'Synthetic test evidence only' };
const traceId = number => number.toString(16).padStart(32, '0');
const record = (trace, number = 1, changes = {}) => ({
  ...parseOtlp(envelope([span(number, { traceId: traceId(trace) })]), 'source-a')[0],
  ...changes,
});
const at = (trace, time, changes = {}) => record(trace, 1, { startTime: time, endTime: time, ...changes });
const basis = (repo, end = cutoff, unit = verification) => repo.reconciliationBasis('2026-09', end, unit);

function memory(t) {
  const repo = new Repository(':memory:');
  t.after(() => repo.close());
  return repo;
}

test('basis counts exact root costs only inside the half-open official time interval', t => {
  const repo = memory(t);
  repo.ingest([
    at(1, '2026-08-31T23:59:59.999Z', { nanoAiu: '100' }),
    at(2, '2026-09-01T00:00:00.000Z', { nanoAiu: '9007199254740993' }),
    at(3, '2026-09-19T23:59:59.999Z', { nanoAiu: '7' }),
    at(4, cutoff, { nanoAiu: '200' }),
    at(5, '2026-10-01T00:00:00.000Z', { nanoAiu: '300' }),
    record(2, 2, { parentSpanId: id(1), operation: 'chat', nanoAiu: '500' }),
    record(2, 3, { parentSpanId: id(2), nanoAiu: '600' }),
  ]);
  const result = basis(repo);
  assert.equal(result.knownNanoAiu, '9007199254741000');
  assert.equal(result.knownCalls, 2);
  assert.equal(result.unknownCalls, 0);
  assert.equal(result.pendingCalls, 0);
  assert.equal(result.unitVerified, true);
  assert.deepEqual(result.sourceContexts, ['source-a']);
  assert.deepEqual(result.blockers, []);
  assert.match(result.ledgerHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(basis(repo, '2026-09-20T00:00:00Z'), result, 'equivalent cutoff formats canonicalize identically');
});

test('missing or invalid cutoff cannot silently substitute a complete month or zero usage', t => {
  const repo = memory(t);
  repo.ingest([record(1)]);
  assert.equal(basis(repo, null).knownNanoAiu, null);
  assert.ok(basis(repo, null).blockers.includes('cutoff-missing'));
  for (const end of ['invalid', '2026-09-31T00:00:00Z', '2026-08-31T23:59:59.999Z', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.001Z']) {
    const result = basis(repo, end);
    assert.equal(result.knownNanoAiu, null);
    assert.ok(result.blockers.includes('cutoff-invalid'));
  }
  assert.equal(basis(repo, '2026-10-01T00:00:00.000Z').knownCalls, 1);
  assert.throws(() => repo.reconciliationBasis('2026-13', cutoff, verification), /Invalid UTC month/);
  const empty = memory(t);
  assert.equal(basis(empty).knownNanoAiu, null);
  assert.ok(basis(empty).blockers.includes('no-known-root-usage'));
  empty.ingest([record(1, 1, { nanoAiu: '0' })]);
  assert.equal(basis(empty).knownNanoAiu, '0');
  assert.deepEqual(basis(empty).blockers, []);
});

test('unknown root costs, pending roots, invalid rows and conflicts block completeness without losing the known subtotal', t => {
  const repo = memory(t);
  repo.ingest([
    record(1), record(2, 1, { nanoAiu: null }),
    record(3, 1, { parentSpanId: id(99) }),
    record(4, 1, { startTime: '2026-09-18T00:00:00.000Z' }), record(5),
  ]);
  repo.ingest([record(5, 1, { nanoAiu: '999' })]);
  const result = basis(repo);
  assert.equal(result.knownNanoAiu, '2500000000');
  assert.equal(result.knownCalls, 1);
  assert.equal(result.unknownCalls, 3);
  assert.equal(result.pendingCalls, 1);
  for (const blocker of ['unknown-root-metering', 'pending-classification', 'invalid-classification', 'conflicting-events', 'unresolved-ancestry']) {
    assert.ok(result.blockers.includes(blocker), blocker);
  }
});

test('basis checks ancestry outside the selected month and detects orphan non-agent spans', t => {
  const repo = memory(t);
  repo.ingest([
    record(1),
    record(2, 2, { parentSpanId: id(1) }),
    record(2, 1, { operation: 'http_request', nanoAiu: null, startTime: '2026-08-31T23:59:59.000Z', endTime: '2026-08-01T00:00:00.000Z' }),
    record(3, 1, { operation: 'chat', parentSpanId: id(99) }),
    record(4, 1, { operation: null }),
  ]);
  const result = basis(repo);
  assert.ok(result.blockers.includes('invalid-classification'), 'invalid August ancestor affects its September descendant');
  assert.ok(result.blockers.includes('unresolved-ancestry'), 'chat descendants can reveal missing roots even when ordinary classification calls them child');
  assert.ok(result.blockers.includes('missing-operation'));
});

test('unlocatable timestamps and rejected records block all months because their coverage is unknown', t => {
  for (const kind of ['timestamp', 'identity', 'import']) {
    const repo = memory(t);
    repo.ingest([record(1)]);
    const before = basis(repo);
    if (kind === 'timestamp') repo.ingest([record(2, 1, { endTime: null, startTime: '2020-01-01T00:00:00.000Z' })]);
    if (kind === 'identity') repo.ingest([record(2, 1, { traceId: '' })]);
    if (kind === 'import') repo.ingestImport([], { fileKey: 'test', fileIdentity: '1', generation: 0, offset: 1, prefixHash: 'x' }, 1);
    const after = basis(repo);
    assert.equal(after.knownNanoAiu, before.knownNanoAiu);
    assert.notEqual(after.ledgerHash, before.ledgerHash);
    assert.ok(after.blockers.includes(kind === 'timestamp' ? 'unlocated-events' : 'unlocated-rejections'));
  }
});

test('quarantined time and source variants cannot hide behind the original event month', t => {
  const repo = memory(t);
  repo.ingest([record(1), at(2, '2026-08-15T00:00:00.000Z')]);
  const before = basis(repo);
  repo.ingest([record(2, 1, { sourceContext: 'source-conflict-only' })]);
  const result = basis(repo);
  assert.equal(result.knownNanoAiu, before.knownNanoAiu);
  assert.ok(result.blockers.includes('conflicting-events'));
  assert.deepEqual(result.sourceContexts, ['source-a', 'source-conflict-only']);
  assert.notEqual(result.ledgerHash, before.ledgerHash);
  repo.ingest([record(3, 1, { endTime: null })]);
  repo.ingest([record(3, 1, { sourceContext: 'source-b', endTime: null, nanoAiu: '50' })]);
  assert.ok(basis(repo).blockers.includes('unlocated-events'));
});

test('unit evidence is required and contributes to the basis hash', t => {
  const repo = memory(t);
  repo.ingest([record(1)]);
  const original = basis(repo);
  for (const unit of [null, { ...verification, cliVersion: '1.0.89' }, { ...verification, verifiedAt: 'invalid' }, { ...verification, evidence: '' }]) {
    const result = basis(repo, cutoff, unit);
    assert.equal(result.unitVerified, false);
    assert.ok(result.blockers.includes('unit-unverified'));
    assert.notEqual(result.ledgerHash, original.ledgerHash);
  }
  assert.notEqual(basis(repo, cutoff, { ...verification, evidence: 'Changed synthetic evidence' }).ledgerHash, original.ledgerHash);
});

test('hash captures the whole ledger and contexts, while replay, cursor, budget and maintenance noise remain stable', t => {
  const repo = memory(t);
  repo.ingest([record(1)]);
  const original = basis(repo);
  repo.ingest([record(1)]);
  repo.ingestImport([record(1)], { fileKey: 'replay', fileIdentity: '1', generation: 0, offset: 100, prefixHash: 'same' });
  repo.setSetting('settings', { monthlyBudget: '200', unitVerification: verification, account: null, retentionDays: null, demo: false });
  repo.applyRetention(36500, new Date('2026-09-28T00:00:00.000Z'));
  assert.equal(basis(repo).ledgerHash, original.ledgerHash);
  repo.ingest([at(2, '2026-10-10T00:00:00.000Z', { sourceContext: 'source-b' })]);
  const changed = basis(repo);
  assert.equal(changed.knownNanoAiu, original.knownNanoAiu);
  assert.deepEqual(changed.sourceContexts, ['source-a', 'source-b']);
  assert.notEqual(changed.ledgerHash, original.ledgerHash, 'out-of-window changes invalidate existing evidence too');
  repo.ingest([record(3, 2, { parentSpanId: id(1), endTime: '2026-08-10T00:00:00.000Z', startTime: '2026-08-10T00:00:00.000Z' })]);
  const beforeAncestor = basis(repo);
  repo.ingest([record(3, 1, { operation: 'http_request', nanoAiu: null, startTime: '2026-08-10T00:00:00.000Z', endTime: '2026-08-10T00:00:00.000Z' })]);
  assert.notEqual(basis(repo).ledgerHash, beforeAncestor.ledgerHash);
});

test('retention overlap blocks affected months but an older cutoff need not block later months', t => {
  const repo = memory(t);
  repo.ingest([at(1, '2026-08-01T00:00:00.000Z', { sourceContext: 'source-old' }), record(2)]);
  const before = basis(repo);
  repo.applyRetention(1, new Date('2026-09-02T00:00:00.000Z'));
  const after = basis(repo);
  assert.deepEqual(after.blockers, []);
  assert.deepEqual(after.sourceContexts, ['source-a', 'source-old']);
  assert.notEqual(after.ledgerHash, before.ledgerHash);
  repo.ingest([at(3, '2026-08-02T00:00:00.000Z')]);
  repo.applyRetention(1, new Date('2026-09-03T00:00:00.000Z'));
  assert.ok(basis(repo).blockers.includes('retention-overlap'));
  const other = memory(t);
  other.ingest([at(1, '2026-08-01T00:00:00.000Z'), record(2)]);
  other.applyRetention(1, new Date('2026-09-02T00:00:00.000Z'));
  assert.deepEqual(basis(other).blockers, []);
  other.ingest([record(1, 2)]);
  assert.ok(basis(other).blockers.includes('unlocated-rejections'), 'a retired trace may have rejected a later-month relative');
});

test('basis is stable across restart and independent insertion order', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-basis-'));
  const path = join(directory, 'usage.db');
  let repo = new Repository(path);
  t.after(() => { repo.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = [record(1), record(2, 1, { sourceContext: 'source-b' })];
  repo.ingest(input);
  const original = basis(repo);
  repo.close(); repo = new Repository(path);
  assert.deepEqual(basis(repo), original);
  const reordered = memory(t);
  reordered.ingest([...input].reverse());
  assert.deepEqual(basis(reordered), original);
});
