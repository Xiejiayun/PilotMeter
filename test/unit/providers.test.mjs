import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecimals, subtractDecimals, normalizeDecimal, nonNegativeDecimal, percentageOf, nanoToCredits } from '../../dist/domain/decimal.js';
import { monthlyPeriod, utcMonth, timestamp } from '../../dist/domain/period.js';
import { buildDisplay, officialSnapshotEligible } from '../../dist/domain/display.js';
import { reconcileUsage } from '../../dist/domain/reconciliation.js';
import { BillingProvider, mapBillingReport, BILLING_REQUIREMENTS } from '../../dist/providers/billing.js';
import { adaptQuota } from '../../dist/providers/quota.js';
import { RefreshScheduler } from '../../dist/providers/scheduler.js';

const period = '2026-09';
const now = new Date('2026-09-20T10:00:00.000Z');
const org = { kind: 'organization', login: 'test-org' };
const user = { kind: 'user', login: 'test-user', directBilling: true };
const token = 'test-secret-do-not-persist';
const item = grossQuantity => ({ product: 'Copilot AI Credits', sku: 'AI Credit', unitType: 'ai-credits', grossQuantity, netAmount: 0 });
const report = (account = org, items = [item('12.5')]) => ({
  [account.kind === 'organization' ? 'organization' : account.kind === 'enterprise' ? 'enterprise' : 'user']: account.login,
  timePeriod: { year: 2026, month: 9 }, usageItems: items,
});
const response = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
const local = (overrides = {}) => ({ period, nanoAiu: '12500000000', knownCalls: 1, unknownCalls: 0, pendingCalls: 0, sessionCount: 1, coverage: 'partial', unitVerified: true, credits: '12.5', ...overrides });
const settings = (overrides = {}) => ({ monthlyBudget: null, unitVerification: { cliVersion: 'test', verifiedAt: now.toISOString(), evidence: 'test evidence' }, account: org, demo: false, ...overrides });
const evidence = (overrides = {}) => ({
  billingEntity: 'organization:test-org', usageSubject: 'organization:test-org', poolId: 'verified-shared-pool', period,
  poolKind: 'monthly-account', billingMode: 'ai-credits', unit: 'ai-credits', products: ['Copilot AI Credits'],
  identityVerified: true, unitVerified: true, allowanceVerified: true, coverageVerified: true, officialPageCompared: true,
  allowance: '100', unlimited: false, verifiedAt: '2026-09-20T09:59:00.000Z', providerUpdatedAt: '2026-09-20T09:58:00.000Z', evidence: 'Synthetic official-page verification for tests',
  ...overrides,
});
const quota = (overrides = {}) => ({ usedRequests: '105', entitlementRequests: '100', resetDate: '2026-10-01T00:00:00.000Z', isUnlimited: false, ...overrides });
const official = () => adaptQuota(quota(), evidence(), org, period, now).snapshot;

test('decimal arithmetic preserves fractions, unsafe-sized quantities, exponents and overage', () => {
  assert.equal(addDecimals('0.1', '0.2'), '0.3');
  assert.equal(addDecimals('9007199254740993.123456789', '0.000000001'), '9007199254740993.12345679');
  assert.equal(subtractDecimals('0.1', '0.2'), '-0.1');
  assert.equal(normalizeDecimal('1.2300e-4'), '0.000123');
  assert.equal(normalizeDecimal('12e3'), '12000');
  assert.equal(nanoToCredits('9007199254740993123456789'), '9007199254740993.123456789');
  assert.equal(percentageOf('105', '100'), '105.0');
  assert.equal(percentageOf('1', '6'), '16.7');
  assert.equal(percentageOf('0', '100'), '0.0');
  assert.equal(percentageOf('100', '0'), null);
  for (const value of ['NaN', 'Infinity', '1e999', ' 1', '1/2', '-1']) assert.throws(() => nonNegativeDecimal(value));
  assert.throws(() => nonNegativeDecimal(0.1));
});

test('UTC months use half-open calendar boundaries without local timezone leakage', () => {
  assert.deepEqual(monthlyPeriod('2026-12'), { period: '2026-12', year: 2026, month: 12, start: '2026-12-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' });
  assert.equal(utcMonth('2026-10-01T07:59:59+08:00'), '2026-09');
  assert.equal(utcMonth('2026-10-01T08:00:00+08:00'), '2026-10');
  for (const value of ['2026-00', '2026-13', '2026-9', '0000-01', '../2026-01']) assert.throws(() => monthlyPeriod(value));
  assert.equal(timestamp('2026-02-30T00:00:00Z'), null);
  assert.equal(timestamp('2026-09-01'), null);
});

test('empty, unknown and unverified-unit local data never turn into a percentage', () => {
  const empty = buildDisplay(local({ knownCalls: 0, nanoAiu: '0', credits: '0', coverage: 'empty' }), null, settings({ monthlyBudget: '100' }));
  assert.equal(empty.mode, 'usage'); assert.equal(empty.used, null); assert.equal(empty.percentage, null);
  const unverified = buildDisplay(local({ unitVerified: false }), null, settings({ monthlyBudget: '100' }));
  assert.equal(unverified.unit, 'nano-aiu'); assert.equal(unverified.used, '12500000000'); assert.equal(unverified.percentage, null);
  const unknown = buildDisplay(local({ credits: null, nanoAiu: null, knownCalls: 0, unknownCalls: 3 }), null, settings());
  assert.equal(unknown.used, null); assert.equal(unknown.percentage, null);
});

test('custom budget always names its local numerator and supports zero and overage', () => {
  const custom = buildDisplay(local({ credits: '105', unknownCalls: 2 }), null, settings({ monthlyBudget: '100' }));
  assert.equal(custom.mode, 'custom'); assert.equal(custom.percentage, '105.0'); assert.equal(custom.scope, '本机已记录会话');
  assert.match(custom.reason, /已知用量小计/);
  const zero = buildDisplay(local(), null, settings({ monthlyBudget: '0' }));
  assert.equal(zero.mode, 'custom'); assert.equal(zero.percentage, null); assert.equal(zero.reason, '预算为 0');
});

test('official mode requires verified identity, pool, units, monthly coverage, allowance and timestamp', () => {
  const valid = official();
  assert.equal(buildDisplay(local(), valid, settings()).percentage, '105.0');
  assert.equal(buildDisplay(local(), valid, settings()).mode, 'official');
  const invalid = [
    { coverage: 'partial' }, { poolId: null }, { verifiedAt: null }, { unit: 'credits' }, { billingMode: 'unknown' },
    { source: 'local-otel' }, { limitKind: 'custom' }, { usageSubject: 'user:test-user' }, { billingEntity: 'organization:other-org' },
    { periodStart: '2026-08-01T00:00:00.000Z' }, { periodEnd: '2026-09-21T00:00:00.000Z' },
    { verifiedAt: '2026-08-31T23:59:59.000Z' }, { verifiedAt: '2026-09-21T00:00:00.000Z' }, { used: '-1' },
  ];
  for (const override of invalid) assert.equal(buildDisplay(local(), { ...valid, ...override }, settings()).mode, 'usage', JSON.stringify(override));
  assert.equal(buildDisplay(local(), valid, settings({ account: null })).mode, 'usage');
  assert.equal(buildDisplay(local(), { ...valid, billingEntity: 'user:test-user', usageSubject: 'user:test-user' }, settings({ account: { ...user, directBilling: false } })).mode, 'usage');
  assert.equal(officialSnapshotEligible(valid, '2026-10'), false);
});

test('official zero, unlimited and stale snapshots retain their distinct meanings', () => {
  const valid = official();
  const zero = buildDisplay(local(), { ...valid, limit: '0' }, settings());
  assert.equal(zero.percentage, null); assert.equal(zero.reason, '额度为 0');
  const unlimited = buildDisplay(local(), { ...valid, limit: null, limitKind: 'unlimited' }, settings());
  assert.equal(unlimited.mode, 'official'); assert.equal(unlimited.percentage, null); assert.equal(unlimited.reason, '无固定上限');
  const stale = buildDisplay(local(), { ...valid, stale: true }, settings());
  assert.equal(stale.percentage, '105.0'); assert.match(stale.reason, /陈旧/);
  const staleZero = buildDisplay(local(), { ...valid, limit: '0', stale: true }, settings());
  assert.equal(staleZero.percentage, null); assert.match(staleZero.reason, /额度为 0/); assert.match(staleZero.reason, /陈旧/);
  const staleUnlimited = buildDisplay(local(), { ...valid, limit: null, limitKind: 'unlimited', stale: true }, settings());
  assert.equal(staleUnlimited.percentage, null); assert.match(staleUnlimited.reason, /无固定上限/); assert.match(staleUnlimited.reason, /陈旧/);
  const knownZero = buildDisplay(local(), { ...valid, used: '0' }, settings());
  assert.equal(knownZero.percentage, '0.0');
});

test('billing counts gross quantity, never net charges, and stays partial without an allowance', () => {
  const result = mapBillingReport(report(org, [item('0.1'), item('0.2')]), org, period, now);
  assert.equal(result.used, '0.3'); assert.equal(result.state, 'known'); assert.equal(result.coverage, 'partial');
  assert.equal(result.poolId, null); assert.equal(result.limit, null); assert.equal(result.verifiedAt, null);
  assert.equal(buildDisplay(local(), result, settings()).mode, 'usage');
  const partial = mapBillingReport(report(org, [item('2'), { product: 'Spark', sku: 'unknown', unitType: 'ai-credits', grossQuantity: '100' }]), org, period, now);
  assert.equal(partial.used, '2'); assert.equal(partial.lastError.code, 'PRODUCTS_PARTIAL');
});

test('billing validates subject, returned year/month and every unrequested scope filter', () => {
  const invalid = [
    [{ ...report(), organization: 'somebody-else' }, 'SUBJECT_MISMATCH'],
    [{ ...report(), timePeriod: { year: 2026 } }, 'PERIOD_MISMATCH'],
    [{ ...report(), timePeriod: { year: 2026, month: 8 } }, 'PERIOD_MISMATCH'],
    [{ ...report(), timePeriod: { year: 2026, month: 9, day: 1 } }, 'PERIOD_MISMATCH'],
    [{ ...report(), model: 'GPT-5' }, 'FILTERED_REPORT'],
    [{ ...report(), user: 'test-user' }, 'FILTERED_REPORT'],
    [{ ...report(), product: 'Copilot AI Credits' }, 'FILTERED_REPORT'],
  ];
  for (const [body, code] of invalid) {
    const result = mapBillingReport(body, org, period, now);
    assert.equal(result.used, null); assert.equal(result.lastError.code, code);
  }
});

test('empty corporate/personal reports and unknown product units cannot imply zero', () => {
  for (const account of [org, user, { kind: 'enterprise', login: 'test-enterprise' }]) {
    const empty = mapBillingReport(report(account, []), account, period, now);
    assert.equal(empty.state, 'empty'); assert.equal(empty.used, null);
  }
  const companyPaidUser = { ...user, directBilling: false };
  assert.equal(mapBillingReport(report(user), companyPaidUser, period, now).lastError.code, 'BILLING_ENTITY_UNVERIFIED');
  const unknown = mapBillingReport(report(org, [{ product: 'Copilot', sku: 'Copilot AI Credits', unitType: 'credits', grossQuantity: '20' }]), org, period, now);
  assert.equal(unknown.state, 'unsupported'); assert.equal(unknown.used, null);
  for (const value of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, 'not-a-number']) {
    const invalid = mapBillingReport(report(org, [item(value)]), org, period, now);
    assert.equal(invalid.state, 'unsupported'); assert.equal(invalid.used, null);
  }
});

test('billing selects the correct endpoint, uses least-permission metadata, and confines authorization', async () => {
  const calls = [];
  const provider = new BillingProvider(async (url, init) => {
    calls.push({ url: new URL(url), init });
    const identity = url.pathname.startsWith('/users/') ? user : url.pathname.startsWith('/organizations/') ? org : { kind: 'enterprise', login: 'test-enterprise' };
    return response(report(identity));
  }, { now: () => now });
  for (const account of [user, org, { kind: 'enterprise', login: 'test-enterprise' }]) await provider.fetchSnapshot(account, period, token);
  assert.deepEqual(calls.map(call => call.url.pathname), ['/users/test-user/settings/billing/ai_credit/usage', '/organizations/test-org/settings/billing/ai_credit/usage', '/enterprises/test-enterprise/settings/billing/ai_credit/usage']);
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://api.github.com'); assert.equal(call.url.search, '?year=2026&month=9');
    assert.equal(call.init.redirect, 'error'); assert.equal(call.init.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.url.toString().includes(token), false);
  }
  assert.equal(BILLING_REQUIREMENTS.user.permission, 'Plan: read');
  assert.equal(BILLING_REQUIREMENTS.organization.permission, 'Administration: read');
  assert.equal(BILLING_REQUIREMENTS.enterprise.fineGrainedPat, false);
  await assert.rejects(() => provider.fetchSnapshot({ ...org, login: 'test-org/../../evil' }, period, token));
  assert.equal(calls.length, 3);
});

test('corporate-paid personal identity is blocked before any request', async () => {
  let calls = 0;
  const provider = new BillingProvider(async () => { calls++; return response(report(user, [])); }, { now: () => now });
  const result = await provider.fetchSnapshot({ ...user, directBilling: false }, period, token);
  assert.equal(calls, 0); assert.equal(result.used, null); assert.equal(result.lastError.code, 'BILLING_ENTITY_UNVERIFIED');
});

test('JSON numeric source text preserves every decimal digit before parsing to BigInt', async () => {
  const body = '{"organization":"test-org","timePeriod":{"year":2026,"month":9},"usageItems":[{"product":"Copilot AI Credits","sku":"AI Credit","unitType":"ai-credits","grossQuantity":9007199254740993.123456789},{"product":"Copilot AI Credits","sku":"AI Credit","unitType":"ai-credits","grossQuantity":0.000000001}]}';
  const provider = new BillingProvider(async () => response(body), { now: () => now });
  const result = await provider.fetchSnapshot(org, period, token);
  assert.equal(result.used, '9007199254740993.12345679');
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('concurrent manual billing refreshes share one request and callers cannot mutate the cache', async () => {
  let resolve; let calls = 0;
  const provider = new BillingProvider(async () => { calls++; await new Promise(done => { resolve = done; }); return response(report()); }, { now: () => now });
  const first = provider.fetchSnapshot(org, period, token); const second = provider.fetchSnapshot(org, period, token);
  resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1); a.used = '999'; assert.equal(b.used, '12.5');
  assert.equal((await provider.fetchSnapshot(org, period, token)).used, '12.5'); assert.equal(calls, 1);
});

test('429 respects retry hints, preserves the last successful value, and retries when due', async () => {
  let current = now.getTime(); let calls = 0;
  const provider = new BillingProvider(async () => {
    calls++;
    return calls === 2 ? response({ message: token }, { status: 429, headers: { 'Retry-After': '120' } }) : response(report(org, [item(calls === 1 ? '12.5' : '15')]));
  }, { now: () => new Date(current), minIntervalMs: 0 });
  const fresh = await provider.fetchSnapshot(org, period, token);
  current += 1000;
  const limited = await provider.fetchSnapshot(org, period, token);
  assert.equal(limited.used, '12.5'); assert.equal(limited.fetchedAt, fresh.fetchedAt); assert.equal(limited.stale, true);
  assert.equal(limited.lastError.code, 'RATE_LIMITED'); assert.equal(JSON.stringify(limited).includes(token), false);
  assert.equal(provider.nextRetryAt(org, period), new Date(current + 120000).toISOString());
  current += 119999; await provider.fetchSnapshot(org, period, token); assert.equal(calls, 2);
  current++; const recovered = await provider.fetchSnapshot(org, period, token);
  assert.equal(calls, 3); assert.equal(recovered.used, '15'); assert.equal(recovered.stale, false);
});

test('403 stops automatically retrying until an explicit resume', async () => {
  let current = now.getTime(); let calls = 0;
  const provider = new BillingProvider(async () => { calls++; return response({ message: token }, { status: 403 }); }, { now: () => new Date(current) });
  const denied = await provider.fetchSnapshot(org, period, token);
  current += 86400000; await provider.fetchSnapshot(org, period, token);
  assert.equal(calls, 1); assert.equal(denied.used, null); assert.equal(denied.lastError.code, 'PERMISSION_DENIED');
  assert.equal(provider.nextRetryAt(org, period), null); assert.equal(JSON.stringify(denied).includes(token), false);
  provider.resume(org, period); await provider.fetchSnapshot(org, period, token); assert.equal(calls, 2);
});

test('403 rate limits honor retry headers and recover without a permission resume', async () => {
  for (const headers of [
    { 'Retry-After': '120' },
    { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(now.getTime() / 1000 + 120) },
  ]) {
    let current = now.getTime(); let calls = 0;
    const provider = new BillingProvider(async () => {
      calls++;
      return calls === 1 ? response({}, { status: 403, headers }) : response(report());
    }, { now: () => new Date(current) });
    const scheduler = new RefreshScheduler({ now: () => current });
    const refresh = () => scheduler.refresh(() => provider.fetchSnapshot(org, period, token), { manual: true, retryAt: () => provider.nextRetryAt(org, period) });
    const limited = await refresh();
    assert.equal(limited.lastError.code, 'RATE_LIMITED');
    assert.equal(limited.retryAt, new Date(current + 120000).toISOString());
    assert.notEqual(scheduler.nextRefreshAt, null);
    current += 60000; await refresh(); assert.equal(calls, 1);
    current += 60000; const recovered = await refresh();
    assert.equal(calls, 2); assert.equal(recovered.state, 'known'); assert.equal(recovered.lastError, null);
  }
});

test('explicit reconnection cannot bypass rate limits or network backoff', async () => {
  for (const failure of [429, 403, 'network']) {
    let current = now.getTime(); let calls = 0;
    const provider = new BillingProvider(async () => {
      calls++;
      if (calls !== 1) return response(report());
      if (failure === 'network') throw new Error('offline');
      return response({}, { status: failure, headers: { 'Retry-After': '120' } });
    }, { now: () => new Date(current) });
    const failed = await provider.fetchSnapshot(org, period, token);
    const deadline = Date.parse(failed.retryAt);
    current = deadline - 1;
    provider.resume(org, period);
    const retained = await provider.fetchSnapshot(org, period, token);
    assert.equal(calls, 1); assert.equal(retained.lastError.code, failure === 'network' ? 'FETCH_FAILED' : 'RATE_LIMITED');
    assert.equal(provider.nextRetryAt(org, period), failed.retryAt);
    current++;
    assert.equal((await provider.fetchSnapshot(org, period, token)).state, 'known'); assert.equal(calls, 2);
  }
});

test('first and previously successful 429 snapshots preserve retry deadlines through restart', async () => {
  for (const hadKnownValue of [false, true]) {
    let current = now.getTime();
    const original = new BillingProvider(async () => response({}, { status: 429, headers: { 'Retry-After': '3600' } }), { now: () => new Date(current) });
    if (hadKnownValue) original.restoreSnapshot(mapBillingReport(report(), org, period, now));
    const limited = await original.fetchSnapshot(org, period, token);
    const persisted = JSON.parse(JSON.stringify(limited));
    assert.equal(persisted.retryAt, new Date(current + 3600000).toISOString());
    let calls = 0;
    const restarted = new BillingProvider(async () => { calls++; return response(report()); }, { now: () => new Date(current) });
    restarted.restoreSnapshot(persisted);
    current++;
    const retained = await restarted.fetchSnapshot(org, period, token);
    assert.equal(calls, 0); assert.equal(retained.lastError.code, 'RATE_LIMITED');
    assert.equal(retained.used, hadKnownValue ? '12.5' : null);
    assert.equal(retained.state, hadKnownValue ? 'known' : 'unknown');
    current += 3599998; await restarted.fetchSnapshot(org, period, token); assert.equal(calls, 0);
    current++;
    const recovered = await restarted.fetchSnapshot(org, period, token);
    assert.equal(calls, 1); assert.equal(recovered.lastError, null); assert.equal(recovered.stale, false);
    assert.equal(recovered.retryAt ?? null, null);
  }
});

test('ordinary permission failures remain paused across restart until explicit resume', async () => {
  for (const status of [401, 403]) {
    for (const hadKnownValue of [false, true]) {
      let current = now.getTime();
      const original = new BillingProvider(async () => response({}, { status }), { now: () => new Date(current) });
      if (hadKnownValue) original.restoreSnapshot(mapBillingReport(report(), org, period, now));
      const failed = await original.fetchSnapshot(org, period, token);
      assert.equal(failed.retryAt, null);
      let calls = 0;
      const restarted = new BillingProvider(async () => { calls++; return response(report()); }, { now: () => new Date(current) });
      restarted.restoreSnapshot(JSON.parse(JSON.stringify(failed)));
      current += 86400000;
      const retained = await restarted.fetchSnapshot(org, period, token);
      assert.equal(calls, 0); assert.equal(retained.lastError.code, status === 403 ? 'PERMISSION_DENIED' : 'AUTHENTICATION_FAILED');
      assert.equal(retained.used, hadKnownValue ? '12.5' : null);
      restarted.resume(org, period);
      assert.equal((await restarted.fetchSnapshot(org, period, token)).state, 'known'); assert.equal(calls, 1);
    }
  }
});

test('network backoff survives restart and is isolated to its billing identity and month', async () => {
  let current = now.getTime();
  const original = new BillingProvider(async () => { throw new Error('offline'); }, { now: () => new Date(current) });
  const failed = await original.fetchSnapshot(org, period, token);
  assert.equal(failed.retryAt, new Date(current + 30000).toISOString());
  let calls = 0;
  const restarted = new BillingProvider(async () => { calls++; return response(report()); }, { now: () => new Date(current) });
  restarted.restoreSnapshot(JSON.parse(JSON.stringify(failed)));
  current += 29999; await restarted.fetchSnapshot(org, period, token); assert.equal(calls, 0);
  await restarted.fetchSnapshot({ ...org, login: 'another-org' }, period, token); assert.equal(calls, 1);
  await restarted.fetchSnapshot(org, '2026-10', token); assert.equal(calls, 2);
  current++; await restarted.fetchSnapshot(org, period, token); assert.equal(calls, 3);
});

test('snapshot restoration rejects malformed identities, intervals and retry state safely', async () => {
  const baseline = { ...mapBillingReport(report(), org, period, now), retryAt: new Date(now.getTime() + 3600000).toISOString() };
  const invalid = [null, {}, { ...baseline, billingEntity: 'organization:../test-org' },
    { ...baseline, usageSubject: 'organization:another-org' }, { ...baseline, periodStart: null },
    { ...baseline, periodStart: '2026-00-01T00:00:00.000Z' }, { ...baseline, periodEnd: '2026-09-30T00:00:00.000Z' },
    { ...baseline, fetchedAt: 'not a timestamp' }, { ...baseline, state: 'other' }, { ...baseline, used: '-1' },
    { ...baseline, billingMode: 'unknown' }, { ...baseline, products: ['Spark'] }, { ...baseline, poolId: 'unverified' },
    { ...baseline, stale: 'false' }, { ...baseline, lastError: { code: {}, message: 'unsafe' } },
    { ...baseline, retryAt: '2026-02-30T00:00:00.000Z' }, { ...baseline, retryAt: 123 }];
  for (const snapshot of invalid) {
    let calls = 0;
    const provider = new BillingProvider(async () => { calls++; return response(report()); }, { now: () => now });
    assert.doesNotThrow(() => provider.restoreSnapshot(snapshot));
    assert.equal((await provider.fetchSnapshot(org, period, token)).state, 'known'); assert.equal(calls, 1);
  }
});

test('network errors are redacted, retain same-month snapshots, and never reuse last month as current', async () => {
  const previous = mapBillingReport(report(), org, period, now);
  const provider = new BillingProvider(async () => { throw new Error(`offline Authorization: ${token}`); }, { now: () => now });
  provider.restoreSnapshot(previous);
  const retained = await provider.fetchSnapshot(org, period, token);
  assert.equal(retained.used, previous.used); assert.equal(retained.stale, true); assert.equal(retained.fetchedAt, previous.fetchedAt);
  assert.equal(JSON.stringify(retained).includes(token), false);
  const nextMonth = await provider.fetchSnapshot(org, '2026-10', token);
  assert.equal(nextMonth.used, null); assert.equal(nextMonth.state, 'unknown'); assert.equal(nextMonth.periodStart, '2026-10-01T00:00:00.000Z');
});

test('redirects, oversized responses and mismatched new reports do not overwrite trusted values', async () => {
  for (const fake of [() => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }), () => response('{}', { headers: { 'Content-Length': String(3 * 1024 * 1024) } }), () => response({ ...report(), organization: 'wrong-org' })]) {
    let calls = 0;
    const provider = new BillingProvider(async () => { calls++; return fake(); }, { now: () => now });
    provider.restoreSnapshot(mapBillingReport(report(), org, period, now));
    const result = await provider.fetchSnapshot(org, period, token);
    assert.equal(calls, 1); assert.equal(result.used, '12.5'); assert.equal(result.stale, true); assert.ok(result.lastError);
  }
});

test('quota enables only a verified monthly pool and preserves dynamic allowance, unlimited and legacy units', () => {
  const result = adaptQuota(quota(), evidence(), org, period, now);
  assert.equal(result.capability.supported, true); assert.equal(result.snapshot.limit, '100'); assert.equal(result.snapshot.used, '105');
  const upgrade = adaptQuota(quota({ entitlementRequests: '200' }), evidence(), org, period, now);
  assert.equal(upgrade.capability.supported, false);
  const confirmed = adaptQuota(quota({ entitlementRequests: '200' }), evidence({ allowance: '200' }), org, period, now);
  assert.equal(buildDisplay(local(), confirmed.snapshot, settings()).percentage, '52.5');
  const unlimited = adaptQuota(quota({ isUnlimited: true, entitlementRequests: undefined }), evidence({ unlimited: true, allowance: null }), org, period, now);
  assert.equal(unlimited.capability.supported, true); assert.equal(unlimited.snapshot.limitKind, 'unlimited'); assert.equal(unlimited.snapshot.limit, null);
  const legacy = adaptQuota(quota(), evidence({ billingMode: 'premium-requests', unit: 'premium-requests' }), org, period, now);
  assert.equal(legacy.capability.supported, true); assert.equal(buildDisplay(local(), legacy.snapshot, settings()).unit, 'premium-requests');
});

test('quota refuses percentage-only, session/week/user budgets, wrong identity, incomplete coverage and stale evidence', () => {
  assert.equal(adaptQuota({ remainingPercentage: 50 }, null, org, period, now).capability.supported, false);
  assert.equal(adaptQuota(quota({ usedRequests: undefined, remainingPercentage: 50 }), evidence(), org, period, now).capability.supported, false);
  for (const override of [
    { poolKind: 'weekly' }, { poolKind: 'session' }, { poolKind: 'user-budget' }, { identityVerified: false },
    { unitVerified: false }, { coverageVerified: false }, { allowanceVerified: false }, { officialPageCompared: false },
    { usageSubject: 'user:test-user' }, { period: '2026-08' }, { poolId: '' }, { evidence: '' },
    { providerUpdatedAt: '2026-08-31T23:59:59.000Z' }, { verifiedAt: '2026-09-21T00:00:00.000Z' },
    { billingMode: 'unknown' }, { unit: 'tokens' },
    { identityVerified: 'true' }, { coverageVerified: 'true' }, { officialPageCompared: 'true' },
  ]) {
    const rejected = adaptQuota(quota(), evidence(override), org, period, now);
    assert.equal(rejected.capability.supported, false, JSON.stringify(override)); assert.equal(rejected.snapshot.used, null);
  }
  assert.equal(adaptQuota(quota({ resetDate: '2026-09-27T00:00:00.000Z' }), evidence(), org, period, now).capability.supported, false);
});

test('quota import rejects malformed runtime types, unbounded metadata and non-boolean flags without retaining them', () => {
  for (const invalidRaw of [null, undefined, true, 'quota', [], [quota()]]) {
    const result = adaptQuota(invalidRaw, evidence(), org, period, now);
    assert.equal(result.capability.supported, false); assert.equal(result.snapshot.used, null);
  }
  for (const invalidEvidence of [null, true, 'evidence', [], [evidence()]]) {
    assert.equal(adaptQuota(quota(), invalidEvidence, org, period, now).capability.supported, false);
  }
  const malformed = [
    { poolId: 123 }, { poolId: { content: 'SYNTHETIC_SECRET' } }, { poolId: ['pool'] },
    { poolId: ' ' }, { poolId: 'pool\n' }, { poolId: 'pool\u0085name' }, { poolId: 'p'.repeat(257) },
    { products: 'Copilot AI Credits' }, { products: [] }, { products: [''] }, { products: [123] },
    { products: [{ content: 'SYNTHETIC_SECRET' }] }, { products: ['a\nproduct'] }, { products: ['p'.repeat(257)] },
    { products: Array.from({ length: 65 }, (_, index) => `product-${index}`) },
    { billingEntity: {} }, { usageSubject: 1 }, { evidence: 'e'.repeat(4097) }, { evidence: 'text\u0000' },
    { verifiedAt: {} }, { providerUpdatedAt: now.getTime() }, { providerUpdatedAt: '2026-09-20' },
    { period: 202609 }, { allowance: 100 },
  ];
  for (const key of ['identityVerified', 'unitVerified', 'allowanceVerified', 'coverageVerified', 'officialPageCompared', 'unlimited']) {
    malformed.push({ [key]: 'true' }, { [key]: 1 }, { [key]: {} }, { [key]: undefined });
  }
  for (const override of malformed) {
    const result = adaptQuota(quota(), evidence(override), org, period, now);
    assert.equal(result.capability.supported, false, JSON.stringify(override));
    assert.equal(result.snapshot.used, null); assert.equal(result.snapshot.poolId, null);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
  }
  for (const isUnlimited of ['true', 'false', 0, 1, {}, [], null, undefined]) {
    assert.equal(adaptQuota(quota({ isUnlimited }), evidence(), org, period, now).capability.supported, false);
  }
  for (const malformedPeriod of [null, undefined, 202609, [], {}, '2026-13', '2026-9']) {
    assert.throws(() => adaptQuota(quota(), evidence(), org, malformedPeriod, now), { name: 'RangeError', message: /Period must be YYYY-MM/ });
  }
});

test('official display independently rejects malformed persisted metadata and identities', () => {
  const valid = official();
  const malformed = [
    { poolId: 123 }, { poolId: {} }, { poolId: ['pool'] }, { poolId: ' ' }, { poolId: 'pool\n' }, { poolId: 'p'.repeat(257) },
    { billingEntity: 123 }, { usageSubject: {} }, { billingEntity: 'bad-identity', usageSubject: 'bad-identity' },
    { source: {} }, { source: 'unknown' }, { products: 'Copilot AI Credits' }, { products: null }, { products: [null] },
    { products: ['p'.repeat(257)] }, { products: ['a\nproduct'] }, { products: Array(65).fill('Copilot AI Credits') },
    { stale: 'false' }, { fetchedAt: {} }, { verifiedAt: {} },
    { providerUpdatedAt: {} }, { providerUpdatedAt: '2026-08-31T23:59:59.000Z' }, { providerUpdatedAt: '2026-09-21T00:00:00.000Z' },
  ];
  for (const override of malformed) {
    const snapshot = { ...valid, ...override };
    assert.equal(officialSnapshotEligible(snapshot, period, 'organization:test-org'), false, JSON.stringify(override));
    assert.equal(buildDisplay(local(), snapshot, settings()).mode, 'usage');
  }
  for (const snapshot of [null, true, 'snapshot', [], {}]) assert.equal(officialSnapshotEligible(snapshot, period), false);
  for (const entity of [null, 123, {}, [], 'wrong-identity']) assert.equal(officialSnapshotEligible(valid, period, entity), false);
  assert.equal(officialSnapshotEligible(valid, null), false);
});

test('reconciliation checks matching identity/pool/product/time and does not attribute residuals to devices', () => {
  const account = official(); const observation = { ...account, source: 'local-otel', used: '100' };
  const proof = { identityVerified: true, poolVerified: true, productsVerified: true, timeCoverageVerified: true };
  const difference = reconcileUsage(observation, account, proof);
  assert.equal(difference.difference, '5'); assert.equal(difference.label, '暂未归属'); assert.equal(difference.timeLimited, false);
  assert.equal(reconcileUsage({ ...observation, used: '106' }, account, proof).label, '尚未对齐');
  assert.equal(reconcileUsage(observation, { ...account, providerUpdatedAt: null }, proof).timeLimited, true);
  for (const override of [{ coverage: 'partial' }, { poolId: 'other-pool' }, { products: ['Spark'] }, { billingEntity: 'user:test-user' }, { periodEnd: '2026-11-01T00:00:00.000Z' }, { providerUpdatedAt: '2026-09-20T09:57:00.000Z' }]) {
    assert.equal(reconcileUsage({ ...observation, ...override }, account, proof).state, 'unknown');
  }
  assert.equal(reconcileUsage(observation, account, { ...proof, identityVerified: false }).difference, null);
  assert.equal(reconcileUsage({ ...observation, providerUpdatedAt: '2026-08-31T23:59:59.000Z' }, { ...account, providerUpdatedAt: '2026-08-31T23:59:59.000Z' }, proof).state, 'unknown');
});

test('scheduler coalesces requests, throttles manual calls and stops on permissions', async () => {
  let current = 0; let calls = 0; let release;
  const scheduler = new RefreshScheduler({ now: () => current });
  const run = () => { calls++; return new Promise(resolve => { release = () => resolve(official()); }); };
  const first = scheduler.refresh(run); const second = scheduler.refresh(run);
  await Promise.resolve(); release(); await Promise.all([first, second]); assert.equal(calls, 1);
  assert.equal(scheduler.nextRefreshAt, 300000);
  assert.equal(await scheduler.refresh(run, { manual: true }), null);
  current = 30000;
  await scheduler.refresh(async () => ({ ...official(), lastError: { code: 'PERMISSION_DENIED', message: 'test' } }), { manual: true });
  assert.equal(scheduler.nextRefreshAt, null);
  current = 99999999; assert.equal(await scheduler.refresh(run, { manual: true }), null);
  scheduler.resume();
  await scheduler.refresh(async () => official(), { idle: true, retryAt: () => new Date(current + 1800000).toISOString() });
  assert.equal(scheduler.nextRefreshAt, current + 1800000);
});
