import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../../dist/storage/repository.js';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { envelope, id, span } from '../fixtures/synthetic-otlp.mjs';

const verification = { cliVersion: '1.0.88', verifiedAt: '2026-09-28T00:00:00.000Z', evidence: 'Synthetic verification fixture' };
const records = (spans, version = '1.0.88') => parseOtlp(envelope(spans, version), 'synthetic-model-detail');

function memory(t) {
  const repository = new Repository(':memory:');
  t.after(() => repository.close());
  return repository;
}

const detail = (repository, verify = verification) => repository.session(repository.sessions('2026-09').items[0].id, verify);

test('model credits verification follows contributing chat versions rather than verified month roots', t => {
  const repository = memory(t);
  repository.ingest(records([span(1)]));
  repository.ingest(records([
    span(2, { parentSpanId: id(1), operation: 'chat', cost: '2000000000' }),
    span(3, { parentSpanId: id(1), operation: 'chat', cost: null }),
  ], '1.0.89'));
  assert.equal(repository.summary('2026-09', verification).unitVerified, true);
  const model = detail(repository).modelBreakdown[0];
  assert.equal(model.unitVerified, false);
  assert.equal(model.nanoAiu, '2000000000');
  assert.equal(model.unknownCalls, 1);
  assert.equal(model.calls, 2);
});

test('mixed contributing versions cannot verify a model subtotal, while each model stays independent', t => {
  const repository = memory(t);
  repository.ingest(records([
    span(1), span(2, { parentSpanId: id(1), operation: 'chat', cost: '1000000000' }),
    span(3, { parentSpanId: id(1), operation: 'chat', model: 'verified-model', cost: '0' }),
  ]));
  repository.ingest(records([span(4, { parentSpanId: id(1), operation: 'chat', cost: '2000000000' })], '1.0.89'));
  const models = detail(repository).modelBreakdown;
  assert.equal(models.find(model => model.model === 'synthetic-model-a').unitVerified, false);
  assert.equal(models.find(model => model.model === 'synthetic-model-a').nanoAiu, '3000000000');
  assert.equal(models.find(model => model.model === 'verified-model').unitVerified, true);
  assert.equal(models.find(model => model.model === 'verified-model').nanoAiu, '0');
  for (const verify of [null, { ...verification, evidence: '' }, { ...verification, verifiedAt: 'invalid' }]) {
    assert.equal(detail(repository, verify).modelBreakdown.some(model => model.unitVerified), false);
  }
});

test('invalid and conflicting chat costs remain unknown detail and never enter the known subtotal', t => {
  const repository = memory(t);
  repository.ingest(records([
    span(1), span(2, { parentSpanId: id(1), operation: 'chat', cost: '1000000000' }),
    span(3, { parentSpanId: id(1), operation: 'chat', cost: '2000000000', endTimeUnixNano: '-1' }),
    span(4, { parentSpanId: id(1), operation: 'chat', cost: '3000000000' }),
    span(5, { parentSpanId: id(1), operation: 'chat', cost: null }),
    span(6, { parentSpanId: id(1), operation: 'chat', model: 'unknown-only-model', cost: null }),
  ]));
  repository.ingest(records([span(4, { parentSpanId: id(1), operation: 'chat', cost: '4000000000' })]));
  const model = detail(repository).modelBreakdown[0];
  assert.equal(model.nanoAiu, '1000000000');
  assert.equal(model.calls, 4);
  assert.equal(model.unknownCalls, 3);
  assert.equal(model.unitVerified, true, 'only the known subtotal is unit-verified');
  const unknown = detail(repository).modelBreakdown.find(item => item.model === 'unknown-only-model');
  assert.equal(unknown.nanoAiu, null);
  assert.equal(unknown.unknownCalls, 1);
  assert.equal(unknown.unitVerified, false);
  assert.equal(detail(repository).lifetime.nanoAiu, '2500000000', 'chat amounts are never added to root totals');
});
