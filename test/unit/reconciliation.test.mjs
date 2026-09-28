import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileUsage } from '../../dist/domain/reconciliation.js';
import { hashAccountSnapshot, inspectReconciliation, reconciliationReport, verifyReconciliationEvidence, RECONCILIATION_EVIDENCE_MAX_AGE_MS } from '../../dist/domain/reconciliation-evidence.js';
import { officialSnapshotEligible } from '../../dist/domain/display.js';
import { adaptQuota } from '../../dist/providers/quota.js';

const now = new Date('2026-09-28T12:00:00.000Z');
const period = '2025-01';
const sourceContexts = [`unverified:${'a'.repeat(64)}`, `unverified:${'b'.repeat(64)}`];
const account = (patch = {}) => ({
  source: 'sdk-quota', billingEntity: 'organization:test-org', usageSubject: 'organization:test-org', poolId: 'verified-pool',
  products: ['Copilot AI Credits'], periodStart: '2025-01-01T00:00:00.000Z', periodEnd: '2025-02-01T00:00:00.000Z',
  billingMode: 'ai-credits', unit: 'ai-credits', used: '12.5', coverage: 'complete', state: 'known', limit: '100', limitKind: 'official',
  verifiedAt: '2025-01-20T10:00:00.000Z', fetchedAt: now.toISOString(), providerUpdatedAt: '2025-01-20T09:00:00.000Z', stale: false, lastError: null,
  ...patch,
});
const basis = (patch = {}) => ({
  period, cutoff: account().providerUpdatedAt, sourceContexts: [...sourceContexts], knownNanoAiu: '10000000000',
  knownCalls: 2, unknownCalls: 0, pendingCalls: 0, unitVerified: true, blockers: [], ledgerHash: 'c'.repeat(64), ...patch,
});
const proof = (local = basis(), official = account(), at = now) => ({
  ...inspectReconciliation(local, official, at).template, verifiedAt: at.toISOString(), identityVerified: true, poolVerified: true,
  productsVerified: true, timeCoverageVerified: true, evidence: 'Synthetic explicit identity, pool, products and complete half-open coverage verification.',
});
const complete = { identityVerified: true, poolVerified: true, productsVerified: true, timeCoverageVerified: true };

test('inspection provides a non-asserting template for an actual historical snapshot and clear missing prerequisites', () => {
  const inspected = inspectReconciliation(basis(), account(), now);
  assert.equal(inspected.report.state, 'unknown'); assert.equal(inspected.report.evidencePresent, false);
  assert.equal(inspected.template.verifiedAt, ''); assert.equal(inspected.template.evidence, '');
  for (const key of Object.keys(complete)) assert.equal(inspected.template[key], false);
  assert.equal(inspected.template.coverageStart, account().periodStart); assert.equal(inspected.template.coverageEnd, basis().cutoff);
  assert.deepEqual(inspected.template.sourceContexts, sourceContexts);
  assert.equal(inspectReconciliation(basis(), null, now).template, null);
  assert.match(inspectReconciliation(basis({ cutoff: null }), account(), now).report.reason, /截止时间/);
  assert.equal(inspectReconciliation(basis({ cutoff: null }), account(), now).report.timeLimited, true);
  assert.equal(inspectReconciliation(basis({ blockers: ['unlocated-events'] }), account(), now).template, null);
});

test('verification uses ledger and account amounts, persists only valid evidence, and preserves decimal residual signs', () => {
  const local = basis(); const official = account(); const input = proof(local, official);
  const verified = verifyReconciliationEvidence(input, local, official, now);
  assert.equal(verified.accepted, true); assert.notEqual(verified.evidence, input);
  assert.equal(verified.report.localUsed, '10'); assert.equal(verified.report.accountUsed, '12.5');
  assert.equal(verified.report.difference, '2.5'); assert.equal(verified.report.label, '暂未归属'); assert.equal(verified.report.timeLimited, false);
  const higher = basis({ knownNanoAiu: '13000000000' });
  assert.equal(reconciliationReport(higher, official, proof(higher, official), now).label, '尚未对齐');
  const equal = basis({ knownNanoAiu: '12500000000' });
  assert.equal(reconciliationReport(equal, official, proof(equal, official), now).difference, '0');
  assert.equal(reconciliationReport(equal, official, proof(equal, official), now).label, '已对齐');
  const reordered = { ...input, sourceContexts: [...input.sourceContexts].reverse() };
  assert.equal(verifyReconciliationEvidence(reordered, local, official, now).accepted, true);
});

test('a complete historical month accepts its exclusive end and verification after the month', () => {
  const selected = { kind: 'organization', login: 'test-org' };
  const quotaEvidence = {
    billingEntity: 'organization:test-org', usageSubject: 'organization:test-org', poolId: 'verified-pool', period,
    poolKind: 'monthly-account', billingMode: 'ai-credits', unit: 'ai-credits', products: ['Copilot AI Credits'],
    identityVerified: true, unitVerified: true, allowanceVerified: true, coverageVerified: true, officialPageCompared: true,
    allowance: '100', unlimited: false, verifiedAt: now.toISOString(), providerUpdatedAt: account().periodEnd,
    evidence: 'Synthetic historical monthly account page comparison.',
  };
  const raw = { usedRequests: '12.5', entitlementRequests: '100', isUnlimited: false, resetDate: account().periodEnd };
  const adapted = adaptQuota(raw, quotaEvidence, selected, period, now);
  assert.equal(adapted.capability.supported, true);
  assert.equal(officialSnapshotEligible(adapted.snapshot, period, undefined, now), true);
  const local = basis({ cutoff: account().periodEnd });
  const verified = verifyReconciliationEvidence(proof(local, adapted.snapshot), local, adapted.snapshot, now);
  assert.equal(verified.accepted, true); assert.equal(verified.report.difference, '2.5');
  assert.equal(verified.report.cutoff, account().periodEnd);

  const beyond = '2025-02-01T00:00:00.001Z';
  assert.equal(adaptQuota(raw, { ...quotaEvidence, providerUpdatedAt: beyond }, selected, period, now).capability.supported, false);
  assert.equal(officialSnapshotEligible({ ...adapted.snapshot, providerUpdatedAt: beyond }, period, undefined, now), false);
  assert.equal(reconciliationReport(basis({ cutoff: beyond }), { ...adapted.snapshot, providerUpdatedAt: beyond }, verified.evidence, now).state, 'unknown');

  const beforeMonthEnd = new Date('2025-01-31T23:59:59.999Z');
  const future = { ...quotaEvidence, verifiedAt: account().periodEnd };
  assert.equal(adaptQuota(raw, future, selected, period, beforeMonthEnd).capability.supported, false);
  const futureSnapshot = { ...adapted.snapshot, verifiedAt: account().periodEnd, fetchedAt: account().periodEnd };
  assert.equal(officialSnapshotEligible(futureSnapshot, period, undefined, beforeMonthEnd), false);
  assert.equal(reconciliationReport(local, futureSnapshot, verified.evidence, beforeMonthEnd).state, 'unknown');
});

test('evidence cannot supply amounts, omit sources, change snapshot facts or turn string flags into verification', () => {
  const local = basis(); const official = account(); const valid = proof();
  const invalid = [null, [], true, 'evidence', {},
    { ...valid, used: '1000' }, { ...valid, limit: '1000' }, { ...valid, ignored: true },
    { ...valid, identityVerified: 'false' }, { ...valid, timeCoverageVerified: false },
    { ...valid, sourceContexts: [sourceContexts[0]] }, { ...valid, sourceContexts: [sourceContexts[0], sourceContexts[0]] },
    { ...valid, sourceContexts: {} }, { ...valid, billingEntity: 'organization:other-org' }, { ...valid, poolId: 'other-pool' },
    { ...valid, period: '2025-02' }, { ...valid, products: [null] }, { ...valid, products: ['Spark'] }, { ...valid, products: 'Copilot AI Credits' },
    { ...valid, coverageStart: '2025-01-02T00:00:00.000Z' }, { ...valid, coverageEnd: '2025-01-20T09:00:01.000Z' },
    { ...valid, unit: 'USD' }, { ...valid, billingMode: 'premium-requests' }, { ...valid, evidence: 'unsafe\u0000text' },
    { ...valid, verifiedAt: {} }, { ...valid, verifiedAt: '2026-02-30T00:00:00Z' }];
  for (const input of invalid) {
    let result;
    assert.doesNotThrow(() => { result = verifyReconciliationEvidence(input, local, official, now); });
    assert.equal(result.accepted, false); assert.equal(result.evidence, null); assert.equal(result.report.state, 'unknown');
    assert.equal(result.report.difference, null); assert.ok(result.report.reason.length > 0);
  }
});

test('evidence expires after fifteen minutes and cannot predate its account fetch or claim a future verification', () => {
  const valid = proof();
  const beforeExpiry = new Date(now.getTime() + RECONCILIATION_EVIDENCE_MAX_AGE_MS - 1);
  assert.equal(reconciliationReport(basis(), account(), valid, beforeExpiry).state, 'comparable');
  const expired = reconciliationReport(basis(), account(), valid, new Date(now.getTime() + RECONCILIATION_EVIDENCE_MAX_AGE_MS));
  assert.equal(expired.state, 'unknown'); assert.match(expired.reason, /15 分钟/); assert.ok(expired.expiresAt);
  assert.match(reconciliationReport(basis(), account(), { ...valid, verifiedAt: new Date(now.getTime() - 1).toISOString() }, now).reason, /早于/);
  assert.match(reconciliationReport(basis(), account(), { ...valid, verifiedAt: new Date(now.getTime() + 1).toISOString() }, now).reason, /晚于/);
});

test('the entire ledger state, source set and entire account snapshot are part of verification', () => {
  const valid = proof();
  assert.match(reconciliationReport(basis({ ledgerHash: 'd'.repeat(64) }), account(), valid, now).reason, /账本/);
  assert.match(reconciliationReport(basis({ sourceContexts: [...sourceContexts, 'unverified:new-source'] }), account(), valid, now).reason, /来源集合/);
  for (const patch of [{ used: '13' }, { limit: '200' }, { stale: true }, { lastError: { code: 'OFFLINE', message: 'Synthetic failure' } }, { retryAt: now.toISOString() }]) {
    assert.notEqual(hashAccountSnapshot(account()), hashAccountSnapshot(account(patch)));
    assert.match(reconciliationReport(basis(), account(patch), valid, now).reason, /账户快照已改变/);
  }
  const reversed = Object.fromEntries(Object.entries(account()).reverse());
  assert.equal(hashAccountSnapshot(account()), hashAccountSnapshot(reversed));
  const stale = account({ stale: true });
  const staleResult = reconciliationReport(basis(), stale, proof(basis(), stale), now);
  assert.equal(staleResult.state, 'comparable'); assert.equal(staleResult.timeLimited, true); assert.match(staleResult.reason, /陈旧/);
});

test('unknown metering, retention, unsupported units and incomplete account scope cannot be certified away', () => {
  const valid = proof();
  for (const patch of [
    { unknownCalls: 1 }, { pendingCalls: 1 }, { unitVerified: false }, { knownCalls: 0, knownNanoAiu: null },
    { blockers: ['retention-overlap'] }, { blockers: ['unlocated-rejections'] }, { blockers: ['conflicting-events'] },
    { blockers: ['unlocated-events'] }, { blockers: ['new-unrecognized-blocker'] }, { ledgerHash: null },
  ]) assert.equal(verifyReconciliationEvidence(valid, basis(patch), account(), now).accepted, false);
  for (const patch of [
    { source: 'billing-rest', coverage: 'partial', poolId: null, limit: null, limitKind: 'unknown' },
    { billingMode: 'premium-requests', unit: 'premium-requests' }, { providerUpdatedAt: null },
    { providerUpdatedAt: '2025-01-21T00:00:00.000Z' }, { fetchedAt: '2099-01-01T00:00:00.000Z' },
  ]) assert.equal(verifyReconciliationEvidence(valid, basis(), account(patch), now).accepted, false);
});

test('the underlying comparison rejects malformed evidence, identity, units, products and timestamps without throwing', () => {
  const official = account(); const local = { ...official, source: 'local-otel', used: '10' };
  for (const value of [null, {}, { ...complete, identityVerified: 'false' }]) {
    assert.equal(reconcileUsage(local, official, value, now).state, 'unknown');
  }
  for (const patch of [
    { billingEntity: '', usageSubject: '' }, { unit: 'USD' }, { products: [null] }, { products: {} }, { products: 'ab' },
    { periodStart: null }, { providerUpdatedAt: '2025-02-01T00:00:00.001Z' },
    { fetchedAt: '2024-12-31T23:59:59.000Z', providerUpdatedAt: null }, { fetchedAt: '2099-01-01T00:00:00.000Z' },
  ]) {
    let result;
    assert.doesNotThrow(() => { result = reconcileUsage({ ...local, ...patch }, { ...official, ...patch }, complete, now); });
    assert.equal(result.state, 'unknown');
  }
  assert.equal(reconcileUsage({ ...local, source: 'sdk-quota' }, official, complete, now).state, 'unknown');
});

test('valid exact operands cannot throw when their residual has more digits than either input', () => {
  for (const [used, localUsed] of [['1e256', '0'], ['9'.repeat(256), '0.1']]) {
    const official = account({ used }); const local = { ...official, source: 'local-otel', used: localUsed };
    let result;
    assert.doesNotThrow(() => { result = reconcileUsage(local, official, complete, now); });
    assert.equal(result.state, 'comparable'); assert.equal(result.label, '暂未归属'); assert.ok(result.difference.length >= 256);
  }
});
