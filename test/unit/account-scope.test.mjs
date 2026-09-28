import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { Repository } from '../../dist/storage/repository.js';
import { envelope, id, span } from '../fixtures/synthetic-otlp.mjs';

const period = '2026-09';
const cutoff = '2026-09-20T00:00:00.000Z';
const scopeA = { sourceContextPrefix: 'profile:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:' };
const scopeB = { sourceContextPrefix: 'profile:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:' };
const sourceA = `${scopeA.sourceContextPrefix}label-one`;
const sourceA2 = `${scopeA.sourceContextPrefix}label-two`;
const sourceB = `${scopeB.sourceContextPrefix}label-one`;
const verification = { cliVersion: '1.0.88', verifiedAt: '2026-09-28T00:00:00.000Z', evidence: 'Synthetic scope test evidence only' };
const traceId = number => number.toString(16).padStart(32, '0');
const record = (trace, number = 1, changes = {}) => ({
  ...parseOtlp(envelope([span(number, { traceId: traceId(trace) })]), sourceA)[0], ...changes,
});
const at = (trace, time, changes = {}) => record(trace, 1, { startTime: time, endTime: time, ...changes });
const basis = (repo, scope, end = cutoff) => repo.reconciliationBasis(period, end, verification, scope);

function memory(t) {
  const repo = new Repository(':memory:');
  t.after(() => repo.close());
  return repo;
}

test('profile totals include all its source labels while legacy global totals remain available', t => {
  const repo = memory(t);
  repo.ingest([
    record(1, 1, { nanoAiu: '10' }),
    record(2, 1, { nanoAiu: '20', sourceContext: sourceA2 }),
    record(3, 1, { nanoAiu: '100', sourceContext: sourceB }),
    record(4, 1, { nanoAiu: '1000', sourceContext: 'unverified-import' }),
    at(5, '2026-10-01T00:00:00.000Z', { nanoAiu: '500' }),
  ]);
  assert.equal(repo.summary(period).nanoAiu, '1130');
  assert.equal(repo.summary(period).sessionCount, 4);
  const a = repo.summary(period, verification, scopeA);
  assert.equal(a.nanoAiu, '30');
  assert.equal(a.knownCalls, 2);
  assert.equal(a.sessionCount, 2);
  assert.equal(a.unitVerified, true);
  assert.equal(a.credits, '0.00000003');
  assert.equal(repo.summary(period, verification, scopeB).nanoAiu, '100');
  assert.deepEqual(repo.sessions(period, { scope: scopeA }).items.map(item => item.sourceContext).sort(), [sourceA, sourceA2]);
  assert.equal(repo.sessions(period, { scope: scopeB }).items.length, 1);
});

test('same session identifiers in different profiles have separate scoped lifetime and model detail', t => {
  const repo = memory(t);
  repo.ingest([
    record(1, 1, { nanoAiu: '10' }),
    record(1, 2, { parentSpanId: id(1), operation: 'chat', nanoAiu: '3', model: 'model-a' }),
    at(2, '2026-10-05T00:00:00.000Z', { nanoAiu: '20' }),
    record(3, 1, { nanoAiu: '100', sourceContext: sourceB }),
    record(3, 2, { parentSpanId: id(1), operation: 'chat', nanoAiu: '9', model: 'model-b', sourceContext: sourceB }),
  ]);
  const aSession = repo.sessions(period, { scope: scopeA }).items[0];
  const bSession = repo.sessions(period, { scope: scopeB }).items[0];
  assert.notEqual(aSession.id, bSession.id);
  assert.equal(aSession.sessionId, bSession.sessionId);
  const detail = repo.session(aSession.id, verification, scopeA);
  assert.equal(detail.lifetime.nanoAiu, '30');
  assert.equal(detail.monthly[period].nanoAiu, '10');
  assert.equal(detail.monthly['2026-10'].nanoAiu, '20');
  assert.equal(detail.events.length, 3);
  assert.equal(detail.modelBreakdown[0].model, 'model-a');
  assert.equal(detail.modelBreakdown[0].nanoAiu, '3');
  assert.equal(detail.modelBreakdown[0].unitVerified, true);
  assert.equal(repo.session(aSession.id, verification, scopeB), null);
  assert.equal(repo.session(bSession.id, verification, scopeA), null);
  assert.equal(repo.session(aSession.id).lifetime.nanoAiu, '30');
  assert.equal(repo.session(bSession.id, verification, scopeB).lifetime.nanoAiu, '100');
});

test('unknown, pending and unit evidence reflect only the selected profile events', t => {
  const repo = memory(t);
  repo.ingest([
    record(1, 1, { nanoAiu: '10' }),
    record(2, 1, { nanoAiu: null }),
    record(3, 1, { serviceVersion: '1.0.89' }),
    record(4, 1, { sourceContext: sourceB, serviceVersion: '1.0.89' }),
    record(5, 1, { sourceContext: sourceB, parentSpanId: id(99) }),
  ]);
  const a = repo.summary(period, verification, scopeA);
  const b = repo.summary(period, verification, scopeB);
  assert.deepEqual([a.knownCalls, a.unknownCalls, a.pendingCalls, a.unitVerified], [1, 1, 1, true]);
  assert.deepEqual([b.knownCalls, b.unknownCalls, b.pendingCalls, b.unitVerified], [0, 0, 2, false]);
  assert.equal(b.nanoAiu, null);
  assert.equal(b.credits, null);
  const result = basis(repo, scopeA);
  assert.deepEqual([result.knownCalls, result.unknownCalls, result.pendingCalls], [1, 1, 1]);
  assert.ok(result.blockers.includes('unknown-root-metering'));
  assert.ok(result.blockers.includes('pending-classification'));
  assert.ok(!result.blockers.includes('unresolved-ancestry'), 'the unrelated profile missing ancestor is excluded');
});

test('pagination binds a cursor to its profile and keeps the old unscoped cursor format', t => {
  const repo = memory(t);
  repo.ingest([
    record(1, 1, { sessionId: 'a-1' }), record(2, 1, { sessionId: 'a-2' }),
    record(3, 1, { sessionId: 'b-1', sourceContext: sourceB }), record(4, 1, { sessionId: 'b-2', sourceContext: sourceB }),
  ]);
  const firstA = repo.sessions(period, { scope: scopeA, limit: 1 });
  const nextA = repo.sessions(period, { scope: scopeA, limit: 1, cursor: firstA.nextCursor });
  assert.equal(nextA.items.length, 1);
  assert.notEqual(firstA.items[0].id, nextA.items[0].id);
  assert.equal(nextA.nextCursor, null);
  assert.throws(() => repo.sessions(period, { scope: scopeB, cursor: firstA.nextCursor }), /cursor does not match/);
  assert.throws(() => repo.sessions(period, { cursor: firstA.nextCursor }), /cursor does not match/);
  const global = repo.sessions(period, { limit: 1 });
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(global.nextCursor, 'base64url').toString('utf8'))), ['period', 'sort', 'after']);
  assert.throws(() => repo.sessions(period, { scope: scopeA, cursor: global.nextCursor }), /cursor does not match/);
  assert.equal(repo.sessions(period, { cursor: global.nextCursor }).items.length, 3);
});

test('cross-profile replay and conflict never reassign the globally deduplicated original event', t => {
  const repo = memory(t);
  const original = record(1, 1, { nanoAiu: '10' });
  repo.ingest([original]);
  const before = basis(repo, scopeA);
  assert.deepEqual(repo.ingest([{ ...original, sourceContext: sourceB }]), { accepted: 0, duplicates: 1, conflicts: 0, rejected: 0 });
  assert.equal(repo.summary(period, verification, scopeA).nanoAiu, '10');
  assert.equal(repo.summary(period, verification, scopeB).nanoAiu, null);
  assert.deepEqual(repo.sessions(period, { scope: scopeB }).items, []);
  assert.equal(basis(repo, scopeA).ledgerHash, before.ledgerHash);
  assert.deepEqual(repo.ingest([{ ...original, nanoAiu: '11', sourceContext: sourceB }]), { accepted: 0, duplicates: 0, conflicts: 1, rejected: 0 });
  assert.equal(repo.summary(period, verification, scopeA).unknownCalls, 1);
  assert.equal(repo.summary(period, verification, scopeA).nanoAiu, null);
  assert.equal(repo.summary(period, verification, scopeB).unknownCalls, 0);
  assert.deepEqual(repo.sessions(period, { scope: scopeB }).items, []);
  for (const scope of [scopeA, scopeB]) assert.ok(basis(repo, scope).blockers.includes('conflicting-events'));
  assert.deepEqual(basis(repo, scopeB).sourceContexts, [sourceB], 'the conflicting claimed source remains auditable');
});

test('malformed scopes cannot broaden queries or use wildcard prefixes', t => {
  const repo = memory(t);
  repo.ingest([record(1)]);
  const sessionId = repo.sessions(period).items[0].id;
  for (const scope of [null, [], {}, 'profile:', { sourceContextPrefix: null }, { sourceContextPrefix: '' },
    { sourceContextPrefix: 'profile:%:' }, { sourceContextPrefix: 'profile:aaaaaaaa_aaaa_aaaa_aaaa_aaaaaaaaaaaa:' },
    { sourceContextPrefix: 'profile:AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA:' },
    { sourceContextPrefix: `${scopeA.sourceContextPrefix}label` },
    { sourceContextPrefix: scopeA.sourceContextPrefix.slice(0, -1) }]) {
    assert.throws(() => repo.summary(period, verification, scope), /Invalid usage scope/);
    assert.throws(() => repo.sessions(period, { scope }), /Invalid usage scope/);
    assert.throws(() => repo.session(sessionId, verification, scope), /Invalid usage scope/);
    assert.throws(() => repo.session('missing', verification, scope), /Invalid usage scope/);
    assert.throws(() => basis(repo, scope), /Invalid usage scope/);
  }
});

test('scoped reconciliation uses exact finite bounds, scoped sources and distinct stable evidence hashes', t => {
  const repo = memory(t);
  const events = [
    at(1, '2026-08-31T23:59:59.999Z', { nanoAiu: '100' }),
    at(2, '2026-09-01T00:00:00.000Z', { nanoAiu: '9007199254740993' }),
    at(3, '2026-09-19T23:59:59.999Z', { nanoAiu: '7', sourceContext: sourceA2 }),
    at(4, cutoff, { nanoAiu: '200' }),
    record(5, 1, { nanoAiu: '9007199254741000', sourceContext: sourceB }),
    record(6, 1, { sourceContext: 'unverified-import' }),
  ];
  repo.ingest(events);
  const a = basis(repo, scopeA);
  const b = basis(repo, scopeB);
  assert.equal(a.knownNanoAiu, '9007199254741000');
  assert.equal(a.knownCalls, 2);
  assert.deepEqual(a.sourceContexts, [sourceA, sourceA2]);
  assert.deepEqual(a.blockers, []);
  assert.equal(b.knownNanoAiu, a.knownNanoAiu);
  assert.notEqual(b.ledgerHash, a.ledgerHash);
  assert.notEqual(basis(repo).ledgerHash, a.ledgerHash);
  assert.equal(basis(repo, scopeA, '2026-10-01T00:00:00.000Z').knownNanoAiu, '9007199254741200');
  repo.ingest(events);
  repo.ingestImport([], { fileKey: 'scope-test', fileIdentity: '1', generation: 0, offset: 10, prefixHash: 'synthetic' });
  repo.applyRetention(36500, new Date('2026-09-28T00:00:00.000Z'));
  assert.deepEqual(basis(repo, scopeA), a);
});

test('cross-profile ancestors cannot establish complete scoped root coverage', t => {
  const repo = memory(t);
  repo.ingest([
    record(1),
    record(2, 1, { operation: 'http_request', nanoAiu: null, sourceContext: sourceB }),
    record(2, 2, { parentSpanId: id(1), nanoAiu: '10' }),
  ]);
  const scoped = basis(repo, scopeA);
  assert.equal(scoped.knownCalls, 2, 'global classification remains unchanged');
  assert.ok(scoped.blockers.includes('unresolved-ancestry'));
  assert.deepEqual(basis(repo).blockers, [], 'the legacy global view has all of this ancestry');
  const missing = memory(t);
  missing.ingest([record(1), record(2, 2, { parentSpanId: id(99), operation: 'chat' })]);
  assert.ok(basis(missing, scopeA).blockers.includes('unresolved-ancestry'));
});

test('a conflicting copy with foreign attribution or a moved time cannot certify the original profile', t => {
  const repo = memory(t);
  repo.ingest([record(1), at(2, '2026-08-01T00:00:00.000Z')]);
  repo.ingest([record(2, 1, { sourceContext: sourceB })]);
  const result = basis(repo, scopeA);
  assert.equal(result.knownCalls, 1);
  assert.ok(result.blockers.includes('conflicting-events'));
  assert.deepEqual(result.sourceContexts, [sourceA]);
  const unrelated = memory(t);
  unrelated.ingest([record(1), record(2, 1, { sourceContext: sourceB })]);
  unrelated.ingest([record(2, 1, { sourceContext: sourceB, nanoAiu: '1' })]);
  assert.deepEqual(basis(unrelated, scopeA).blockers, [], 'a conflict attributable solely to another profile can be excluded');
});

test('unlocated events, source-less rejections and retention still conservatively block scoped completeness', t => {
  for (const kind of ['event', 'identity', 'import', 'retention']) {
    const repo = memory(t);
    repo.ingest([record(1)]);
    assert.deepEqual(basis(repo, scopeA).blockers, []);
    if (kind === 'event') repo.ingest([record(2, 1, { sourceContext: sourceB, endTime: null })]);
    if (kind === 'identity') repo.ingest([record(2, 1, { sourceContext: sourceB, traceId: '' })]);
    if (kind === 'import') repo.ingestImport([], { fileKey: 'bad', fileIdentity: '1', generation: 0, offset: 1, prefixHash: 'synthetic' }, 1);
    if (kind === 'retention') {
      repo.ingest([at(2, '2026-08-01T00:00:00.000Z', { sourceContext: sourceB })]);
      repo.applyRetention(1, new Date('2026-09-03T00:00:00.000Z'));
    }
    const result = basis(repo, scopeA);
    assert.equal(result.knownCalls, 1);
    assert.ok(result.blockers.includes(kind === 'event' ? 'unlocated-events' : kind === 'retention' ? 'retention-overlap' : 'unlocated-rejections'), kind);
  }
});
