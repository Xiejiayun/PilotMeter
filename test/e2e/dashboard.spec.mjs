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
  const settings = { monthlyBudget: null, unitVerification: null, account: null, demo: false };
  const summary = {
    period, local: { period, nanoAiu: session.nanoAiu, knownCalls: 3, unknownCalls: 1, pendingCalls: 2, sessionCount: 1, coverage: 'partial', unitVerified: false, credits: null },
    account: null,
    display: { mode: 'usage', label: '计量单位待确认', used: session.nanoAiu, limit: null, percentage: null, unit: 'nano-aiu', scope: '本机已记录会话', reason: 'nano AIU 与 AI Credits 的换算尚未验证；官方额度未确认' },
    updatedAt: time, demo: false,
  };
  return {
    summary, settings, sessions: { items: [session], nextCursor: null }, diagnostics: [],
    detail: { ...session, lifetime: { nanoAiu: '205250000000', knownCalls: 5, unknownCalls: 1, pendingCalls: 2 }, monthly: { [period]: session }, modelBreakdown: [{ model: 'gpt-5', nanoAiu: '250000000', calls: 1, source: 'chat-spans-detail-not-added-to-root-total' }], events: [
      { traceId: 'a', spanId: 'b', sessionId: session.sessionId, classification: 'root', nanoAiu: '250000000', endTime: time, model: 'gpt-5' },
      { traceId: 'a', spanId: 'c', sessionId: session.sessionId, classification: 'root', nanoAiu: null, endTime: time, model: null },
      { traceId: 'a', spanId: 'd', sessionId: session.sessionId, classification: 'pending', nanoAiu: '99000000000', endTime: time, model: null },
      { traceId: 'a', spanId: 'e', sessionId: session.sessionId, classification: 'child', nanoAiu: '80000000000', endTime: time, model: 'gpt-5' },
    ] },
    ...overrides,
  };
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
    else if (url.pathname === '/api/summary') body = state.summary;
    else if (url.pathname === '/api/sessions') body = url.searchParams.has('cursor') ? state.nextPage : state.sessions;
    else if (url.pathname.startsWith('/api/sessions/')) body = state.detail;
    else if (url.pathname === '/api/settings') {
      if (request.method() === 'PATCH') state.settings.monthlyBudget = request.postDataJSON().monthlyBudget;
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
  await expect(page.getByText('pilotmeter run --', { exact: true })).toBeVisible();
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
