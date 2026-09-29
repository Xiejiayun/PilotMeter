import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPersonalQuota, quotaBucketLabel } from '../../dist/domain/personal-quota.js';

// Synthetic quota snapshots only. No provider, credential, or real account is used.
const now = '2026-09-20T10:00:00.000Z';
const fetchedAt = '2026-09-20T09:59:00.000Z';
const next = '2026-10-01T00:00:00.000Z';
const bucket = (key = 'premium_interactions', changes = {}) => ({ key, label: 'untrusted upstream label', unit: 'unspecified',
  used: '25', limit: '100', remainingPercentage: '75', usedPercentage: '25', unlimited: false, resetAt: next, ...changes });
const quota = (buckets = [bucket()], changes = {}) => ({ accountId: 'synthetic-profile', scope: 'signed-in-user', state: 'available',
  fetchedAt, stale: false, error: null, buckets, ...changes });

test('known categories are distinct while unknown category labels stay independently identifiable', () => {
  assert.deepEqual(['chat', 'completions', 'premium_interactions'].map(quotaBucketLabel), ['聊天', '代码补全', '高级请求']);
  assert.equal(quotaBucketLabel('team_budget'), '其他额度 · team_budget');
  assert.notEqual(quotaBucketLabel('team_budget'), quotaBucketLabel('team-budget'));
  for (const invalid of ['unsafe\nlabel', 'C:\\private-path', '', 'a'.repeat(65), null]) assert.equal(quotaBucketLabel(invalid), '未识别额度');
});

test('primary summary selects the known premium category regardless of order or other unlimited categories', () => {
  const chat = bucket('chat', { unlimited: true, usedPercentage: null, limit: null });
  const completions = bucket('completions', { unlimited: true, usedPercentage: null, limit: null });
  const premium = bucket();
  for (const inputs of [[chat, completions, premium], [premium, chat, completions]]) {
    const result = projectPersonalQuota(quota(inputs), now);
    assert.equal(result.selection, 'premium');
    assert.equal(result.primary.key, 'premium_interactions');
    assert.equal(result.primary.label, '高级请求');
    assert.equal(result.primary.value, '25%');
    assert.equal(result.primary.percentage, 25);
    assert.equal(result.buckets.length, 3);
  }
  const multipleFinite = projectPersonalQuota(quota([bucket('chat'), bucket('premium_interactions', { usedPercentage: '60' })]), now);
  assert.equal(multipleFinite.primary.value, '60%');
  assert.equal(multipleFinite.selection, 'premium');
});

test('a sole finite category is named, while ambiguous finite categories require a choice without merging', () => {
  const single = projectPersonalQuota(quota([bucket('chat', { unlimited: true }), bucket('completions')]), now);
  assert.equal(single.selection, 'single-finite'); assert.equal(single.primary.label, '代码补全');
  const inputs = [bucket('team_a', { usedPercentage: '30' }), bucket('team_b', { usedPercentage: '80' })];
  const ambiguous = projectPersonalQuota(quota(inputs), now);
  assert.equal(ambiguous.selection, 'required'); assert.equal(ambiguous.primary, null);
  assert.deepEqual(ambiguous.buckets.map(value => value.value), ['30%', '80%']);
  const chosen = projectPersonalQuota(quota(inputs), now, 'team_b');
  assert.equal(chosen.selection, 'explicit'); assert.equal(chosen.primary.key, 'team_b'); assert.equal(chosen.primary.percentage, 80);
  assert.equal(projectPersonalQuota(quota(inputs), now, 'not-present').primary, null);
  assert.equal(projectPersonalQuota(quota([bucket('chat', { unlimited: true }), bucket('completions', { unlimited: true })]), now).primary, null);
  const duplicate = projectPersonalQuota(quota([bucket(), bucket()]), now, 'premium_interactions');
  assert.equal(duplicate.selection, 'required'); assert.equal(duplicate.primary, null);
});

test('unspecified units expose exact raw amounts separately from confirmed-unit quantities', () => {
  const raw = bucket('premium_interactions', { used: '987654321', limit: '9876543210', usedPercentage: '10' });
  const result = projectPersonalQuota(quota([raw]), now);
  assert.equal(result.primary.unit, 'unspecified'); assert.equal(result.primary.unitLabel, '单位未确认');
  assert.equal(result.primary.value, '10%'); assert.equal(result.primary.used, null); assert.equal(result.primary.limit, null);
  assert.equal(result.primary.remaining, null);
  assert.deepEqual(result.primary.raw, { used: '987654321', limit: '9876543210', remainingPercentage: '75' });
  assert.doesNotMatch(result.primary.value + result.primary.detail, /987654321|AI Credits|Premium Requests|untrusted upstream/);
  assert.match(result.primary.detail, /数量单位未确认/);
  const unknown = projectPersonalQuota(quota([bucket('chat', { usedPercentage: null })]), now);
  assert.equal(unknown.primary.value, '已用未知'); assert.equal(unknown.primary.percentage, null);
  const unlimited = projectPersonalQuota(quota([bucket('premium_interactions', { unlimited: true, used: '87654321' })]), now);
  assert.equal(unlimited.primary.value, '无固定上限'); assert.equal(unlimited.primary.percentage, null);
  assert.equal(unlimited.primary.raw.used, '87654321');
  assert.equal(unlimited.primary.remaining, null);
  assert.doesNotMatch(unlimited.primary.value + unlimited.primary.detail, /87654321/);
  const zero = projectPersonalQuota(quota([bucket('premium_interactions', { used: '0', limit: '0', usedPercentage: '0' })]), now);
  assert.equal(zero.primary.value, '已用未知'); assert.equal(zero.primary.percentage, null);
  assert.doesNotMatch(zero.primary.detail, /为 0|0 \/ 0/);
  const reported = projectPersonalQuota(quota([bucket('premium_interactions', { used: '62000', limit: '2000000', usedPercentage: '3.1' })]), now).primary;
  assert.equal(reported.raw.used, '62000'); assert.equal(reported.raw.limit, '2000000');
  assert.equal(reported.used, null); assert.equal(reported.limit, null); assert.equal(reported.remaining, null);
  assert.equal(reported.usedPercentage, '3.1'); assert.equal(reported.value, '3.1%');
});

test('remaining allowance uses exact subtraction only for explicit units and fixed known totals', () => {
  for (const [used, limit, remaining, overage] of [
    ['0', '100', '100', null], ['9007199254740993.123456789', '9007199254740994', '0.876543211', null],
    ['1.000000000000000001', '2', '0.999999999999999999', null], ['0', '0', '0', null],
    ['100.000000000000000001', '100', '0', '0.000000000000000001'],
  ]) {
    const view = projectPersonalQuota(quota([bucket('chat', { unit: 'ai-credits', used, limit })]), now).primary;
    assert.equal(view.remaining, remaining); assert.equal(view.remainingSource, 'calculated'); assert.equal(view.overage, overage);
    if (limit === '0' || overage) assert.equal(view.percentage, null);
  }
  for (const changes of [{ unit: 'unspecified' }, { unlimited: true }, { used: null }, { limit: null }, { used: '-1' }]) {
    const view = projectPersonalQuota(quota([bucket('premium_interactions', { unit: 'ai-credits', ...changes })]), now).primary;
    assert.equal(view.remaining, null); assert.equal(view.remainingSource, null);
  }
  const input = bucket('chat', { unit: 'unspecified', token: 'private-token', raw: { token: 'private-token' } });
  const view = projectPersonalQuota(quota([input]), now).primary;
  assert.deepEqual(Object.keys(view.raw).sort(), ['limit', 'remainingPercentage', 'used']);
  assert.doesNotMatch(JSON.stringify(view), /private-token/);
});

test('explicit units retain every quantity digit in visible values and details', () => {
  const result = projectPersonalQuota(quota([bucket('premium_interactions', { unit: 'ai-credits', used: '9007199254740993.123456789', limit: null, usedPercentage: null })]), now);
  assert.equal(result.primary.label, '高级请求'); assert.equal(result.primary.unitLabel, 'AI Credits');
  assert.equal(result.primary.used, '9007199254740993.123456789'); assert.equal(result.primary.value, '9007199254740993.123456789');
  assert.equal(result.primary.detail, '已用 9007199254740993.123456789 AI Credits。');
  const zero = projectPersonalQuota(quota([bucket('chat', { unit: 'premium-requests', used: '0', usedPercentage: '0' })]), now);
  assert.equal(zero.primary.value, '0%'); assert.equal(zero.primary.percentage, 0); assert.equal(zero.primary.used, '0');
  const noPercentage = projectPersonalQuota(quota([bucket('chat', { unit: 'ai-credits', usedPercentage: null })]), now);
  assert.equal(noPercentage.primary.value, '25 / 100'); assert.match(noPercentage.primary.detail, /AI Credits/);
  for (const [used, limit] of [['0.000000000000000001', '1.000000000000000001'], ['9'.repeat(200), '1' + '0'.repeat(200)]]) {
    const view = projectPersonalQuota(quota([bucket('chat', { unit: 'ai-credits', used, limit, usedPercentage: null })]), now).primary;
    assert.equal(view.value, `${used} / ${limit}`);
    assert.equal(view.detail, `已用 ${used} / ${limit} AI Credits。`);
    assert.doesNotMatch(view.value + view.detail, /≈|×10\^/);
  }
});

test('percentages do not clamp overages, zero denominators, invalid data or nearly-full precision into misleading gauges', () => {
  for (const usedPercentage of ['-1', '100.01', 'NaN', 'Infinity', '1e999', 0, null]) {
    assert.equal(projectPersonalQuota(quota([bucket('chat', { usedPercentage })]), now).primary.percentage, null);
  }
  for (const changes of [{ used: '101', usedPercentage: '100' }, { used: '0', limit: '0', usedPercentage: '0' }, { unlimited: true }]) {
    assert.equal(projectPersonalQuota(quota([bucket('premium_interactions', changes)]), now).primary.percentage, null);
  }
  for (const usedPercentage of ['0.000001', '99.999999999999999999', '33.3333', '0', '100']) {
    const view = projectPersonalQuota(quota([bucket('chat', { usedPercentage })]), now).primary;
    assert.equal(view.value, `${usedPercentage}%`);
    assert.equal(view.usedPercentage, usedPercentage);
    if (usedPercentage === '99.999999999999999999') assert.equal(view.percentage, null);
  }
});

test('next reset is shown only for an explicit valid timestamp after both now and the fetched snapshot', () => {
  assert.equal(projectPersonalQuota(quota(), now).primary.nextResetAt, next);
  assert.equal(projectPersonalQuota(quota(), Date.parse(now)).primary.nextResetAt, next);
  for (const resetAt of [fetchedAt, now, '2026-09-20T09:58:00.000Z', '2026-09-20T09:59:30.000Z', '2026-02-30T00:00:00.000Z', '2026-10-01', 'not-a-time', null]) {
    assert.equal(projectPersonalQuota(quota([bucket('chat', { resetAt })]), now).primary.nextResetAt, null);
  }
});

test('invalid and future snapshots stay absent; retained stale and failed snapshots remain marked', () => {
  for (const input of [null, quota([], {}), quota([bucket()], { state: 'unavailable' }), quota([bucket()], { fetchedAt: next }),
    quota([bucket()], { fetchedAt: 'bad' }), quota([bucket()], { scope: 'organization' }), quota([bucket('invalid\nkey')]), quota(Array.from({ length: 65 }, () => bucket()))]) {
    const result = projectPersonalQuota(input, now);
    assert.equal(result.primary, null); assert.deepEqual(result.buckets, []); assert.equal(result.fetchedAt, null);
  }
  for (const current of [NaN, Infinity, 'bad']) assert.equal(projectPersonalQuota(quota(), current).primary, null);
  assert.equal(projectPersonalQuota(quota(), now).stale, false);
  assert.equal(projectPersonalQuota(quota(), '2026-09-20T10:04:01.000Z').stale, true);
  assert.equal(projectPersonalQuota(quota([bucket()], { stale: true }), now).stale, true);
  const failed = projectPersonalQuota(quota([bucket()], { state: 'error', error: { code: 'private-code', message: 'private-diagnostic' } }), now);
  assert.equal(failed.stale, true); assert.equal(failed.primary.value, '25%'); assert.doesNotMatch(JSON.stringify(failed), /private/);
});

test('projection is pure and cannot copy arbitrary labels, diagnostics or profile metadata', () => {
  const input = quota([bucket()], { token: 'private-token', home: 'private-home', diagnostics: 'private-diagnostic' });
  const before = JSON.stringify(input);
  const projected = projectPersonalQuota(input, now);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(JSON.stringify(projected), /private|untrusted|synthetic-profile/);
  projected.buckets[0].label = 'changed';
  assert.equal(JSON.stringify(input), before);
});
