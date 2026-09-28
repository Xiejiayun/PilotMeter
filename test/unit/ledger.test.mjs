import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Repository } from '../../dist/storage/repository.js';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { attr, envelope, id, nanos, span } from '../fixtures/synthetic-otlp.mjs';

const records = (spans, version) => parseOtlp(envelope(spans, version), 'synthetic-source');
const verify = { cliVersion: '1.0.88', verifiedAt: '2026-09-28T00:00:00.000Z', evidence: 'Synthetic test configuration; not real verification' };

function memory(t) {
  const repository = new Repository(':memory:');
  t.after(() => repository.close());
  return repository;
}

test('empty ledger is unknown and an explicitly observed zero is known', t => {
  const repository = memory(t);
  assert.deepEqual(repository.summary('2026-09'), { period: '2026-09', nanoAiu: null, knownCalls: 0,
    unknownCalls: 0, pendingCalls: 0, sessionCount: 0, coverage: 'empty', unitVerified: false, credits: null });
  repository.ingest(records([span(1, { cost: '0' })]));
  assert.equal(repository.summary('2026-09').nanoAiu, '0');
  assert.equal(repository.summary('2026-09', verify).credits, '0');
});

test('OTLP hierarchy, uppercase IDs and AnyValue metadata normalize without content', () => {
  const fixture = envelope([span(1, { traceId: 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB',
    attributes: [attr('gen_ai.input.messages', 'SECRET PROMPT'), attr('github.token', 'SECRET TOKEN')],
    name: 'SECRET SPAN NAME', events: [{ name: 'SECRET EVENT' }] })]);
  fixture.resourceSpans[0].resource.attributes.push(attr('process.command_args', 'SECRET ARGS'));
  fixture.resourceSpans[0].scopeSpans[0].scope.attributes = [attr('gen_ai.request.model', 'scope-model')];
  const parsed = parseOtlp(fixture, 'source');
  assert.equal(parsed[0].traceId, 'abcdefabcdefabcdefabcdefabcdefab');
  assert.equal(parsed[0].serviceVersion, '1.0.88');
  assert.equal(parsed[0].nanoAiu, '2500000000');
  assert.equal(parsed[0].inputTokens, '10');
  assert.equal(JSON.stringify(parsed).includes('SECRET'), false);
  assert.throws(() => parseOtlp({ spans: [] }, 'source'), /resourceSpans/);
  assert.throws(() => parseOtlp({ resourceSpans: [{}] }, 'source'), /scopeSpans/);
});

test('root, child chat and subagent costs are counted once across batches', t => {
  const repository = memory(t);
  repository.ingest(records([span(3, { parentSpanId: id(2), cost: '9000000000', model: 'synthetic-model-b' })]));
  assert.equal(repository.summary('2026-09').pendingCalls, 1);
  assert.equal(repository.summary('2026-09').nanoAiu, null);
  repository.ingest(records([span(2, { parentSpanId: id(1), operation: 'chat', cost: '7000000000' })]));
  assert.equal(repository.summary('2026-09').pendingCalls, 1);
  repository.ingest(records([span(1, { cost: '42000000000' })]));
  const usage = repository.summary('2026-09');
  assert.equal(usage.nanoAiu, '42000000000');
  assert.equal(usage.knownCalls, 1);
  assert.equal(usage.pendingCalls, 0);
  const detail = repository.session(repository.sessions('2026-09').items[0].id);
  assert.deepEqual(detail.models, ['synthetic-model-a', 'synthetic-model-b']);
  assert.equal(detail.events.find(event => event.spanId === id(3)).classification, 'child');
  assert.equal(detail.modelBreakdown[0].nanoAiu, '7000000000');
  assert.equal(detail.lifetime.nanoAiu, '42000000000');
});

test('a full known non-agent ancestor chain supports root classification', t => {
  const repository = memory(t);
  repository.ingest(records([span(2, { parentSpanId: id(1) })]));
  repository.ingest(records([span(1, { operation: 'http_request', cost: null })]));
  assert.equal(repository.summary('2026-09').knownCalls, 1);
  assert.equal(repository.summary('2026-09').nanoAiu, '2500000000');
});

test('late conflicting ancestor quarantines previously counted usage with a correction diagnostic', t => {
  const repository = memory(t);
  repository.ingest(records([span(1, { operation: 'http_request', cost: null }), span(2, { parentSpanId: id(1) })]));
  assert.equal(repository.summary('2026-09').knownCalls, 1);
  repository.ingest(records([span(1, { operation: 'invoke_agent', cost: '3000000000' })]));
  assert.equal(repository.summary('2026-09').knownCalls, 0);
  assert.equal(repository.summary('2026-09').nanoAiu, null);
  assert.equal(repository.summary('2026-09').unknownCalls, 1);
  assert.ok(repository.diagnostics().some(item => item.code === 'classification-corrected'));
});

test('global trace/span identity survives source changes and process restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-ledger-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'usage.sqlite');
  let repository = new Repository(path);
  assert.equal(repository.ingest(records([span()])).accepted, 1);
  repository.close();
  repository = new Repository(path);
  assert.equal(repository.ingest(parseOtlp(envelope(), 'another-import-entrance')).duplicates, 1);
  assert.equal(repository.summary('2026-09').knownCalls, 1);
  assert.equal(repository.sessions('2026-09').items.length, 1);
  repository.close();
});

test('same IDs with conflicting cost, session, version or model metadata are quarantined', t => {
  for (const change of [{ cost: '3000000000' }, { session: 'another-session' }, { model: 'another-model' }, { parentSpanId: id(2) }]) {
    const repository = new Repository(':memory:');
    repository.ingest(records([span()]));
    assert.equal(repository.ingest(records([span(1, change)])).conflicts, 1);
    assert.equal(repository.summary('2026-09').nanoAiu, null);
    assert.equal(repository.summary('2026-09').unknownCalls, 1);
    repository.ingest(records([span()]));
    assert.equal(repository.summary('2026-09').nanoAiu, null, 'replaying original data cannot clear quarantine');
    repository.close();
  }
  const repository = memory(t);
  repository.ingest(records([span()]));
  assert.equal(repository.ingest(records([span()], '1.0.89')).conflicts, 1);
  assert.equal(repository.summary('2026-09').knownCalls, 0);
});

test('orphan, invalid server markers, future CLI and cycles never become counted roots', t => {
  const repository = memory(t);
  repository.ingest(records([
    span(1, { parentSpanId: id(99) }),
    span(2, { attributes: [attr('server.port', '0', 'intValue')] }),
    span(3, { attributes: [attr('server.address', 'https://example.test/token')] }),
    span(4, { parentSpanId: id(4) }),
  ]));
  repository.ingest(records([span(5)], '1.0.89'));
  const usage = repository.summary('2026-09');
  assert.equal(usage.nanoAiu, null);
  assert.equal(usage.knownCalls, 0);
  assert.equal(usage.pendingCalls, 4);
  assert.equal(usage.unknownCalls, 1);
});

test('BigInt aggregates exactly above the safe integer limit and conversion is version scoped', t => {
  const repository = memory(t);
  repository.ingest(records([span(1, { cost: '9007199254740993' }), span(2, { cost: '7' })]));
  assert.equal(repository.summary('2026-09').nanoAiu, '9007199254741000');
  assert.equal(repository.summary('2026-09').credits, null);
  assert.equal(repository.summary('2026-09', verify).credits, '9007199.254741');
  assert.equal(repository.summary('2026-09', { ...verify, cliVersion: '1.0.89' }).credits, null);
  assert.equal(repository.summary('2026-09', { ...verify, evidence: '' }).credits, null);
});

test('missing, negative, unsafe, decimal and malformed AnyValue cost is unknown, never zero', t => {
  const repository = memory(t);
  const invalid = [null, '-1', 9007199254740992, '1.5', 'not-cost'];
  repository.ingest(records(invalid.map((cost, index) => span(index + 1, { cost }))));
  const malformed = span(6);
  malformed.attributes.find(item => item.key === 'github.copilot.nano_aiu').value = { arrayValue: { values: [] } };
  repository.ingest(records([malformed]));
  assert.equal(repository.summary('2026-09').nanoAiu, null);
  assert.equal(repository.summary('2026-09').knownCalls, 0);
  assert.equal(repository.summary('2026-09').unknownCalls, 6);
  assert.ok(repository.diagnostics().some(item => item.code === 'invalid-metadata'));
});

test('invalid identifiers are rejected and malformed end times never leak into month totals', t => {
  const repository = memory(t);
  const result = repository.ingest(records([span(1, { traceId: 'not-a-trace' }), span(2, { endTimeUnixNano: '-5' })]));
  assert.equal(result.rejected, 1);
  assert.equal(result.accepted, 1);
  assert.equal(repository.summary('2026-09').nanoAiu, null);
  assert.ok(repository.diagnostics().some(item => item.code === 'invalid-metadata'));
});

test('UTC month boundaries and late backfill remain separate from lifetime totals', t => {
  const repository = memory(t);
  repository.ingest(records([
    span(1, { cost: '1', startTimeUnixNano: nanos('2026-08-31T23:59:59.000Z'), endTimeUnixNano: nanos('2026-08-31T23:59:59.999Z') }),
    span(2, { cost: '2', startTimeUnixNano: nanos('2026-08-31T23:59:59.999Z'), endTimeUnixNano: nanos('2026-09-01T00:00:00.000Z') }),
    span(3, { cost: '4', startTimeUnixNano: nanos('2026-09-30T23:59:59.999Z'), endTimeUnixNano: nanos('2026-10-01T00:00:00.000Z') }),
  ]));
  assert.equal(repository.summary('2026-08').nanoAiu, '1');
  assert.equal(repository.summary('2026-09').nanoAiu, '2');
  assert.equal(repository.summary('2026-10').nanoAiu, '4');
  const detail = repository.session(repository.sessions('2026-09').items[0].id);
  assert.equal(detail.lifetime.nanoAiu, '7');
  assert.equal(detail.monthly['2026-09'].nanoAiu, '2');
  assert.throws(() => repository.summary('2026-13'), /Invalid UTC month/);
});

test('session pagination sorts arbitrary precision usage and binds cursors to month and sort', t => {
  const repository = memory(t);
  repository.ingest(records([span(1, { session: 'first', cost: '9007199254740993' }), span(2, { session: 'second', cost: '9007199254740994' }), span(3, { session: 'third', cost: null })]));
  const page1 = repository.sessions('2026-09', { sort: 'usage', limit: 1 });
  assert.equal(page1.items[0].sessionId, 'second');
  const page2 = repository.sessions('2026-09', { sort: 'usage', limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.items[0].sessionId, 'first');
  const page3 = repository.sessions('2026-09', { sort: 'usage', cursor: page2.nextCursor });
  assert.equal(page3.items[0].sessionId, 'third');
  assert.equal(page3.nextCursor, null);
  assert.throws(() => repository.sessions('2026-10', { sort: 'usage', cursor: page1.nextCursor }), /cursor/);
  assert.throws(() => repository.sessions('2026-09', { cursor: page1.nextCursor }), /cursor/);
  assert.equal(repository.session('missing-id'), null);
});

test('database persistence and diagnostics never retain rejected content or extra object properties', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-privacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'usage.sqlite');
  const repository = new Repository(path);
  const data = records([span(1, { attributes: [attr('gen_ai.input.messages', 'SYNTHETIC_SECRET_PROMPT')] })]);
  data[0].prompt = 'SYNTHETIC_SECRET_DIRECT';
  data[0].invalidReason = 'SYNTHETIC_SECRET_ERROR';
  repository.ingest(data);
  repository.close();
  const bytes = readFileSync(path).toString('utf8');
  assert.equal(bytes.includes('SYNTHETIC_SECRET'), false);
});
