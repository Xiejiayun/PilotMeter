import { test, expect } from '@playwright/test';

const period = new Date().toISOString().slice(0, 7);
const time = `${period}-01T00:00:00.000Z`;
const alice = { id: 'account-a', login: 'alice-work', host: 'https://github.com', status: 'connected', createdAt: time, checkedAt: time };
const bob = { ...alice, id: 'account-b', login: 'bob-personal' };
const quota = accountId => ({ accountId, state: 'available', scope: 'signed-in-user', fetchedAt: time, stale: false, buckets: [{ key: 'premium_interactions', label: 'Premium interactions', unit: 'unspecified', used: '75', limit: '200', remainingPercentage: '62.5', usedPercentage: '37.5', unlimited: false, resetAt: time }], error: null });
function state(accounts = [alice, bob], activeAccountId = 'account-a') {
  return {
    overview: { accounts, activeAccountId, quota: activeAccountId ? quota(activeAccountId) : null, login: null, refreshing: false, enabled: true, runCommand: activeAccountId ? 'pilotmeter run -- --no-auto-update' : 'pilotmeter run --' },
    login: { id: 'device-1', status: 'pending', host: 'https://github.com', verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234', expiresAt: new Date(Date.now() + 600_000).toISOString(), accountId: null, error: null },
    requests: [], authOffline: false, loginStarts: 0,
  };
}
function snapshot(state) {
  const accountId = state.overview.activeAccountId;
  const account = state.overview.accounts.find(item => item.id === accountId);
  const amount = accountId === 'account-a' ? '1000000000' : accountId === 'account-b' ? '2000000000' : '3000000000';
  const session = { id: `session-${accountId ?? 'old'}`, sessionId: accountId === 'account-b' ? 'bob-session' : 'alice-session', sourceContext: 'local', firstSeen: time, lastSeen: time, nanoAiu: amount, knownCalls: 1, unknownCalls: 0, pendingCalls: 0, models: ['gpt-5'], coverage: 'partial' };
  return {
    summary: {
      period, githubAccount: account ? { id: account.id, login: account.login, host: account.host } : null,
      local: { period, nanoAiu: amount, knownCalls: 1, unknownCalls: 0, pendingCalls: 0, sessionCount: 1, coverage: 'partial', unitVerified: false, credits: null },
      account: null, display: { mode: 'usage', label: '计量单位待确认', used: amount, limit: null, percentage: null, unit: 'nano-aiu', scope: '本机已记录会话', reason: '尚未验证单位' }, updatedAt: time, demo: !state.overview.enabled,
      retention: { days: null, lastRunAt: null, cutoff: null, prunedTraces: 0, prunedSpans: 0 },
      reconciliation: { state: 'unknown', difference: null, label: '无法对账', reason: '尚未核验', timeLimited: true, period, cutoff: null, sourceContexts: [], localUsed: null, accountUsed: null, unit: null, ledgerHash: null, accountHash: null, evidencePresent: false, verifiedAt: null, expiresAt: null, blockers: [] },
    },
    sessions: { items: [session], nextCursor: null, accountId },
    detail: { ...session, accountId, lifetime: session, monthly: { [period]: session }, modelBreakdown: [], events: [] },
  };
}
async function mock(page, state) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    state.requests.push({ path, query: new URL(request.url()).searchParams.toString(), method: request.method(), body, headers: request.headers() });
    if (state.authOffline && path === '/api/auth/accounts') return route.abort('connectionrefused');
    if (path === '/api/session') return route.fulfill({ json: { csrfToken: 'test-account-csrf' } });
    if (path === '/api/auth/accounts') return route.fulfill({ json: state.overview });
    if (path === '/api/auth/select') {
      if (state.selectGate) await state.selectGate;
      state.overview.activeAccountId = body.accountId;
      state.overview.quota = body.accountId ? quota(body.accountId) : null;
      return route.fulfill({ json: state.overview });
    }
    if (path === '/api/auth/refresh') return route.fulfill({ json: state.overview });
    if (path === '/api/auth/login') {
      state.loginStarts++;
      state.login.host = body.host;
      state.login.verificationUri = state.unsafeVerification ?? `${body.host}/login/device`;
      return route.fulfill({ json: state.login });
    }
    if (path === '/api/auth/login/device-1') return route.fulfill({ json: state.login });
    if (path === '/api/auth/login/device-1/cancel') {
      state.login.status = 'cancelled';
      return route.fulfill({ json: state.login });
    }
    if (path.startsWith('/api/auth/accounts/') && request.method() === 'DELETE') {
      const id = path.split('/').at(-1);
      state.overview.accounts = state.overview.accounts.filter(item => item.id !== id);
      state.overview.activeAccountId = null;
      state.overview.quota = null;
      return route.fulfill({ json: state.overview });
    }
    const captured = snapshot(state);
    if (path === '/api/summary') {
      if (state.holdNextSummary) { state.holdNextSummary = false; state.summaryHeld = true; await state.summaryGate; }
      return route.fulfill({ json: captured.summary });
    }
    if (path === '/api/sessions') return route.fulfill({ json: captured.sessions });
    if (path.startsWith('/api/sessions/')) return route.fulfill({ json: captured.detail });
    if (path === '/api/settings') return route.fulfill({ json: { monthlyBudget: null, unitVerification: null, account: null, retentionDays: null, demo: false } });
    if (path === '/api/diagnostics') return route.fulfill({ json: { items: [] } });
    if (path === '/api/refresh') return route.fulfill({ json: { refreshed: true } });
    return route.fulfill({ status: 404, json: { error: 'Unexpected test endpoint' } });
  });
}

test.afterEach(async ({ page }, testInfo) => { await page.screenshot({ path: testInfo.outputPath('accounts.png'), fullPage: true }); });

test('first run has login and collection guidance without inventing quota or account ownership', async ({ page }) => {
  const data = state([], null);
  await mock(page, data);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '登录 GitHub', exact: true })).toBeEnabled();
  await expect(page.locator('#personal-quota')).toBeHidden();
  await expect(page.locator('#github-scope')).toContainText('未分账号');
  await expect(page.locator('#github-run-command')).toHaveText('pilotmeter run --');
  await expect(page.getByText('打开此页面本身不会采集会话。', { exact: false })).toBeVisible();
  expect(data.requests.filter(item => item.method !== 'GET')).toHaveLength(0);
});

test('device code login confirms selected identity and uses CSRF without exposing credentials', async ({ page, context }, testInfo) => {
  const data = state([], null);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page, data);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: '登录 GitHub', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '登录 GitHub' })).toBeVisible();
  await page.getByRole('button', { name: '获取登录验证码' }).press('Enter');
  await expect(page.locator('#github-user-code')).toHaveText('ABCD-1234');
  await expect(page.getByRole('heading', { name: '回到此窗口', exact: true })).toBeVisible();
  await expect(page.locator('#device-login')).toContainText('会自动完成登录');
  await expect(page.getByRole('button', { name: '复制验证码' })).toBeFocused();
  await expect(page.getByRole('link', { name: '前往 GitHub 授权' })).toHaveAttribute('href', 'https://github.com/login/device');
  await page.screenshot({ path: testInfo.outputPath('login-steps.png') });
  await page.getByRole('button', { name: '复制验证码' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ABCD-1234');
  data.overview.accounts = [alice]; data.overview.activeAccountId = alice.id; data.overview.quota = quota(alice.id);
  data.login.status = 'complete'; data.login.accountId = alice.id;
  await page.clock.runFor(1_100);
  await expect(page.locator('#github-login-dialog')).toBeHidden();
  await expect(page.locator('#github-title')).toHaveText('@alice-work');
  await expect(page.locator('#primary-value')).toHaveText('1,000,000,000');
  const start = data.requests.find(item => item.path === '/api/auth/login');
  expect(start.body).toEqual({ host: 'https://github.com' });
  expect(start.headers['x-pilotmeter-csrf']).toBe('test-account-csrf');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('current quota shows exact raw quantities with unconfirmed units and keeps its own period', async ({ page }) => {
  const data = state();
  await mock(page, data);
  await page.goto('/');
  await expect(page.locator('#quota-buckets')).toContainText('37.5%');
  await expect(page.locator('.quota-primary h4')).toHaveText('高级请求');
  await expect(page.locator('.quota-primary .quota-value')).toHaveText('75 / 200');
  await expect(page.locator('.quota-primary .quota-caption')).toHaveText('已用 / 总额');
  await expect(page.locator('.quota-primary')).toContainText('原始数值 · 单位未确认');
  await expect(page.locator('#quota-buckets')).not.toContainText('重置');
  await expect(page.locator('#quota-buckets')).not.toContainText('AI Credits');
  await expect(page.locator('#quota-buckets')).not.toContainText('Premium Requests');
  await expect(page.locator('#primary-unit')).toHaveText('nano AIU');
  await expect(page.locator('.quota-period')).toContainText('不随下方月份切换');
  await page.locator('#period').fill('2025-01');
  await expect(page.locator('#quota-buckets')).toContainText('37.5%');
});

test('source used 62000 and limit 2000000 are visible in the main quota without opening details', async ({ page }) => {
  const data = state();
  Object.assign(data.overview.quota.buckets[0], { used: '62000', limit: '2000000', usedPercentage: '3.1', remainingPercentage: '96.9' });
  await mock(page, data);
  await page.goto('/');
  await expect(page.locator('.quota-primary .quota-value')).toHaveText('62,000 / 2,000,000');
  await expect(page.locator('.quota-primary .quota-value')).toBeVisible();
  await expect(page.locator('.quota-primary .quota-percentage')).toHaveText('当前周期已用 3.1%');
  await expect(page.locator('.quota-primary')).toContainText('原始数值 · 单位未确认');
});

for (const unit of ['unspecified', 'ai-credits']) {
  test(`quota preserves every source digit for ${unit} at narrow widths`, async ({ page }) => {
    const data = state();
    Object.assign(data.overview.quota.buckets[0], {
      unit, used: '9007199254740993.123456789012345678901', limit: '9007199254740994.987654321098765432109',
      usedPercentage: '99.99999999999999999999999999', remainingPercentage: '0.00000000000000000000000001',
    });
    await page.setViewportSize({ width: 320, height: 900 });
    await mock(page, data);
    await page.goto('/');
    await expect(page.locator('.quota-primary .quota-value')).toHaveText('9,007,199,254,740,993.123456789012345678901 / 9,007,199,254,740,994.987654321098765432109');
    await expect(page.locator('.quota-primary .quota-percentage')).toHaveText('当前周期已用 99.99999999999999999999999999%');
    await expect(page.locator('.quota-primary')).not.toContainText('≈');
    await expect(page.locator('.quota-primary')).not.toContainText('×10');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.quota-primary').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const sections = await page.locator('.quota-primary > *').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
    }));
    for (let index = 1; index < sections.length; index++) expect(sections[index].top).toBeGreaterThanOrEqual(sections[index - 1].bottom);
  });
}

test('premium is the visible main category and unlimited categories stay under a persistent native disclosure', async ({ page }) => {
  // Deliberately artificial values; never sourced from a real account or screenshot.
  const data = state();
  const premium = { ...data.overview.quota.buckets[0], used: '432', limit: '1728', usedPercentage: '25', remainingPercentage: '75' };
  data.overview.quota.buckets = [
    { ...premium, key: 'chat', unlimited: true },
    { ...premium, key: 'completions', unlimited: true }, premium,
  ];
  await mock(page, data);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.quota-primary h4')).toHaveText('高级请求');
  await expect(page.locator('.quota-primary .quota-value')).toHaveText('432 / 1,728');
  await expect(page.locator('.quota-primary .quota-percentage')).toHaveText('当前周期已用 25%');
  await expect(page.locator('.quota-other')).not.toHaveAttribute('open', '');
  await expect(page.locator('[data-quota-key="chat"]')).toBeHidden();
  await page.locator('.quota-other > summary').press('Enter');
  await expect(page.locator('[data-quota-key="chat"] h4')).toHaveText('聊天');
  await expect(page.locator('[data-quota-key="completions"] h4')).toHaveText('代码补全');
  await expect(page.locator('[data-quota-key="chat"] .quota-value')).toHaveText('无固定上限');
  await expect(page.locator('[data-quota-key="completions"] .quota-value')).toHaveText('无固定上限');
  await page.clock.runFor(5_100);
  await expect(page.locator('.quota-other')).toHaveAttribute('open', '');
  await expect(page.locator('.quota-other > summary')).toBeFocused();
});

test('multiple unrecognized finite categories stay independent until explicitly selected', async ({ page }) => {
  const data = state();
  const bucket = data.overview.quota.buckets[0];
  data.overview.quota.buckets = [
    { ...bucket, key: 'synthetic_first', usedPercentage: '20', used: '20', limit: '100', unit: 'ai-credits' },
    { ...bucket, key: 'synthetic_second', usedPercentage: '80', used: '400', limit: '500', unit: 'premium-requests' },
  ];
  await mock(page, data);
  await page.goto('/');
  await expect(page.locator('.quota-primary')).toHaveCount(0);
  await expect(page.getByLabel('查看额度类别')).toHaveValue('');
  await expect(page.locator('#quota-buckets')).toContainText('不合并数量或比例');
  await expect(page.locator('[data-quota-key="synthetic_first"]')).toBeVisible();
  await expect(page.locator('[data-quota-key="synthetic_second"]')).toBeVisible();
  await page.getByLabel('查看额度类别').selectOption('synthetic_second');
  await expect(page.locator('.quota-primary h4')).toHaveText('其他额度 · synthetic_second');
  await expect(page.locator('.quota-primary .quota-value')).toHaveText('400 / 500');
  await expect(page.locator('.quota-primary .quota-percentage')).toHaveText('当前周期已用 80%');
  await expect(page.locator('.quota-primary')).toContainText('400 / 500 Premium Requests');
  await expect(page.locator('#quota-buckets')).not.toContainText('420');
});

test('only a future reset is presented as the next reset and quota from a different identity is hidden', async ({ page }) => {
  const data = state();
  data.overview.quota.buckets[0].resetAt = new Date(Date.now() + 86_400_000).toISOString();
  await mock(page, data);
  await page.goto('/');
  await expect(page.locator('.quota-primary')).toContainText('下次重置');
  data.overview.quota.accountId = bob.id;
  await page.getByRole('button', { name: '同步额度', exact: true }).click();
  await expect(page.locator('#quota-buckets')).toBeEmpty();
  await expect(page.locator('#quota-status')).toContainText('尚未取得');
});

test('manual quota sync is pinned to its account and stays disabled until the refreshed values arrive', async ({ page }) => {
  const data = state();
  await page.clock.install();
  await mock(page, data);
  await page.goto('/');
  await expect(page.locator('.quota-primary .quota-value')).toHaveText('75 / 200');
  data.overview.refreshing = true;
  await page.getByRole('button', { name: '同步额度', exact: true }).click();
  await expect(page.locator('#github-refresh')).toBeDisabled();
  await expect(page.locator('#quota-status')).toContainText('正在同步');
  const request = data.requests.find(item => item.path === '/api/auth/refresh');
  expect(new URLSearchParams(request.query).get('accountId')).toBe(alice.id);
  Object.assign(data.overview.quota.buckets[0], { used: '100', usedPercentage: '50', remainingPercentage: '50' });
  data.overview.refreshing = false;
  await page.clock.runFor(5_100);
  await expect(page.locator('.quota-primary .quota-value')).toHaveText('100 / 200');
  await expect(page.locator('#github-refresh')).toBeEnabled();
});

test('switch clears old sessions and dialog immediately and ignores late old snapshot', async ({ page }) => {
  const data = state();
  await mock(page, data);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: /查看会话/ }).click();
  await expect(page.locator('#detail-body')).toContainText('1,000,000,000');
  let releaseSummary;
  data.summaryGate = new Promise(resolve => { releaseSummary = resolve; });
  data.holdNextSummary = true;
  await page.clock.runFor(5_100);
  await expect.poll(() => data.summaryHeld).toBe(true);
  await page.keyboard.press('Escape');
  let releaseSelect;
  data.selectGate = new Promise(resolve => { releaseSelect = resolve; });
  await page.locator('#github-select').selectOption('account-b');
  await expect(page.locator('#primary-value')).toHaveText('—');
  await expect(page.locator('.session-row')).toHaveCount(0);
  await expect(page.locator('#detail-body')).toBeEmpty();
  await expect(page.locator('#personal-quota')).toBeHidden();
  releaseSelect();
  await expect(page.locator('#primary-value')).toHaveText('2,000,000,000');
  await expect(page.locator('#sessions')).toContainText('bob-session');
  releaseSummary();
  await expect(page.locator('#github-title')).toHaveText('@bob-personal');
  await expect(page.locator('#primary-value')).toHaveText('2,000,000,000');
  await expect(page.locator('#sessions')).not.toContainText('alice-session');
  const select = data.requests.find(item => item.path === '/api/auth/select');
  expect(select.body).toEqual({ accountId: bob.id });
  expect(select.headers['x-pilotmeter-csrf']).toBe('test-account-csrf');
  expect(data.requests.filter(item => ['/api/summary', '/api/sessions', '/api/settings'].includes(item.path)).every(item => item.query.includes('accountId=account-'))).toBe(true);
});

test('cancel, expired retry and reauthentication remain usable by keyboard', async ({ page }) => {
  const data = state();
  await mock(page, data);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: '重新登录', exact: true }).click();
  await page.getByRole('button', { name: '获取登录验证码' }).press('Enter');
  await expect(page.locator('#github-user-code')).toBeVisible();
  expect(data.requests.find(item => item.path === '/api/auth/login').body.accountId).toBe(alice.id);
  data.login.status = 'expired';
  await page.clock.runFor(1_100);
  await expect(page.locator('#login-status')).toContainText('已过期');
  data.login.status = 'pending';
  await page.getByRole('button', { name: '重新获取验证码' }).press('Enter');
  await expect(page.locator('#github-user-code')).toBeVisible();
  expect(data.loginStarts).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#github-login-dialog')).toBeHidden();
  await expect.poll(() => data.requests.some(item => item.path.endsWith('/cancel'))).toBe(true);
  await expect(page.locator('#primary-value')).toHaveText('1,000,000,000');
});

test('expired code retry clears old copy feedback and failed authorization explains recovery', async ({ page, context }) => {
  const data = state([], null);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page, data);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: '登录 GitHub', exact: true }).click();
  await page.getByRole('button', { name: '获取登录验证码' }).click();
  await page.getByRole('button', { name: '复制验证码' }).click();
  await expect(page.locator('#copy-code-feedback')).toHaveText('已复制。');
  data.login.status = 'expired';
  await page.clock.runFor(1_100);
  await expect(page.locator('#github-user-code')).toBeHidden();
  await expect(page.locator('#login-status')).toContainText('复制新码');
  data.login.status = 'pending'; data.login.userCode = 'WXYZ-9876';
  await page.getByRole('button', { name: '重新获取验证码' }).click();
  await expect(page.locator('#github-user-code')).toHaveText('WXYZ-9876');
  await expect(page.locator('#copy-code-feedback')).toBeEmpty();
  data.login.status = 'failed'; data.login.error = { code: 'LOGIN_FAILED', message: 'GitHub 未批准此次授权。' };
  await page.clock.runFor(1_100);
  await expect(page.locator('#login-status')).toContainText('GitHub 未批准此次授权。');
  await expect(page.locator('#login-status')).toContainText('重新获取验证码');
  await expect(page.locator('#login-status')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#github-user-code')).toBeHidden();
});

test('enterprise account login validates host, while account removal requires explicit local confirmation', async ({ page }) => {
  const data = state();
  await mock(page, data);
  await page.goto('/');
  await page.getByRole('button', { name: '添加账号' }).click();
  await page.getByRole('textbox', { name: 'GitHub 地址' }).fill('https://example.com');
  await page.getByRole('button', { name: '获取登录验证码' }).click();
  await expect(page.locator('#login-status')).toContainText('请输入 https://github.com');
  expect(data.loginStarts).toBe(0);
  await page.getByRole('textbox', { name: 'GitHub 地址' }).fill('https://work.ghe.com');
  await page.getByRole('button', { name: '获取登录验证码' }).click();
  await expect(page.getByRole('link', { name: '前往 GitHub 授权' })).toHaveAttribute('href', 'https://work.ghe.com/login/device');
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await page.getByRole('button', { name: '移除账号', exact: true }).click();
  await expect(page.locator('#remove-description')).toContainText('alice-work');
  await expect(page.getByRole('button', { name: '保留账号' })).toBeFocused();
  expect(data.requests.some(item => item.method === 'DELETE')).toBe(false);
  await page.getByRole('button', { name: '确认移除' }).click();
  await expect(page.locator('#github-select option')).toHaveCount(2);
  await expect(page.locator('#personal-quota')).toBeHidden();
  await expect(page.locator('#primary-value')).toHaveText('3,000,000,000');
  expect(data.requests.find(item => item.method === 'DELETE').headers['x-pilotmeter-csrf']).toBe('test-account-csrf');
});

test('account endpoint failure and reauthentication error do not suppress local records', async ({ page }) => {
  const data = state();
  data.overview.accounts = [{ ...alice, status: 'reauth-required' }, bob];
  data.overview.quota = { ...quota(alice.id), state: 'error', stale: true, error: { code: 'UNAUTHORIZED', message: '凭据已失效' } };
  await mock(page, data);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#github-description')).toContainText('请重新登录');
  await expect(page.locator('#quota-status')).toContainText('请重新登录');
  await expect(page.locator('#quota-buckets')).toBeEmpty();
  await expect(page.locator('#primary-value')).toHaveText('1,000,000,000');
  data.authOffline = true;
  await page.clock.runFor(5_100);
  await expect(page.locator('#github-feedback')).toContainText('账号连接读取失败');
  await expect(page.locator('#connection')).toHaveText('本地服务已连接');
});

test('320px accounts and device dialog stay in viewport and render account metadata as text', async ({ page }, testInfo) => {
  const data = state([{ ...alice, login: '<img src=x onerror=alert(1)>-very-long-account-name' }, bob]);
  await page.setViewportSize({ width: 320, height: 900 });
  await mock(page, data);
  await page.goto('/');
  await expect(page.locator('#github-title')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#github-accounts img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '添加账号' }).click();
  await page.getByRole('button', { name: '获取登录验证码' }).click();
  await expect(page.locator('#github-user-code')).toBeVisible();
  expect(await page.locator('#github-login-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const sections = await page.locator('#device-login > li, #login-status, .login-footer').evaluateAll(elements => elements.filter(element => element.closest('#github-login-dialog')).map(element => {
    const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
  }));
  expect(sections).toHaveLength(5);
  for (let index = 1; index < sections.length; index++) expect(sections[index].top).toBeGreaterThanOrEqual(sections[index - 1].bottom);
  await page.screenshot({ path: testInfo.outputPath('login-steps-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '添加账号' })).toBeFocused();
});

test('demo mode cannot initiate account mutations', async ({ page }) => {
  const data = state([], null); data.overview.enabled = false;
  await mock(page, data);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '登录 GitHub', exact: true })).toBeDisabled();
  await expect(page.locator('#github-feedback')).toContainText('演示模式');
  expect(data.requests.filter(item => item.method !== 'GET')).toHaveLength(0);
});

test('unfinished device login can resume after reopening the dashboard without issuing another authorization', async ({ page }) => {
  const data = state([], null); data.overview.login = data.login;
  await mock(page, data);
  await page.goto('/');
  await page.getByRole('button', { name: '继续登录', exact: true }).click();
  await expect(page.locator('#github-user-code')).toHaveText('ABCD-1234');
  expect(data.loginStarts).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '登录 GitHub', exact: true })).toBeEnabled();
});

test('unexpected authorization URL is never exposed as a clickable login target', async ({ page }) => {
  const data = state([], null); data.unsafeVerification = 'https://github.com.attacker.invalid/login/device';
  await mock(page, data);
  await page.goto('/');
  await page.getByRole('button', { name: '登录 GitHub', exact: true }).click();
  await page.getByRole('button', { name: '获取登录验证码' }).click();
  await expect(page.locator('#login-status')).toContainText('授权地址无法验证');
  await expect(page.locator('#github-verification-link')).not.toHaveAttribute('href');
  await expect(page.getByRole('link', { name: '前往 GitHub 授权' })).toHaveCount(0);
});
