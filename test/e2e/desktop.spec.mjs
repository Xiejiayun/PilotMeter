import { test, expect } from '@playwright/test';
import { aliceId, bobId, desktopCsrf, desktopFixture, desktopSnapshot, mockDesktop, pendingDesktopLogin, queueDesktopReply } from '../fixtures/desktop-browser.mjs';

const exact = ['123.456789012345678901', '987.654312098765431208', '864.197523086419752307'];
const values = page => page.locator('#quota-area .metric-value');

async function open(page, data, options) {
  await mockDesktop(page, data, options);
  await page.goto('/desktop.html');
  if (!options?.bridge && data.accounts.length) await expect(page.locator('#account-select')).toBeEnabled();
}

async function addAccount(page) {
  await page.locator('[data-page="accounts"]').click();
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.locator('#login-dialog')).toBeVisible();
}

async function noHorizontalPageOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function hostState(page, data, overrides = {}) {
  const state = { type: 'service-state', connected: true, epoch: 1, instanceId: data.identity.instanceId,
    version: data.identity.version, recoverable: false, recovering: false, message: '',
    accountId: data.activeAccountId, quotaKey: null, ...overrides };
  await page.evaluate(message => window.__desktopBridgeReceive(message), state);
}

test('desktop shows all source digits in used, total and remaining quantities', async ({ page }, testInfo) => {
  const data = desktopFixture();
  await open(page, data);
  await expect(values(page)).toHaveText(exact);
  await expect(page.locator('#quota-area')).toContainText('AI Credits');
  await expect(page.locator('#quota-area')).toContainText('12.5%');
  await expect(page.locator('#quota-area')).not.toContainText('≈');
  await expect(page.locator('#quota-area .other-quota')).toHaveCount(0);
  await expect(page.locator('#account-select')).toHaveValue(aliceId);
  await noHorizontalPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-overview.png'), fullPage: true });
});

test('manual sync waits for the provider snapshot and updates quota, models and fetch time', async ({ page }) => {
  const data = desktopFixture();
  data.quotas[aliceId].fetchedAt = new Date(Date.now() - 120_000).toISOString();
  await page.clock.install();
  await open(page, data);
  await expect(values(page)).toHaveText(exact);
  const previousTime = await page.locator('#last-sync').textContent();
  data.refreshing = true;
  await page.locator('#refresh-button').click();
  await expect(page.locator('#refresh-button')).toHaveText('同步中');
  await expect(page.locator('#refresh-button')).toBeDisabled();
  await expect(page.locator('#feedback')).toContainText('正在同步');
  await expect(values(page)).toHaveText(exact);
  expect(new URLSearchParams(data.requests.find(item => item.path === '/api/auth/refresh').query).get('accountId')).toBe(aliceId);

  Object.assign(data.quotas[aliceId].buckets[0], { used: '200', limit: '1000', usedPercentage: '20', remainingPercentage: '80' });
  data.quotas[aliceId].fetchedAt = new Date().toISOString();
  data.modelSets[aliceId].items[0].name = 'Updated Alpha Vision';
  data.refreshing = false;
  await page.clock.runFor(1_600);
  await expect(values(page)).toHaveText(['200', '1,000', '800']);
  await expect(page.locator('#last-sync')).not.toHaveText(previousTime);
  await expect(page.locator('#model-preview-list')).toContainText('Updated Alpha Vision');
  await expect(page.locator('#feedback')).toContainText('已读取 GitHub 返回的额度和模型快照');
  await expect(page.locator('#feedback')).not.toContainText('最新');
  await expect(page.locator('#refresh-button')).toBeEnabled();
});

test('a sync completion for another account cannot report success for the current account', async ({ page }) => {
  const data = desktopFixture();
  await page.clock.install();
  await open(page, data);
  data.refreshing = true;
  await page.locator('#refresh-button').click();
  await expect(page.locator('#refresh-button')).toHaveText('同步中');
  // Another window selects a different account while this one waits for sync.
  data.activeAccountId = bobId;
  data.refreshing = false;
  await page.clock.runFor(1_600);
  await expect(page.locator('#account-select')).toHaveValue(bobId);
  await expect(values(page)).toHaveText(['44', '100', '56']);
  await expect(page.locator('#feedback')).toContainText('当前账号已切换');
  await expect(page.locator('#feedback')).not.toContainText('已读取');
});

test('unknown quantity units preserve raw values but show remaining percentage without inventing a balance', async ({ page }) => {
  const data = desktopFixture({ unit: 'unspecified' });
  Object.assign(data.quotas[aliceId].buckets[0], { used: '62000', limit: '2000000', usedPercentage: '3.1', remainingPercentage: '96.9' });
  await open(page, data);
  await expect(values(page)).toHaveText(['62,000', '2,000,000', '96.9%']);
  await expect(page.locator('#quota-area')).toContainText(/单位(?:待|未)确认/);
  await expect(page.locator('#quota-area')).not.toContainText('1,938,000');
  await expect(page.locator('#quota-area .quota-unit')).toContainText('单位待确认');
  await expect(page.locator('#quota-area .quota-metrics')).not.toContainText('AI Credits');
  await expect(page.locator('#quota-area .quota-metrics')).not.toContainText('Premium Requests');
});

test('first run invites login without fabricating a zero balance or account models', async ({ page }) => {
  const data = desktopFixture({ accounts: false });
  await open(page, data);
  await expect(page.locator('#quota-area [data-action="login"]')).toBeEnabled();
  await expect(values(page)).toHaveCount(0);
  await expect(page.locator('#model-preview-list')).not.toContainText('Alpha Vision');
  expect(data.requests.filter(item => item.method !== 'GET')).toHaveLength(0);
});

for (const viewport of [{ width: 1440, height: 1050 }, { width: 1024, height: 900 }, { width: 760, height: 900 }, { width: 720, height: 525 }]) {
  test(`desktop long quantities remain reachable without overlapping at ${viewport.width}px`, async ({ page }, testInfo) => {
    const data = desktopFixture();
    Object.assign(data.quotas[aliceId].buckets[0], {
      used: '9007199254740993.123456789012345678901', limit: '9007199254740994.987654321098765432109',
      usedPercentage: '99.99999999999999999999999999', remainingPercentage: '0.00000000000000000000000001',
    });
    await page.setViewportSize(viewport);
    await open(page, data);
    await expect(values(page)).toHaveText([
      '9,007,199,254,740,993.123456789012345678901',
      '9,007,199,254,740,994.987654321098765432109', '1.864197532086419753208',
    ]);
    await noHorizontalPageOverflow(page);
    const metrics = await page.locator('#quota-area .quota-metric').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }));
    expect(metrics).toHaveLength(3);
    for (let index = 1; index < metrics.length; index++) {
      const previous = metrics[index - 1]; const current = metrics[index];
      expect(current.left >= previous.right - 1 || current.top >= previous.bottom - 1).toBe(true);
    }
    const reachability = await values(page).evaluateAll(elements => elements.map(element => {
      element.scrollLeft = element.scrollWidth;
      return { clipped: element.scrollWidth > element.clientWidth + 1,
        reachedEnd: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
        overflow: getComputedStyle(element).overflowX };
    }));
    for (const value of reachability) if (value.clipped) {
      expect(['auto', 'scroll']).toContain(value.overflow); expect(value.reachedEnd).toBe(true);
    }
    await values(page).evaluateAll(elements => elements.forEach(element => { element.scrollLeft = 0; }));
    await page.screenshot({ path: testInfo.outputPath(`desktop-${viewport.width}.png`), fullPage: true });
  });
}

test('models search combines with availability filters and keeps model details', async ({ page }, testInfo) => {
  const data = desktopFixture();
  await open(page, data);
  await page.locator('[data-page="models"]').click();
  const cards = page.locator('#models-list .model-card');
  await expect(cards).toHaveCount(3);
  await page.locator('[data-model-filter="available"]').click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('Alpha Vision');
  await page.locator('#model-search').fill('beta');
  await expect(cards).toHaveCount(0);
  await page.locator('[data-model-filter="disabled"]').click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('Beta Reasoner');
  await expect(cards).toContainText('组织策略停用');
  await page.locator('#model-search').fill('');
  await page.locator('[data-model-filter="unknown"]').click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('Gamma Unknown');
  await page.locator('[data-model-filter="all"]').click();
  await expect(cards).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('desktop-models.png'), fullPage: true });
});

test('account switching clears the previous quota and models while waiting, then shows only the new account', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await expect(values(page)).toHaveText(exact);
  await page.locator('[data-page="models"]').click();
  await expect(page.locator('#models-list')).toContainText('Alpha Vision');
  const selection = queueDesktopReply(data, '/api/auth/select', { method: 'POST', hold: true });
  try {
    await page.locator('#account-select').selectOption(bobId);
    await selection.arrived;
    await expect(page.locator('#quota-area')).not.toContainText(exact[0]);
    await expect(page.locator('#models-list')).not.toContainText('Alpha Vision');
    await expect(page.locator('#account-select')).toBeDisabled();
  } finally { selection.release(); }
  await expect(page.locator('#account-select')).toBeEnabled();
  await expect(page.locator('#account-select')).toHaveValue(bobId);
  await expect(page.locator('#models-list .model-card')).toHaveCount(1);
  await expect(page.locator('#models-list')).toContainText('Bob Private Model');
  await page.locator('[data-page="overview"]').click();
  await expect(values(page)).toHaveText(['44', '100', '56']);
  await page.locator('[data-page="records"]').click();
  await expect(page.locator('#records-list')).toContainText('bob-session');
  await expect(page.locator('#records-list')).not.toContainText('alice-session');
  const selected = data.requests.find(item => item.path === '/api/auth/select');
  expect(selected.body).toEqual({ accountId: bobId });
  expect(selected.headers['x-pilotmeter-csrf']).toBe(desktopCsrf);
});

test('a delayed overview from the previous account cannot overwrite the newly selected account', async ({ page }) => {
  const data = desktopFixture();
  await page.clock.install();
  await open(page, data);
  await expect(values(page)).toHaveText(exact);
  const previous = queueDesktopReply(data, '/api/desktop', { json: desktopSnapshot(data), hold: true });
  try {
    await page.clock.runFor(30_100);
    await previous.arrived;
    await page.locator('#account-select').selectOption(bobId);
    await expect(page.locator('#account-select')).toHaveValue(bobId);
    await expect(values(page)).toHaveText(['44', '100', '56']);
  } finally { previous.release(); }
  await expect(values(page)).toHaveText(['44', '100', '56']);
  await page.locator('[data-page="models"]').click();
  await expect(page.locator('#models-list')).toContainText('Bob Private Model');
  await expect(page.locator('#models-list')).not.toContainText('Alpha Vision');
});

test('account and model metadata are rendered as text without executing markup', async ({ page }) => {
  const data = desktopFixture();
  data.accounts[0].login = '<img src=x onerror=alert(1)>-account';
  data.modelSets[aliceId].items[0].name = '<svg onload=alert(1)>-model';
  await open(page, data);
  await page.locator('[data-page="accounts"]').click();
  await expect(page.locator('#accounts-list')).toContainText('<img src=x onerror=alert(1)>-account');
  await expect(page.locator('#accounts-list img')).toHaveCount(0);
  await page.locator('[data-page="models"]').click();
  await expect(page.locator('#models-list')).toContainText('<svg onload=alert(1)>-model');
  await expect(page.locator('#models-list [onload], #models-list [onerror]')).toHaveCount(0);
});

test('login opens immediately while code acquisition is pending and explains the three steps', async ({ page }, testInfo) => {
  const data = desktopFixture();
  const acquisition = queueDesktopReply(data, '/api/auth/login', { method: 'POST', hold: true });
  await open(page, data);
  try {
    await addAccount(page);
    await acquisition.arrived;
    await expect(page.locator('#login-status')).toContainText(/正在|准备/);
    await expect(page.locator('#copy-login-code')).toBeDisabled();
    await expect(page.locator('#open-github')).toBeDisabled();
    await expect(page.locator('.login-steps > li')).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('desktop-login-loading.png') });
  } finally { acquisition.release(); }
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  await expect(page.locator('#copy-login-code')).toBeEnabled();
  await expect(page.locator('#open-github')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('desktop-login-code.png') });
});

test('code acquisition failure offers retry and a closed login can be opened again', async ({ page }) => {
  const data = desktopFixture();
  queueDesktopReply(data, '/api/auth/login', { method: 'POST', status: 503, json: { error: '暂时无法连接 GitHub。' } });
  await open(page, data);
  await addAccount(page);
  await expect(page.locator('#login-status')).toContainText(/失败|无法|重试/);
  await expect(page.locator('#login-retry')).toBeVisible();
  await expect(page.locator('#login-retry')).toBeEnabled();
  await page.locator('#login-retry').click();
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect(page.locator('#login-dialog')).toBeHidden();
  await page.locator('#accounts-page [data-action="login"]').click();
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  const starts = data.requests.filter(item => item.path === '/api/auth/login');
  expect(starts).toHaveLength(3);
  expect(starts.every(item => item.headers['x-pilotmeter-csrf'] === desktopCsrf)).toBe(true);
});

test('expired authorization clears the unusable code and retry starts a fresh login', async ({ page }) => {
  const data = desktopFixture();
  await page.clock.install();
  await open(page, data);
  await addAccount(page);
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  data.login.status = 'expired';
  await page.clock.runFor(2_100);
  await expect(page.locator('#login-status')).toContainText('过期');
  await expect(page.locator('#copy-login-code')).toBeDisabled();
  await expect(page.locator('#open-github')).toBeDisabled();
  await expect(page.locator('#login-code')).not.toHaveText('ABCD-1234');
  await page.locator('#login-retry').click();
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  expect(data.loginStarts).toBe(2);
});

test('a device code expires locally even when its status request is still pending', async ({ page }) => {
  const data = desktopFixture();
  data.nextLogin = { expiresAt: new Date(Date.now() + 60_000).toISOString() };
  // Hold the very first poll before opening the dialog; this is deterministic
  // even if the dialog's first status response normally arrives immediately.
  const status = queueDesktopReply(data, '/api/auth/login/cccccccc-cccc-4ccc-8ccc-000000000001', { hold: true });
  await page.clock.install();
  await open(page, data);
  await addAccount(page);
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  try {
    await status.arrived;
    await page.clock.runFor(60_100);
    await expect(page.locator('#login-status')).toContainText('过期');
    await expect(page.locator('#open-github')).toBeDisabled();
    await expect(page.locator('#copy-login-code')).toBeDisabled();
    await expect(page.locator('#login-code')).not.toHaveText('ABCD-1234');
  } finally { status.release(); }
});

test('completed authorization displays the confirmed account and keeps secrets out of browser storage', async ({ page, context }) => {
  const data = desktopFixture({ accounts: false });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.install();
  await open(page, data);
  await addAccount(page);
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  await page.locator('#copy-login-code').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ABCD-1234');
  data.accounts = [desktopFixture().accounts[0]]; data.activeAccountId = aliceId;
  data.login.status = 'complete'; data.login.accountId = aliceId;
  await page.clock.runFor(2_100);
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(page.locator('#account-select')).toHaveValue(aliceId);
  await page.locator('[data-page="overview"]').click();
  await expect(values(page)).toHaveText(exact);
  expect(data.requests.find(item => item.path === '/api/auth/login').headers['x-pilotmeter-csrf']).toBe(desktopCsrf);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});

test('a late status response from a cancelled login cannot replace a newer code', async ({ page }) => {
  const data = desktopFixture();
  await page.clock.install();
  await open(page, data);
  await addAccount(page);
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  const firstId = data.login.id;
  const oldStatus = queueDesktopReply(data, `/api/auth/login/${firstId}`, { hold: true });
  try {
    await page.clock.runFor(2_100);
    await oldStatus.arrived;
    await page.getByRole('button', { name: '取消登录', exact: true }).click();
    await expect(page.locator('#login-dialog')).toBeHidden();
    await page.locator('#accounts-page [data-action="login"]').click();
    await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  } finally { oldStatus.release(); }
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  await page.clock.runFor(2_100);
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  expect(data.login.id).not.toBe(firstId);
});

test('unsafe authorization URLs never become a clickable or opened login target', async ({ page }) => {
  const data = desktopFixture();
  data.nextLogin = { verificationUri: 'https://github.com.attacker.invalid/login/device' };
  await page.addInitScript(() => { window.__openedUrls = []; window.open = url => { window.__openedUrls.push(String(url)); return null; }; });
  await open(page, data);
  await addAccount(page);
  await expect(page.locator('#login-status')).toContainText(/地址|验证/);
  await expect(page.locator('#open-github')).toBeDisabled();
  expect(await page.evaluate(() => window.__openedUrls)).toEqual([]);
  await expect(page.locator('#login-dialog a[href*="attacker"]')).toHaveCount(0);
});

test('authorized external navigation uses only the verified GitHub device URL', async ({ page }) => {
  const data = desktopFixture();
  await page.addInitScript(() => { window.__openedUrls = []; window.open = url => { window.__openedUrls.push(String(url)); return null; }; });
  await open(page, data);
  await addAccount(page);
  await expect(page.locator('#open-github')).toBeEnabled();
  await page.locator('#open-github').click();
  expect(await page.evaluate(() => window.__openedUrls)).toEqual(['https://github.com/login/device']);
});

test('the desktop host acknowledges a mutation before login starts, with the operation epoch pinned', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data, { bridge: true });
  await expect.poll(() => page.evaluate(() => window.__desktopBridgeMessages.some(message => message.type === 'ready'))).toBe(true);
  await hostState(page, data);
  await expect(page.locator('#account-select')).toBeEnabled();
  await page.evaluate(() => { window.__desktopAutoAcknowledge = false; });
  await addAccount(page);
  await expect(page.locator('#login-status')).toContainText(/正在|准备/);
  await expect.poll(() => page.evaluate(() => window.__desktopBridgeMessages.find(message => message.type === 'account-mutation' && message.pending === true))).toBeTruthy();
  // The modal is already visible while the host has yet to confirm ownership.
  expect(data.requests.filter(item => item.path === '/api/auth/login')).toHaveLength(0);
  await page.evaluate(() => {
    const message = window.__desktopBridgeMessages.find(item => item.type === 'account-mutation' && item.pending === true);
    window.__desktopAutoAcknowledge = true;
    window.__desktopBridgeReceive({ type: 'account-mutation-state', pending: true, operationId: message.operationId, epoch: message.epoch });
  });
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  const start = data.requests.find(item => item.path === '/api/auth/login');
  expect(start.headers['x-pilotmeter-csrf']).toBe(desktopCsrf);
  expect(start.headers['x-pilotmeter-instance']).toBe(data.identity.instanceId);
  const ownership = await page.evaluate(() => window.__desktopBridgeMessages.filter(message => message.type === 'account-mutation'));
  expect(ownership).toHaveLength(1);
  expect(ownership[0]).toMatchObject({ pending: true, epoch: 1 });
  await page.locator('#open-github').click();
  await expect.poll(() => page.evaluate(() => window.__desktopBridgeMessages.some(message => message.type === 'open-external'
    && message.url === 'https://github.com/login/device' && typeof message.loginId === 'string' && message.epoch === 1))).toBe(true);
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__desktopBridgeMessages.filter(message => message.type === 'account-mutation').at(-1)?.pending)).toBe(false);
  const mutations = await page.evaluate(() => window.__desktopBridgeMessages.filter(message => message.type === 'account-mutation'));
  expect(mutations[0].pending).toBe(true);
  expect(mutations[0].epoch).toBe(1);
  expect(mutations.at(-1)).toMatchObject({ pending: false, operationId: mutations[0].operationId, epoch: 1 });
});

test('service replacement removes old account data and reconnects using the new instance', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data, { bridge: true });
  await hostState(page, data);
  await expect(values(page)).toHaveText(exact);
  await hostState(page, data, { connected: false, epoch: 2, instanceId: null, version: null,
    message: '本机服务已更换，请重新连接。', recoverable: true });
  await expect(page.locator('#service-banner')).toContainText('本机服务已更换');
  await expect(values(page)).toHaveCount(0);
  await expect(page.locator('#refresh-button')).toBeDisabled();
  await expect(page.locator('#restart-button')).toBeVisible();
  await page.locator('#restart-button').click();
  await expect.poll(() => page.evaluate(() => window.__desktopBridgeMessages.some(message => message.type === 'restart-service' && message.epoch === 2))).toBe(true);
  data.activeAccountId = bobId;
  data.identity.instanceId = '22222222-2222-4222-8222-222222222222';
  await hostState(page, data, { epoch: 3 });
  await expect(page.locator('#account-select')).toHaveValue(bobId);
  await expect(values(page)).toHaveText(['44', '100', '56']);
  expect(data.requests.filter(item => item.path === '/api/desktop').at(-1).headers['x-pilotmeter-instance']).toBe(data.identity.instanceId);
});

test('a login response from an old service epoch neither restores its code nor cancels against the new service', async ({ page }) => {
  const data = desktopFixture();
  const acquisition = queueDesktopReply(data, '/api/auth/login', { method: 'POST', hold: true });
  await open(page, data, { bridge: true });
  await hostState(page, data);
  await expect(page.locator('#account-select')).toBeEnabled();
  let oldId;
  try {
    await addAccount(page);
    await acquisition.arrived;
    oldId = data.login.id;
    data.login = null;
    data.identity.instanceId = '22222222-2222-4222-8222-222222222222';
    await hostState(page, data, { epoch: 2 });
    await expect(page.locator('#login-status')).toContainText(/服务|切换|重新/);
    await expect(page.locator('#open-github')).toBeDisabled();
  } finally { acquisition.release(); }
  await expect(page.locator('#login-code')).not.toHaveText('ABCD-1234');
  await expect(page.locator('#login-retry')).toBeVisible();
  await page.locator('#login-retry').click();
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  expect(data.requests.filter(item => item.path === `/api/auth/login/${oldId}/cancel`
    && item.headers['x-pilotmeter-instance'] === data.identity.instanceId)).toHaveLength(0);
});

test('reauthentication recovers its matching pending login after the start response is lost', async ({ page }) => {
  const data = desktopFixture();
  data.accounts[0].status = 'reauth-required';
  // The daemon starts the flow, then the network drops the POST response.
  queueDesktopReply(data, '/api/auth/login', { method: 'POST', abort: 'failed' });
  await page.clock.install();
  await open(page, data);
  await page.locator('[data-page="accounts"]').click();
  await page.locator(`#accounts-page [data-action="reauth"][data-account="${aliceId}"]`).click();
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  await expect(page.locator('#open-github')).toBeEnabled();
  expect(data.login.targetAccountId).toBe(aliceId);
  expect(data.loginStarts).toBe(1);
  expect(data.requests.filter(item => item.path === '/api/auth/login')).toHaveLength(1);
  expect(data.requests.some(item => item.path === '/api/auth/accounts')).toBe(true);
  data.accounts[0].status = 'connected';
  data.login.status = 'complete'; data.login.accountId = aliceId;
  await page.clock.runFor(2_100);
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(page.locator('#account-select')).toHaveValue(aliceId);
  await page.locator('[data-page="overview"]').click();
  await expect(values(page)).toHaveText(exact);
});

test('reauthentication cancels a conflicting recovered target before starting the selected account', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await expect(page.locator('#account-select')).toHaveValue(aliceId);
  // Another flow starts after this page's overview was loaded.
  const conflict = pendingDesktopLogin(data, { targetAccountId: bobId });
  queueDesktopReply(data, '/api/auth/login', { method: 'POST', status: 409, json: { error: '请先完成或取消当前登录。' } });
  const cancellation = queueDesktopReply(data, `/api/auth/login/${conflict.id}/cancel`, { method: 'POST', hold: true });
  try {
    await page.locator('[data-page="accounts"]').click();
    await page.locator(`#accounts-page [data-action="reauth"][data-account="${aliceId}"]`).click();
    await cancellation.arrived;
    await expect(page.locator('#login-dialog')).toBeVisible();
    await expect(page.locator('#login-code')).not.toHaveText('ABCD-1234');
    await expect(page.locator('#open-github')).toBeDisabled();
  } finally { cancellation.release(); }
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  expect(data.login.targetAccountId).toBe(aliceId);
  const starts = data.requests.filter(item => item.path === '/api/auth/login');
  expect(starts).toHaveLength(2);
  expect(starts.every(item => item.body.accountId === aliceId)).toBe(true);
  expect(data.requests.findIndex(item => item.path.endsWith(`/${conflict.id}/cancel`))).toBeLessThan(data.requests.findLastIndex(item => item.path === '/api/auth/login'));
});

test('reauthentication cannot treat completion of another target as success for the selected account', async ({ page }) => {
  const data = desktopFixture();
  const conflict = pendingDesktopLogin(data, { targetAccountId: bobId });
  await open(page, data);
  await expect(page.locator('#account-select')).toHaveValue(aliceId);
  // The overview saw pending, but cancellation races with a different account
  // completing. That result must not finish Alice's requested reauthentication.
  conflict.status = 'complete'; conflict.accountId = bobId;
  await page.locator('[data-page="accounts"]').click();
  await page.locator(`#accounts-page [data-action="reauth"][data-account="${aliceId}"]`).click();
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  await expect(page.locator('#login-dialog')).toBeVisible();
  await expect(page.locator('#login-title')).toContainText('alice-work');
  expect(data.login.targetAccountId).toBe(aliceId);
  expect(data.requests.some(item => item.path === `/api/auth/login/${conflict.id}/cancel`)).toBe(true);
  expect(data.requests.filter(item => item.path === '/api/auth/login')).toHaveLength(1);
});

test('adding an account cannot recover a pending flow targeted at an existing account', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await expect(page.locator('#account-select')).toHaveValue(aliceId);
  pendingDesktopLogin(data, { targetAccountId: bobId });
  queueDesktopReply(data, '/api/auth/login', { method: 'POST', status: 409, json: { error: '请先完成或取消当前登录。' } });
  await addAccount(page);
  await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  expect(data.login.targetAccountId).toBeNull();
  expect(data.requests.filter(item => item.path.endsWith('/cancel'))).toHaveLength(1);
  const starts = data.requests.filter(item => item.path === '/api/auth/login');
  expect(starts).toHaveLength(2);
  expect(starts.every(item => item.body.accountId === undefined)).toBe(true);
});
