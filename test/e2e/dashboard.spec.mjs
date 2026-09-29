import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
});

const period = new Date().toISOString().slice(0, 7);
const time = `${period}-15T09:30:00.000Z`;
function fixture(overrides = {}) {
  const session = {
    id: 'source-1/session-1', sessionId: 'session-1-abcdef', sourceContext: 'local',
    firstSeen: time, lastSeen: time, nanoAiu: '105250000000', knownCalls: 3, unknownCalls: 1,
    pendingCalls: 2, models: ['claude-sonnet', 'gpt-5'], coverage: 'partial',
  };
  const settings = { monthlyBudget: null, unitVerification: null, account: null, retentionDays: null, demo: false };
  const summary = {
    period, local: { period, nanoAiu: session.nanoAiu, knownCalls: 3, unknownCalls: 1, pendingCalls: 2, sessionCount: 1, coverage: 'partial', unitVerified: false, credits: null },
    account: null,
    display: { mode: 'usage', label: '计量单位待确认', used: session.nanoAiu, limit: null, percentage: null, unit: 'nano-aiu', scope: '本机已记录会话', reason: 'nano AIU 与 AI Credits 的换算尚未验证；官方额度未确认' },
    updatedAt: time, demo: false,
    retention: { days: null, lastRunAt: null, cutoff: null, prunedTraces: 0, prunedSpans: 0 },
    reconciliation: { state: 'unknown', difference: null, label: '无法对账', reason: '身份、额度池、产品或时间覆盖尚未验证', timeLimited: true, period, cutoff: null, sourceContexts: [], localUsed: null, accountUsed: null, unit: null, ledgerHash: null, accountHash: null, evidencePresent: false, verifiedAt: null, expiresAt: null, blockers: ['尚无已接受的对账证据'] },
  };
  return {
    summary, settings, sessions: { items: [session], nextCursor: null }, diagnostics: [],
    detail: { ...session, lifetime: { nanoAiu: '205250000000', knownCalls: 5, unknownCalls: 1, pendingCalls: 2 }, monthly: { [period]: session }, modelBreakdown: [{ model: 'gpt-5', nanoAiu: '250000000', calls: 1, unknownCalls: 0, unitVerified: false, source: 'chat-spans-detail-not-added-to-root-total' }], events: [
      { traceId: 'a', spanId: 'b', sessionId: session.sessionId, classification: 'root', nanoAiu: '250000000', endTime: time, model: 'gpt-5' },
      { traceId: 'a', spanId: 'c', sessionId: session.sessionId, classification: 'root', nanoAiu: null, endTime: time, model: null },
      { traceId: 'a', spanId: 'd', sessionId: session.sessionId, classification: 'pending', nanoAiu: '99000000000', endTime: time, model: null },
      { traceId: 'a', spanId: 'e', sessionId: session.sessionId, classification: 'child', nanoAiu: '80000000000', endTime: time, model: 'gpt-5' },
    ] },
    ...overrides,
  };
}

function comparableFixture(difference = '2.000000001', label = '暂未归属') {
  const state = fixture();
  state.summary.account = { source: 'billing-rest', billingEntity: 'organization:example', usageSubject: 'organization:example', poolId: 'verified-pool', products: ['copilot'], periodStart: `${period}-01T00:00:00Z`, periodEnd: time, billingMode: 'ai-credits', unit: 'ai-credits', used: '12.12345679', coverage: 'complete', state: 'known', limit: null, limitKind: 'unknown', verifiedAt: time, fetchedAt: time, providerUpdatedAt: time, stale: false, lastError: null };
  state.summary.reconciliation = {
    ...state.summary.reconciliation, state: 'comparable', difference, label,
    reason: '身份、额度池、单位、产品和共同截止时间已核验', timeLimited: false,
    cutoff: time, sourceContexts: ['synthetic-source-1', 'synthetic-source-2'], localUsed: '10.123456789', accountUsed: '12.12345679', unit: 'ai-credits',
    ledgerHash: 'synthetic-ledger-hash', accountHash: 'synthetic-account-hash', evidencePresent: true,
    verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), blockers: [],
  };
  if (difference === '0') state.summary.reconciliation.localUsed = state.summary.reconciliation.accountUsed;
  else if (difference.startsWith('-')) state.summary.reconciliation.localUsed = '123456789123456801.246913579';
  return state;
}

async function mockApi(page, state) {
  const requests = [];
  // Exercise the production daemon's policy as well as the generated static files.
  await page.route('http://127.0.0.1:4173/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method(), headers: request.headers(), body: request.postDataJSON() });
    if (state.offline) return route.abort('connectionrefused');
    let body;
    if (url.pathname === '/api/session') body = { csrfToken: 'test-csrf-capability' };
    else if (url.pathname === '/api/auth/accounts') body = { accounts: [], activeAccountId: null, quota: null, login: null, refreshing: false, enabled: !state.summary.demo, runCommand: 'pilotmeter run --' };
    else if (url.pathname === '/api/summary') body = state.summary;
    else if (url.pathname === '/api/sessions') body = url.searchParams.has('cursor') ? state.nextPage : state.sessions;
    else if (url.pathname.startsWith('/api/sessions/')) {
      if (state.detailOffline) return route.abort('connectionrefused');
      body = state.detail;
    }
    else if (url.pathname === '/api/settings') {
      if (request.method() === 'PATCH') {
        if (state.budgetPatchGate) await state.budgetPatchGate;
        state.settings.monthlyBudget = request.postDataJSON().monthlyBudget;
      } else if (state.budgetSettingsGate) await state.budgetSettingsGate;
      body = state.settings;
    } else if (url.pathname === '/api/diagnostics') body = { items: state.diagnostics };
    else if (url.pathname === '/api/refresh') body = { refreshed: true };
    else return route.fulfill({ status: 404, json: { error: 'Unexpected API path' } });
    return route.fulfill({ json: body });
  });
  return requests;
}

test('keeps unverified units, unknown and pending usage distinct', async ({ page }) => {
  await mockApi(page, fixture());
  await page.goto('/');
  await expect(page.locator('#primary-value')).toHaveText('105,250,000,000');
  await expect(page.locator('#primary-unit')).toHaveText('nano AIU');
  await expect(page.locator('#official-state')).toHaveText('未确认');
  await expect(page.locator('#unknown-count')).toHaveText('1');
  await expect(page.locator('#pending-count')).toHaveText('2');
  await expect(page.getByRole('progressbar')).toBeHidden();
  await expect(page.locator('#demo-banner')).toBeHidden();
});

test('empty collector never presents consumption as zero', async ({ page }) => {
  const state = fixture();
  state.summary.local = { ...state.summary.local, nanoAiu: null, knownCalls: 0, unknownCalls: 0, pendingCalls: 0, sessionCount: 0, coverage: 'empty' };
  state.summary.display.used = null;
  state.sessions.items = [];
  await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#primary-value')).toHaveText('—');
  await expect(page.getByText('还没有这个月的记录')).toBeVisible();
  await expect(page.locator('#empty-state code')).toHaveText('pilotmeter run --');
  await expect(page.locator('#official-state')).toHaveText('未确认');
});

test('custom over-budget mode uses exact verified credits, capped visual bar and obvious demo', async ({ page }) => {
  const state = fixture();
  state.summary.local.unitVerified = true;
  state.summary.local.credits = '105.25';
  state.summary.demo = true;
  state.summary.display = { ...state.summary.display, mode: 'custom', label: '自定义预算已用', used: '105.25', limit: '100', percentage: '105.25', unit: 'ai-credits', reason: '已知用量小计；官方额度未确认' };
  await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#primary-value')).toHaveText('105.25');
  await expect(page.locator('#usage-detail')).toContainText('105.25 / 100 AI Credits');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '实际已用 105.25%');
  expect(await page.locator('#progress-fill').evaluate(element => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width)).toBeGreaterThan(0.99);
  await expect(page.locator('#overage')).toContainText('已超出自定义预算');
  await expect(page.locator('#demo-banner')).toBeVisible();
  await expect(page.locator('.session-amount')).toHaveText('105.25');
  await expect(page.locator('#official-state')).toHaveText('未确认');
});

test('budget is validated, saved with CSRF and can be cleared with keyboard', async ({ page }) => {
  const state = fixture();
  const requests = await mockApi(page, state);
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '预算 AI Credits / 月' });
  await input.fill('-5');
  await input.press('Enter');
  await expect(page.locator('#budget-feedback')).toContainText('请输入非负数');
  expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(0);
  await input.fill('1200.123456789');
  await input.press('Enter');
  await expect(page.locator('#budget-feedback')).toHaveText('预算已保存。');
  const patch = requests.find(request => request.method === 'PATCH');
  expect(patch.headers['x-pilotmeter-csrf']).toBe('test-csrf-capability');
  expect(patch.body).toEqual({ monthlyBudget: '1200.123456789' });
  await input.fill('0');
  await input.press('Enter');
  await expect(page.locator('#budget-feedback')).toContainText('预算为 0，不计算百分比');
  await input.fill('');
  await input.press('Enter');
  await expect(page.locator('#budget-feedback')).toHaveText('已清除自定义预算。');
  expect(state.settings.monthlyBudget).toBeNull();
});

test('budget success waits for dashboard refresh and is ready for keyboard clearing', async ({ page }) => {
  const state = fixture();
  await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#primary-value')).toHaveText('105,250,000,000');
  const input = page.getByRole('textbox', { name: '预算 AI Credits / 月' });
  const save = page.getByRole('button', { name: '保存', exact: true });
  const feedback = page.locator('#budget-feedback');
  const refreshGate = Promise.withResolvers();
  state.budgetSettingsGate = refreshGate.promise;
  const settingsRead = page.waitForRequest(request => new URL(request.url()).pathname === '/api/settings' && request.method() === 'GET');
  try {
    await input.fill('0');
    await input.press('Enter');
    await settingsRead;
    await expect(save).toBeDisabled();
    await expect(feedback).toHaveText('正在保存…');
  } finally {
    delete state.budgetSettingsGate;
    refreshGate.resolve();
  }
  await expect(feedback).toHaveText('已保存 · 预算为 0，不计算百分比。');
  await expect(save).toBeEnabled();
  await input.fill('');
  await input.press('Enter');
  await expect(feedback).toHaveText('已清除自定义预算。');
  await expect(save).toBeEnabled();
  expect(state.settings.monthlyBudget).toBeNull();
});

test('budget preserves a newer draft while a previous save is pending', async ({ page }) => {
  const state = fixture();
  const requests = await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#primary-value')).toHaveText('105,250,000,000');
  const input = page.getByRole('textbox', { name: '预算 AI Credits / 月' });
  const save = page.getByRole('button', { name: '保存', exact: true });
  const feedback = page.locator('#budget-feedback');
  const patchGate = Promise.withResolvers();
  state.budgetPatchGate = patchGate.promise;
  const patchStarted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/settings' && request.method() === 'PATCH');
  try {
    await input.fill('0');
    await input.press('Enter');
    await patchStarted;
    await expect(save).toBeDisabled();
    await expect(feedback).toHaveText('正在保存…');
    await input.fill('250.5');
  } finally {
    delete state.budgetPatchGate;
    patchGate.resolve();
  }
  await expect(save).toBeEnabled();
  await expect(input).toHaveValue('250.5');
  await expect(feedback).toHaveText('上次提交已保存；当前输入尚未保存。');
  expect(state.settings.monthlyBudget).toBe('0');
  await input.press('Enter');
  await expect(feedback).toHaveText('预算已保存。');
  await expect(save).toBeEnabled();
  expect(requests.filter(request => request.method === 'PATCH').map(request => request.body)).toEqual([
    { monthlyBudget: '0' }, { monthlyBudget: '250.5' },
  ]);
  expect(state.settings.monthlyBudget).toBe('250.5');
});

test('session modal separates monthly and lifetime usage and never executes metadata', async ({ page }) => {
  const state = fixture();
  state.summary.local.unitVerified = true;
  state.sessions.items[0].models = ['<img src=x onerror=alert(1)>'];
  state.detail.models = state.sessions.items[0].models;
  state.diagnostics = [{ code: '<script>bad()</script>', message: '<img src=x onerror=alert(1)>', createdAt: time, count: 2 }];
  let dialogCount = 0;
  page.on('dialog', () => dialogCount++);
  await mockApi(page, state);
  await page.goto('/');
  const sessionButton = page.getByRole('button', { name: /查看会话/ });
  await sessionButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.detail-total')).toContainText('105.25');
  await expect(page.locator('.call-list')).toContainText('用量未知');
  await expect(page.locator('.call-list')).toContainText('待分类 · 未计入');
  await expect(page.locator('.call-list')).not.toContainText('80 AI Credits');
  await page.getByRole('button', { name: '生命周期', exact: true }).click();
  await expect(page.locator('.detail-total')).toContainText('205.25');
  await expect(page.getByText(/不再加到顶层总额中/)).toBeVisible();
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(sessionButton).toBeFocused();
  await page.locator('summary').click();
  await expect(page.locator('#diagnostics')).toContainText('<script>bad()</script>');
  await expect(page.locator('#diagnostics img')).toHaveCount(0);
  expect(dialogCount).toBe(0);
});

test('offline polling retains old amounts and labels the last successful read', async ({ page }) => {
  const state = fixture();
  await mockApi(page, state);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#primary-value')).toHaveText('105,250,000,000');
  state.offline = true;
  await page.clock.runFor(5_100);
  await expect(page.locator('#connection')).toHaveText('本地服务离线');
  await expect(page.locator('#primary-value')).toHaveText('105,250,000,000');
  await expect(page.locator('#page-message')).toContainText('保留上次读取的记录');
  await expect(page.locator('#updated-at')).toContainText('离线 · 上次读取');
  state.offline = false;
  await page.clock.runFor(5_100);
  await expect(page.locator('#connection')).toHaveText('本地服务已连接');
  await expect(page.locator('#page-message')).toBeHidden();
});

test('month change waits for new data and sends the requested UTC month', async ({ page }) => {
  const state = fixture();
  await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#primary-value')).toHaveText('105,250,000,000');
  state.offline = true;
  await page.locator('#period').fill('2025-01');
  await expect(page.locator('#primary-value')).toHaveText('—');
  await expect(page.locator('#period-caption')).toHaveText('2025-01 · UTC');
  await expect(page.locator('#page-message')).not.toContainText('保留上次读取');
});

test('pagination loads the next page without duplicates', async ({ page }) => {
  const state = fixture();
  state.sessions.nextCursor = 'next-page';
  state.nextPage = { items: [state.sessions.items[0], { ...state.sessions.items[0], id: 'session-2', sessionId: 'second-session' }], nextCursor: null };
  await mockApi(page, state);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: '加载更多会话' }).click();
  await expect(page.locator('.session-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '加载更多会话' })).toBeHidden();
  await page.clock.runFor(5_100);
  await expect(page.locator('.session-row')).toHaveCount(2);
});

test('official stale snapshot keeps scope and fetch time separate from provider cutoff', async ({ page }) => {
  const state = fixture();
  state.summary.display = { mode: 'official', label: '本月官方额度已用', used: '500', limit: '1000', percentage: '50.0', unit: 'ai-credits', scope: '官方账户额度池 · organization:example', reason: '数据已陈旧；显示上次成功同步值' };
  state.summary.account = { source: 'billing-rest', billingEntity: 'organization:example', usageSubject: 'organization:example', poolId: 'verified-pool', products: ['copilot'], periodStart: `${period}-01T00:00:00Z`, periodEnd: time, billingMode: 'ai-credits', unit: 'ai-credits', used: '500', coverage: 'complete', state: 'known', limit: '1000', limitKind: 'official', verifiedAt: time, fetchedAt: time, providerUpdatedAt: null, stale: true, lastError: { code: 'FORBIDDEN', message: '读取权限不足' } };
  state.settings.account = { kind: 'organization', login: 'example' };
  await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#mode-badge')).toHaveText('官方账户');
  await expect(page.locator('#official-state')).toHaveText('已验证');
  await expect(page.locator('#account-status')).toHaveText('组织 · example');
  await expect(page.locator('#account-usage')).toContainText('organization:example · 已核实完整覆盖 · 500 AI Credits');
  await expect(page.locator('#page-message')).toContainText('账户快照已陈旧');
  await expect(page.locator('#updated-at')).toContainText('账单已陈旧');
  await expect(page.locator('#updated-at')).toContainText('官方数据截止时间未知');
});

test('first billing permission failure is visible without a stale snapshot', async ({ page }) => {
  const state = fixture();
  state.summary.account = { source: 'billing-rest', billingEntity: 'organization:example', usageSubject: 'organization:example', products: [], unit: 'unknown', used: null, coverage: 'unknown', state: 'unknown', limit: null, limitKind: 'unknown', fetchedAt: time, providerUpdatedAt: null, stale: false, lastError: { code: 'FORBIDDEN', message: '读取权限不足' } };
  await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#page-message')).toContainText('账户同步失败，尚未取得有效账单快照');
  await expect(page.locator('#page-message')).toContainText('FORBIDDEN：读取权限不足');
  await expect(page.locator('#primary-value')).toHaveText('105,250,000,000');
  await expect(page.locator('#connection')).toHaveText('本地服务已连接');
});

test('open detail refreshes calls while preserving range and labels a failed refresh', async ({ page }) => {
  const state = fixture();
  await mockApi(page, state);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: /查看会话/ }).click();
  await page.getByRole('button', { name: '生命周期', exact: true }).click();
  await expect(page.locator('.detail-total')).toContainText('205,250,000,000');
  state.detail.lifetime.nanoAiu = '305250000000';
  state.detail.lifetime.knownCalls++;
  state.detail.events.push({ traceId: 'new', spanId: 'new', classification: 'root', nanoAiu: '100000000000', endTime: time });
  await page.clock.runFor(5_100);
  await expect(page.locator('.detail-total')).toContainText('305,250,000,000');
  await expect(page.locator('#detail-lifetime')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#detail-body')).toContainText('6 次已知调用');
  await expect(page.locator('#detail-status')).toContainText('详情读取');
  state.detailOffline = true;
  await page.clock.runFor(5_100);
  await expect(page.locator('#detail-status')).toContainText('详情更新失败，保留');
  await expect(page.locator('.detail-total')).toContainText('305,250,000,000');
  await expect(page.locator('#connection')).toHaveText('本地服务已连接');
  state.detailOffline = false;
  state.detail.lifetime.nanoAiu = '405250000000';
  await page.clock.runFor(5_100);
  await expect(page.locator('.detail-total')).toContainText('405,250,000,000');
  await expect(page.locator('#detail-status')).not.toContainText('失败');
});

test('timed-out pending calls stay excluded until late evidence reclassifies them on refresh', async ({ page }) => {
  const state = fixture();
  const pending = state.detail.events.find(event => event.classification === 'pending');
  pending.reason = 'pending-timeout:unresolved-ancestor';
  await mockApi(page, state);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: /查看会话/ }).click();
  const timedOut = page.locator('.call-list li').filter({ hasText: '待分类超时 · 未计入' });
  await expect(timedOut).toHaveCount(1);
  await expect(timedOut.locator('.call-amount')).toHaveText('未计入');
  await expect(page.locator('.detail-total')).toContainText('105,250,000,000');
  await expect(page.locator('#detail-body')).toContainText('后到的证据可使记录重新判定');

  pending.classification = 'root';
  pending.reason = null;
  const updatedAmount = (BigInt(state.detail.monthly[period].nanoAiu) + BigInt(pending.nanoAiu)).toString();
  state.detail.monthly[period].nanoAiu = updatedAmount;
  state.detail.monthly[period].knownCalls++;
  state.detail.monthly[period].pendingCalls--;
  state.detail.lifetime.nanoAiu = (BigInt(state.detail.lifetime.nanoAiu) + BigInt(pending.nanoAiu)).toString();
  state.detail.lifetime.knownCalls++;
  state.detail.lifetime.pendingCalls--;
  state.summary.local.nanoAiu = updatedAmount;
  state.summary.display.used = updatedAmount;
  await page.clock.runFor(5_100);
  await expect(page.locator('#detail-body')).not.toContainText('待分类超时');
  await expect(page.locator('.call-list')).toContainText('99,000,000,000 nano AIU');
  await expect(page.locator('.detail-total')).toContainText('204,250,000,000');
  await expect(page.locator('.detail-notes')).toContainText('4 次已知调用');
  await expect(page.locator('.detail-notes')).toContainText('1 次待分类');
});

test('each model uses its own unit evidence and unknown count', async ({ page }) => {
  const state = fixture();
  state.summary.local.unitVerified = true;
  state.detail.modelBreakdown = [
    { model: 'unverified-version', nanoAiu: '500000000', calls: 3, unknownCalls: 2, unitVerified: false, source: 'chat-spans-detail-not-added-to-root-total' },
    { model: 'verified-version', nanoAiu: '250000000', calls: 1, unknownCalls: 0, unitVerified: true, source: 'chat-spans-detail-not-added-to-root-total' },
  ];
  await mockApi(page, state);
  await page.goto('/');
  await page.getByRole('button', { name: /查看会话/ }).click();
  await page.getByRole('button', { name: '生命周期', exact: true }).click();
  const unverified = page.locator('.call-list li').filter({ hasText: 'unverified-version' });
  await expect(unverified).toContainText('500,000,000 nano AIU');
  await expect(unverified).toContainText('2 次用量未知');
  await expect(page.locator('.call-list li').filter({ hasText: 'verified-version' }).last()).toContainText('0.25 AI Credits');
});

test('retention stays explicit after cleanup is disabled and in session detail', async ({ page }) => {
  const state = fixture();
  state.summary.retention = { days: 30, lastRunAt: time, cutoff: time, prunedTraces: 2, prunedSpans: 7 };
  await mockApi(page, state);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#retention-policy')).toHaveText('明细清理阈值 30 天');
  await expect(page.locator('#retention-notice')).toContainText('历史已清理');
  await expect(page.locator('#retention-history')).toContainText('累计清理 7 条计量记录');
  await page.getByRole('button', { name: /查看会话/ }).click();
  await expect(page.locator('#detail-body')).toContainText('仅包含保留记录');
  state.summary.retention.days = null;
  await page.clock.runFor(5_100);
  await expect(page.locator('#retention-policy')).toHaveText('自动清理已关闭');
  await expect(page.locator('#retention-notice')).toContainText('关闭清理也无法恢复已删除记录');
  await expect(page.locator('#detail-body')).toContainText('自动清理现已关闭');
});

test('reconciliation explains unknown scope and exposes no browser verification controls', async ({ page }) => {
  const state = fixture();
  state.summary.reconciliation.reason = '没有官方更新截止时间，无法对账';
  state.summary.reconciliation.blockers = ['单位换算尚未验证', '<img src=x onerror=alert(1)>'];
  const requests = await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('#reconciliation-state')).toHaveText('无法对账');
  await expect(page.locator('#reconciliation-reason')).toContainText('没有官方更新截止时间');
  await expect(page.locator('#reconciliation-reason')).toContainText('单位换算尚未验证');
  await expect(page.locator('#reconciliation-difference')).toHaveText('—');
  await expect(page.locator('#reconciliation-cutoff')).toContainText('尚未确认');
  await expect(page.locator('#reconciliation img')).toHaveCount(0);
  await expect(page.locator('#reconciliation button, #reconciliation input')).toHaveCount(0);
  expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
});

for (const [difference, label, formatted] of [
  ['2.000000001', '暂未归属', '+2.000000001'],
  ['-123456789123456789.123456789', '尚未对齐', '-123,456,789,123,456,789.123456789'],
  ['0', '已对齐', '0'],
]) {
  test(`reconciliation renders ${label} with exact signed credits and common UTC cutoff`, async ({ page }) => {
    const state = comparableFixture(difference, label);
    if (difference.startsWith('-')) await page.setViewportSize({ width: 320, height: 1000 });
    if (difference === '2.000000001') {
      state.summary.account.stale = true;
      state.summary.reconciliation.timeLimited = true;
      state.summary.reconciliation.reason = '账户快照已陈旧，仅作共同截止时间的有限参考';
    }
    await mockApi(page, state);
    await page.goto('/');
    await expect(page.locator('#reconciliation-state')).toHaveText(label);
    await expect(page.locator('#reconciliation-difference')).toHaveText(`${formatted} AI Credits`);
    await expect(page.locator('#reconciliation-account')).toHaveText('12.12345679 AI Credits');
    await expect(page.locator('#reconciliation-local')).toHaveText(`${difference.startsWith('-') ? '123,456,789,123,456,801.246913579' : difference === '0' ? '12.12345679' : '10.123456789'} AI Credits`);
    await expect(page.locator('#reconciliation-account-source')).toContainText('GitHub 账单快照 · organization:example');
    await expect(page.locator('#reconciliation-local-source')).toHaveText('最近核验涉及 2 个采集来源');
    await expect(page.locator('#reconciliation-cutoff')).toContainText(`${period}-15 09:30:00 UTC`);
    await expect(page.locator('#reconciliation')).not.toContainText('synthetic-ledger-hash');
    await expect(page.locator('#reconciliation')).toContainText('不会回写会话用量');
    if (difference === '2.000000001') {
      await expect(page.locator('#reconciliation-reason')).toContainText('账户快照已陈旧');
      await expect(page.locator('#reconciliation-timing')).toContainText('时间限制');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('reconciliation retains offline inputs but hides the difference until reconnected', async ({ page }) => {
  const state = comparableFixture();
  await mockApi(page, state);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#reconciliation-difference')).toHaveText('+2.000000001 AI Credits');
  state.offline = true;
  await page.clock.runFor(5_100);
  await expect(page.locator('#reconciliation-state')).toHaveText('无法对账');
  await expect(page.locator('#reconciliation-reason')).toContainText('离线旧快照不可继续比较');
  await expect(page.locator('#reconciliation-difference')).toHaveText('—');
  await expect(page.locator('#reconciliation-local')).toHaveText('10.123456789 AI Credits');
  await expect(page.locator('#reconciliation-account-source')).toContainText('离线旧值');
  state.offline = false;
  await page.clock.runFor(5_100);
  await expect(page.locator('#reconciliation-difference')).toHaveText('+2.000000001 AI Credits');
});

test('reconciliation proof expiry hides the difference even before the next snapshot poll', async ({ page }) => {
  const state = comparableFixture();
  const now = new Date();
  state.summary.reconciliation.expiresAt = new Date(now.getTime() + 3_000).toISOString();
  await mockApi(page, state);
  await page.clock.install({ time: now });
  await page.goto('/');
  await expect(page.locator('#reconciliation-difference')).toHaveText('+2.000000001 AI Credits');
  await page.clock.runFor(3_100);
  await expect(page.locator('#reconciliation-state')).toHaveText('无法对账');
  await expect(page.locator('#reconciliation-reason')).toContainText('对账证据已过期');
  await expect(page.locator('#reconciliation-difference')).toHaveText('—');
  await expect(page.locator('#reconciliation-evidence')).toContainText('已过期');
});

test('320px layout and very large exact amounts stay within viewport', async ({ page }) => {
  const state = fixture();
  state.summary.local.unitVerified = true;
  state.summary.display = { ...state.summary.display, label: '本机已记录', used: '105.25', unit: 'ai-credits', reason: '已知用量小计；官方额度未确认' };
  state.sessions.items[0].nanoAiu = '123456789123456789123456789';
  await page.setViewportSize({ width: 320, height: 900 });
  await mockApi(page, state);
  await page.goto('/');
  await expect(page.locator('.session-amount')).toHaveText('123,456,789,123,456,789.123456789');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: /查看会话/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});
