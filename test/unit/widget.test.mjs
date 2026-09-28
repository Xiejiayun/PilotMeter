import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildWidget } from '../../dist/domain/widget.js';
import { WIDGET_TEXT_LIMITS } from '../../dist/shared/widget.js';
import { serve } from '../../dist/daemon/server.js';
import { instanceAt, request } from '../../dist/daemon/client.js';

// All identities, dates and quantities in this file are artificial fixtures.
const now = '2026-09-20T10:00:00.000Z';
const fetchedAt = '2026-09-20T09:59:00.000Z';
const identity = { id: 'synthetic-a', login: 'widget-fixture', host: 'https://github.com' };
const bucket = (changes = {}) => ({ key: 'premium_interactions', label: 'Synthetic label', unit: 'premium-requests', used: '25', limit: '100',
  remainingPercentage: '75', usedPercentage: '25', unlimited: false, resetAt: '2026-10-01T00:00:00.000Z', ...changes });
const quota = (changes = {}) => ({ accountId: identity.id, state: 'available', scope: 'signed-in-user', fetchedAt, stale: false, error: null, buckets: [bucket()], ...changes });
const overview = (changes = {}) => ({ accounts: [{ ...identity, status: 'connected', createdAt: fetchedAt, checkedAt: fetchedAt }],
  activeAccountId: identity.id, quota: quota(), login: null, refreshing: false, enabled: true, runCommand: 'synthetic-private-path', ...changes });
const local = (changes = {}) => ({ period: '2026-09', nanoAiu: null, knownCalls: 0, unknownCalls: 0, pendingCalls: 0, sessionCount: 0,
  coverage: 'empty', unitVerified: false, credits: null, ...changes });
const summary = (changes = {}) => ({ githubAccount: identity, period: '2026-09', local: local(), account: null,
  display: { mode: 'usage', label: 'Synthetic local label', used: null, limit: null, percentage: null, unit: 'nano-aiu', scope: 'synthetic-private-source', reason: null },
  updatedAt: now, demo: false, retention: { days: null, lastRunAt: null, cutoff: null, prunedTraces: 0, prunedSpans: 0 }, reconciliation: {}, ...changes });
const keys = ['state', 'title', 'value', 'detail', 'percentage', 'accountLogin', 'updatedAt'];
function bounded(value) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  for (const name of ['title', 'value', 'detail']) assert.ok(value[name].length <= WIDGET_TEXT_LIMITS[name]);
  assert.ok(value.accountLogin === null || value.accountLogin.length <= WIDGET_TEXT_LIMITS.accountLogin);
  assert.ok(value.percentage === null || Number.isFinite(value.percentage) && value.percentage >= 0 && value.percentage <= 100);
  assert.ok(value.updatedAt === '' || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.updatedAt));
}

test('widget prioritizes login and reauthentication over any retained usage', () => {
  const old = summary({ local: local({ knownCalls: 1, nanoAiu: '999', credits: '999', unitVerified: true }) });
  const absent = buildWidget(old, overview({ activeAccountId: null, accounts: [] }));
  assert.equal(absent.state, 'needs-login'); assert.equal(absent.value, '登录 GitHub'); assert.equal(absent.percentage, null);
  assert.equal(absent.accountLogin, null); assert.doesNotMatch(JSON.stringify(absent), /999/); bounded(absent);
  const expired = buildWidget(old, overview({ accounts: [{ ...overview().accounts[0], status: 'reauth-required' }] }));
  assert.equal(expired.state, 'needs-login'); assert.equal(expired.value, '重新登录'); assert.equal(expired.percentage, null);
  assert.doesNotMatch(JSON.stringify(expired), /25%|999/);
});

test('widget never turns an empty ledger or unavailable quota into zero usage', () => {
  for (const missing of [null, quota({ state: 'unavailable', buckets: [], fetchedAt: null })]) {
    const value = buildWidget(summary({ local: local({ nanoAiu: '0', credits: '0' }) }), overview({ quota: missing }));
    assert.equal(value.state, 'waiting'); assert.equal(value.value, '用量未知'); assert.equal(value.percentage, null); bounded(value);
  }
  const incomplete = buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ used: null, usedPercentage: null })] }) }));
  assert.equal(incomplete.value, '已用未知'); assert.equal(incomplete.percentage, null);
});

test('single personal quota keeps current-cycle meaning and known zero distinct', () => {
  const value = buildWidget(summary(), overview());
  assert.equal(value.state, 'ready'); assert.equal(value.value, '25%'); assert.equal(value.percentage, 25);
  assert.match(value.title, /高级请求.*当前周期/); assert.match(value.detail, /Premium Requests/);
  assert.doesNotMatch(value.title + value.detail, /本月|2026-09/); assert.equal(value.updatedAt, fetchedAt); bounded(value);
  const zero = buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ used: '0', usedPercentage: '0' })] }) }));
  assert.equal(zero.value, '0%'); assert.equal(zero.percentage, 0);
  const unknownUnit = buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ unit: 'unspecified' })] }) }));
  assert.match(unknownUnit.detail, /单位未确认/); assert.doesNotMatch(unknownUnit.detail, /AI Credits|Premium Requests/);
});

test('multiple finite categories without a premium category need an explicit choice', () => {
  const pools = [bucket({ key: 'synthetic_first', used: '3', unit: 'ai-credits' }), bucket({ key: 'synthetic_second', used: '400', usedPercentage: '80', unit: 'premium-requests' })];
  const value = buildWidget(summary(), overview({ quota: quota({ buckets: pools }) }));
  assert.equal(value.value, '选择额度类别'); assert.equal(value.percentage, null); assert.match(value.detail, /2 个独立额度类别/);
  assert.doesNotMatch(JSON.stringify(value), /403|400|25%|80%/); bounded(value);
});

test('the named premium category is primary alongside unlimited chat and completions without inferring units', () => {
  const premium = bucket({ used: '73579', limit: '294316', unit: 'unspecified' });
  const chat = bucket({ key: 'chat', used: '8888', limit: null, unlimited: true });
  const completions = bucket({ key: 'completions', used: '9999', limit: null, unlimited: true });
  for (const buckets of [[chat, completions, premium], [premium, completions, chat]]) {
    const value = buildWidget(summary(), overview({ quota: quota({ buckets }) }));
    assert.match(value.title, /高级请求/); assert.equal(value.value, '25%'); assert.equal(value.percentage, 25);
    assert.doesNotMatch(JSON.stringify(value), /73579|294316|8888|9999|Premium Requests|AI Credits|多个额度池/);
    bounded(value);
  }
});

test('a sole finite category is named, while all unlimited categories have no arbitrary primary', () => {
  const chat = bucket({ key: 'chat', unlimited: true });
  const finite = bucket({ key: 'synthetic_jobs' });
  const only = buildWidget(summary(), overview({ quota: quota({ buckets: [chat, finite] }) }));
  assert.match(only.title, /synthetic_jobs/); assert.equal(only.value, '25%'); assert.equal(only.percentage, 25);
  const unlimited = buildWidget(summary(), overview({ quota: quota({ buckets: [chat, bucket({ key: 'completions', unlimited: true })] }) }));
  assert.equal(unlimited.value, '各类别无固定上限'); assert.equal(unlimited.percentage, null);
  assert.doesNotMatch(unlimited.title, /聊天|代码补全/);
});

test('stale and failed snapshots expose their condition without forwarding raw diagnostics', () => {
  const stale = buildWidget(summary(), overview({ quota: quota({ stale: true }) }));
  assert.equal(stale.state, 'waiting'); assert.match(stale.detail, /旧快照/); assert.equal(stale.updatedAt, fetchedAt);
  const failed = buildWidget(summary(), overview({ quota: quota({ state: 'error', stale: true,
    error: { code: 'synthetic-private-code', message: 'synthetic-private-path-and-token' } }) }));
  assert.equal(failed.state, 'error'); assert.match(failed.detail, /同步失败.*旧快照/); assert.equal(failed.value, '25%');
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-private/);
  const refreshing = buildWidget(summary(), overview({ refreshing: true }));
  assert.equal(refreshing.state, 'waiting'); assert.match(refreshing.detail, /正在同步/);
});

test('unlimited, zero limits and overage never become misleading progress ratios', () => {
  for (const [input, expected] of [
    [bucket({ unlimited: true, limit: null, used: null }), '无固定上限'],
    [bucket({ used: '0', limit: '0', usedPercentage: '0' }), '0 / 0'],
    [bucket({ used: '105', usedPercentage: '105' }), '105 / 100'],
  ]) {
    const value = buildWidget(summary(), overview({ quota: quota({ buckets: [input] }) }));
    assert.equal(value.value, expected); assert.equal(value.percentage, null); bounded(value);
  }
  for (const usedPercentage of ['-1', '100.1', 'NaN', 'Infinity', '1e999', 0, null]) {
    assert.equal(buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ usedPercentage })] }) })).percentage, null);
  }
});

test('compact numeric values mark approximation and retain tiny or near-full nonzero meaning', () => {
  for (const [usedPercentage, expected] of [['0.000001', '<0.1%'], ['99.999999999999999999', '>99.9%'], ['33.3333', '≈33.3%']]) {
    const value = buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ usedPercentage })] }) }));
    assert.equal(value.value, expected); bounded(value);
  }
  const large = buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ used: '9007199254740993.123456789', limit: null, usedPercentage: null })] }) }));
  assert.equal(large.value, '≈9×10^15'); bounded(large);
  const exactPower = buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ used: '1e40', limit: null, usedPercentage: null })] }) }));
  assert.equal(exactPower.value, '1×10^40');
  for (const used of ['1e256', '1e-256', '-1', 'synthetic-private-token']) {
    const value = buildWidget(summary(), overview({ quota: quota({ buckets: [bucket({ used, usedPercentage: null })] }) }));
    assert.equal(value.value, '已用未知'); bounded(value);
  }
});

test('local fallback names UTC month, verified units and partial retained coverage', () => {
  const value = buildWidget(summary({ local: local({ knownCalls: 1, nanoAiu: '1250000000', unitVerified: true, credits: '1.25', unknownCalls: 2 }),
    retention: { ...summary().retention, prunedSpans: 2 } }), overview({ quota: null }));
  assert.equal(value.state, 'ready'); assert.equal(value.value, '1.25'); assert.equal(value.percentage, null);
  assert.match(value.title, /本机月度/); assert.match(value.detail, /2026-09（UTC）.*仍保留.*待定调用.*AI Credits/);
  assert.match(value.detail, /个人额度尚未取得/); assert.equal(value.updatedAt, now); bounded(value);
  const raw = buildWidget(summary({ local: local({ knownCalls: 1, nanoAiu: '12345678901234567890', credits: '12.3' }) }), overview({ quota: null }));
  assert.match(raw.detail, /nano AIU，换算未确认/); assert.doesNotMatch(raw.detail, /AI Credits/); assert.equal(raw.percentage, null);
});

test('local custom budget is labeled separately and has no fabricated zero or capped overage', () => {
  const make = (used, limit) => buildWidget(summary({ local: local({ knownCalls: 1, credits: used, nanoAiu: '1', unitVerified: true }),
    display: { ...summary().display, mode: 'custom', unit: 'ai-credits', used, limit, percentage: 'synthetic-private-invalid' } }), overview({ quota: null }));
  assert.equal(make('25', '100').percentage, 25); assert.match(make('25', '100').title, /本机月度自定义预算/);
  assert.match(make('25', '100').detail, /不代表个人官方额度/);
  assert.equal(make('105', '100').percentage, null); assert.match(make('105', '100').detail, /已超预算/);
  assert.equal(make('0', '0').percentage, null); assert.equal(make('0', '0').value, '0 / 0');
  assert.equal(make('0.00000000000000000001', '100').value, '<0.1%');
  assert.equal(make('99.99999999999999999999', '100').value, '>99.9%');
});

test('late quota and summary from another identity cannot leak into the selected account', () => {
  const value = buildWidget(summary({ githubAccount: { ...identity, id: 'synthetic-b' }, local: local({ knownCalls: 1, nanoAiu: '987654' }) }),
    overview({ quota: quota({ accountId: 'synthetic-b' }) }));
  assert.equal(value.value, '用量未知'); assert.equal(value.percentage, null); assert.equal(value.accountLogin, identity.login);
  assert.doesNotMatch(JSON.stringify(value), /987654|25%|synthetic-b/);
  const future = buildWidget(summary(), overview({ quota: quota({ fetchedAt: '2026-09-21T00:00:00.000Z' }) }));
  assert.equal(future.value, '用量未知'); assert.equal(future.percentage, null);
});

test('widget is a bounded allowlist and ignores paths, free-form labels and credentials', () => {
  const input = summary({ account: { token: 'synthetic-private-token' }, updatedAt: 'synthetic-private-date' });
  const accounts = overview({ quota: quota({ buckets: [bucket({ label: 'synthetic-private-label', key: 'synthetic-private-key' })] }),
    login: { userCode: 'ABCD-EFGH', verificationUri: 'synthetic-private-uri' }, token: 'synthetic-private-token' });
  const before = JSON.stringify([input, accounts]);
  const value = buildWidget(input, accounts);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-private|ABCD-EFGH|sourceContext|home|token|runCommand/i);
  assert.equal(value.updatedAt, ''); bounded(value); assert.equal(JSON.stringify([input, accounts]), before);
  for (const login of ['unsafe\nlogin', 'C:\\private-path', 'a'.repeat(129)]) {
    const rejected = buildWidget(summary(), overview({ accounts: [{ ...overview().accounts[0], login }] }));
    assert.equal(rejected.state, 'needs-login'); assert.equal(rejected.accountLogin, null);
  }
  const demonstration = buildWidget(summary({ demo: true }), overview({ enabled: false }));
  assert.equal(demonstration.value, '演示模式'); assert.equal(demonstration.percentage, null);
});

test('widget HTTP endpoint uses daemon identity, existing origin checks and a token-free response', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pilotmeter-widget-api-'));
  let instance;
  t.after(async () => {
    if (instance) await request(instance, '/api/shutdown', 'POST');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(join(directory, 'writer.lock')); await delay(25); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await serve(directory, false, { accounts: { clientFactory: () => { throw new Error('Widget GET must not launch a provider.'); } } });
  instance = await instanceAt(directory);
  const response = await fetch(`${instance.url}/api/widget`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.deepEqual(Object.keys(value).sort(), [...keys, 'app', 'version', 'instanceId'].sort());
  assert.equal(value.app, instance.app); assert.equal(value.version, instance.version); assert.equal(value.instanceId, instance.instanceId);
  assert.equal(value.state, 'needs-login'); assert.equal(value.percentage, null);
  for (const privateValue of [instance.managementToken, instance.collectorToken, directory]) assert.equal(JSON.stringify(value).includes(privateValue), false);
  for (const headers of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await fetch(`${instance.url}/api/widget`, { headers })).status, 403);
  }
  const invalidHost = await new Promise((resolve, reject) => {
    const pending = httpRequest(`${instance.url}/api/widget`, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    pending.on('error', reject); pending.end();
  });
  assert.equal(invalidHost, 403);
  await assert.rejects(access(join(directory, 'github-accounts')), { code: 'ENOENT' });
});
