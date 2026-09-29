import { test, expect } from '@playwright/test';
import { aliceId, bobId, desktopFixture, mockDesktop } from '../fixtures/desktop-browser.mjs';

const currentMonth = new Date().toISOString().slice(0, 7);
const row = (sessionId, credits = '1') => ({ id: `record/${sessionId}`, sessionId,
  firstSeen: `${currentMonth}-02T12:00:00Z`, lastSeen: `${currentMonth}-02T12:00:00Z`,
  nanoAiu: `${credits}000000000`, credits, unitVerified: true,
  knownCalls: 1, unknownCalls: 0, pendingCalls: 0, models: ['alpha-vision'] });

function recordsResponse(data, params, items, nextCursor = null) {
  return { ...data.identity, accountId: params.get('accountId') || null, period: params.get('period'),
    source: 'local-otel', scope: '当前账号的本机记录', coverage: 'partial', retained: false,
    updatedAt: new Date().toISOString(), items, nextCursor };
}

async function openRecords(page, data, records, options) {
  await mockDesktop(page, data, options);
  await page.route('**/api/desktop/records**', async route => {
    const params = new URL(route.request().url()).searchParams;
    const response = await records(params, route);
    if (response) await route.fulfill({ json: response });
  });
  await page.goto('/desktop.html');
  if (!options?.bridge) await expect(page.locator('#account-select')).toBeEnabled();
}

async function hostState(page, data, overrides = {}) {
  await page.evaluate(message => window.__desktopBridgeReceive(message), {
    type: 'service-state', connected: true, recoverable: false, recovering: false,
    epoch: 1, instanceId: data.identity.instanceId, version: data.identity.version,
    accountId: data.activeAccountId, quotaKey: null, sessionLaunchAvailable: true, ...overrides,
  });
}

async function launchMessage(page) {
  await expect.poll(() => page.evaluate(() => window.__desktopBridgeMessages.filter(item => item.type === 'start-session').length)).toBe(1);
  return page.evaluate(() => window.__desktopBridgeMessages.find(item => item.type === 'start-session'));
}

test('newly collected sessions appear in recent and records during the normal refresh without reopening', async ({ page }) => {
  const data = desktopFixture();
  let sessions = [];
  await page.clock.install();
  await openRecords(page, data, params => recordsResponse(data, params, sessions));
  await expect(page.locator('#recent-records')).toContainText('还没有本机记录');
  await expect(page.locator('#records-list')).toContainText('还没有本机记录');
  sessions = [row('new-live-session', '12')];
  await page.clock.runFor(30_100);
  await expect(page.locator('#recent-records')).toContainText('new-live-session');
  await expect(page.locator('#records-list')).toContainText('new-live-session');
  await expect(page.locator('#recent-records')).toContainText('12');
  // Updates to an existing session must refresh its totals too.
  sessions = [{ ...row('new-live-session', '18'), knownCalls: 2 }];
  await page.clock.runFor(30_100);
  await expect(page.locator('#recent-records tbody tr td').nth(3)).toContainText('18');
  await expect(page.locator('#records-list tbody tr td').nth(3)).toContainText('18');
});

test('recent sessions stay in current month and recent order while records use a different month and usage sort', async ({ page }) => {
  const data = desktopFixture();
  const archiveMonth = '2024-02';
  const calls = [];
  await page.clock.install();
  await openRecords(page, data, params => {
    calls.push(params.toString());
    const items = params.get('period') === archiveMonth ? [row('archived-session', '99')]
      : params.get('sort') === 'usage' ? [row('expensive-session', '88'), row('latest-session')]
        : [row('latest-session'), row('expensive-session', '88')];
    return recordsResponse(data, params, items);
  });
  await expect(page.locator('#recent-records tbody tr').first()).toContainText('latest-session');
  await page.locator('[data-page="records"]').click();
  await page.locator('#record-period').fill(archiveMonth);
  await page.locator('#record-period').dispatchEvent('change');
  await page.locator('#record-sort').selectOption('usage');
  await expect(page.locator('#records-list')).toContainText('archived-session');
  await expect(page.locator('#recent-records tbody tr').first()).toContainText('latest-session');
  await expect(page.locator('#recent-description')).toContainText(currentMonth);
  await page.clock.runFor(30_100);
  await expect(page.locator('#records-list')).toContainText('archived-session');
  await expect(page.locator('#recent-records')).not.toContainText('archived-session');
  expect(calls.some(query => query.includes(`period=${archiveMonth}`) && query.includes('sort=usage'))).toBe(true);
  await page.locator('#record-period').fill(currentMonth);
  await page.locator('#record-period').dispatchEvent('change');
  await expect(page.locator('#records-list tbody tr').first()).toContainText('expensive-session');
  await expect(page.locator('#recent-records tbody tr').first()).toContainText('latest-session');
});

test('background refresh preserves loaded record pages and updates their rows together', async ({ page }) => {
  const data = desktopFixture();
  let updated = false;
  await page.clock.install();
  await openRecords(page, data, params => recordsResponse(data, params,
    params.has('cursor') ? [row('page-two-session', updated ? '8' : '2')] : [row('page-one-session', updated ? '7' : '1')],
    params.has('cursor') ? null : 'next-page'));
  await page.locator('[data-page="records"]').click();
  await expect(page.locator('#load-records')).toBeEnabled();
  await page.locator('#load-records').click();
  await expect(page.locator('#records-list tbody tr')).toHaveCount(2);
  updated = true;
  await page.clock.runFor(30_100);
  await expect(page.locator('#records-list tbody tr')).toHaveCount(2);
  await expect(page.locator('#records-list tbody tr').nth(0).locator('td').nth(3)).toContainText('7');
  await expect(page.locator('#records-list tbody tr').nth(1).locator('td').nth(3)).toContainText('8');
  await expect(page.locator('#load-records')).toBeHidden();
});

test('late records from a previous account cannot replace current recent or full records', async ({ page }) => {
  const data = desktopFixture();
  let holdAlice = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let held = 0;
  await page.clock.install();
  await openRecords(page, data, async params => {
    const alice = params.get('accountId') === aliceId;
    const response = recordsResponse(data, params, [row(alice ? 'alice-private-session' : 'bob-private-session')]);
    if (holdAlice && alice) { held++; await gate; }
    return response;
  });
  await expect(page.locator('#recent-records')).toContainText('alice-private-session');
  await expect(page.locator('#records-list')).toContainText('alice-private-session');
  holdAlice = true;
  try {
    await page.clock.runFor(30_100);
    await expect.poll(() => held).toBe(2);
    await page.locator('#account-select').selectOption(bobId);
    await expect(page.locator('#recent-records')).toContainText('bob-private-session');
    await expect(page.locator('#records-list')).toContainText('bob-private-session');
  } finally { release(); }
  await expect(page.locator('#recent-records')).not.toContainText('alice-private-session');
  await expect(page.locator('#records-list')).not.toContainText('alice-private-session');
});

test('failed refresh keeps readable records with an explicit stale notice and a working retry', async ({ page }) => {
  const data = desktopFixture();
  let fail = false;
  await page.clock.install();
  await openRecords(page, data, async (params, route) => {
    if (fail) { await route.fulfill({ status: 503, json: { error: '采集服务暂时繁忙' } }); return null; }
    return recordsResponse(data, params, [row('retained-session')]);
  });
  await expect(page.locator('#recent-records')).toContainText('retained-session');
  fail = true;
  await page.clock.runFor(30_100);
  await expect(page.locator('#recent-records')).toContainText('上次读取结果');
  await expect(page.locator('#records-list')).toContainText('上次读取结果');
  await expect(page.locator('#recent-records')).toContainText('retained-session');
  fail = false;
  await page.locator('#recent-records [data-action="reload-recent"]').click();
  await expect(page.locator('#recent-records')).not.toContainText('上次读取结果');
});

for (const status of ['started', 'cancelled', 'error']) {
  test(`native session launch handles ${status} and prevents duplicate launches`, async ({ page }) => {
    const data = desktopFixture();
    await openRecords(page, data, params => recordsResponse(data, params, []), { bridge: true });
    await hostState(page, data);
    const start = page.locator('#overview-page [data-action="start-session"]');
    await expect(start).toBeEnabled();
    await start.click();
    const request = await launchMessage(page);
    expect(request).toMatchObject({ type: 'start-session', accountId: aliceId, epoch: 1 });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(start).toBeDisabled();
    await expect(page.locator('#records-page [data-action="start-session"]')).toBeDisabled();
    await page.evaluate(result => window.__desktopBridgeReceive(result), { type: 'session-start-result', requestId: request.requestId, epoch: 1, status });
    await expect(start).toBeEnabled();
    await expect(page.locator('#feedback')).toContainText(status === 'started' ? 'Copilot 终端已打开' : status === 'cancelled' ? '已取消' : '启动失败');
    expect(await page.evaluate(() => window.__desktopBridgeMessages.filter(item => item.type === 'start-session').length)).toBe(1);
    expect(data.requests.filter(item => item.method !== 'GET')).toHaveLength(0);
  });
}

test('a session launch result from an old account or service cannot affect the new selection', async ({ page }) => {
  const data = desktopFixture();
  await openRecords(page, data, params => recordsResponse(data, params, []), { bridge: true });
  await hostState(page, data);
  await page.locator('#overview-page [data-action="start-session"]').click();
  const request = await launchMessage(page);
  await page.locator('#account-select').selectOption(bobId);
  await expect(page.locator('#account-select')).toHaveValue(bobId);
  await page.evaluate(result => window.__desktopBridgeReceive(result), { type: 'session-start-result', requestId: request.requestId, epoch: 1, status: 'error', message: 'OLD ACCOUNT ERROR' });
  await expect(page.locator('#feedback')).not.toContainText('OLD ACCOUNT ERROR');
  await expect(page.locator('#overview-page [data-action="start-session"]')).toBeEnabled();
  await hostState(page, data, { epoch: 2 });
  await page.evaluate(result => window.__desktopBridgeReceive(result), { type: 'session-start-result', requestId: request.requestId, epoch: 1, status: 'error', message: 'OLD SERVICE ERROR' });
  await expect(page.locator('#feedback')).not.toContainText('OLD SERVICE ERROR');
});

test('browser session action explains terminal setup and copies only the selected account command', async ({ page, context }) => {
  const data = desktopFixture();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openRecords(page, data, params => recordsResponse(data, params, []));
  await page.locator('#overview-page [data-action="start-session"]').click();
  await expect(page.locator('#session-cli-dialog')).toBeVisible();
  await expect(page.locator('#session-cli-dialog')).toContainText('浏览器页面不能直接打开本机终端');
  await expect(page.locator('#session-cli-command')).toHaveText(`pilotmeter run --account ${aliceId} --`);
  await page.locator('[data-action="copy-session-command"]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`pilotmeter run --account ${aliceId} --`);
  expect(data.requests.filter(item => item.method !== 'GET')).toHaveLength(0);
});

test('session exit failures belong only to their current account and service', async ({ page }) => {
  const data = desktopFixture();
  await openRecords(page, data, params => recordsResponse(data, params, []), { bridge: true });
  await hostState(page, data);
  await expect(page.locator('#account-select')).toBeEnabled();
  await page.evaluate(message => window.__desktopBridgeReceive(message), {
    type: 'session-exit', accountId: aliceId, epoch: 1, exitCode: 1, message: '当前账号的 Copilot 会话意外结束。',
  });
  await expect(page.locator('#feedback')).toContainText('当前账号的 Copilot 会话意外结束');
  await page.locator('#account-select').selectOption(bobId);
  await expect(page.locator('#account-select')).toHaveValue(bobId);
  await page.evaluate(message => window.__desktopBridgeReceive(message), {
    type: 'session-exit', accountId: aliceId, epoch: 1, exitCode: 1, message: 'OLD ACCOUNT EXIT',
  });
  await expect(page.locator('#feedback')).not.toContainText('OLD ACCOUNT EXIT');
  await hostState(page, data, { epoch: 2 });
  await expect(page.locator('#account-select')).toBeEnabled();
  await page.evaluate(message => window.__desktopBridgeReceive(message), {
    type: 'session-exit', accountId: bobId, epoch: 1, exitCode: 1, message: 'OLD SERVICE EXIT',
  });
  await expect(page.locator('#feedback')).not.toContainText('OLD SERVICE EXIT');
});

test('starting without an account opens login and never sends an unscoped native launch', async ({ page }) => {
  const data = desktopFixture({ accounts: false });
  await openRecords(page, data, params => recordsResponse(data, params, []), { bridge: true });
  await hostState(page, data);
  await page.locator('#overview-page [data-action="start-session"]').click();
  await expect(page.locator('#login-dialog')).toBeVisible();
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
  expect(await page.evaluate(() => window.__desktopBridgeMessages.filter(item => item.type === 'start-session'))).toEqual([]);
});

test('all-local records with saved accounts asks for an account selection instead of starting another login', async ({ page }) => {
  const data = desktopFixture();
  data.activeAccountId = null;
  await openRecords(page, data, params => recordsResponse(data, params, []), { bridge: true });
  await hostState(page, data);
  const start = page.locator('#overview-page [data-action="start-session"]');
  await expect(start).toHaveText('选择账号后开始');
  await start.click();
  await expect(page.locator('#account-select')).toBeFocused();
  await expect(page.locator('#feedback')).toContainText('选择一个已连接账号');
  await expect(page.locator('#login-dialog')).toBeHidden();
  expect(data.requests.filter(item => item.path === '/api/auth/login' && item.method === 'POST')).toEqual([]);
  expect(await page.evaluate(() => window.__desktopBridgeMessages.filter(item => item.type === 'start-session'))).toEqual([]);
});

test('design preview disables session launch and labels the sample records', async ({ page }) => {
  await page.goto('/desktop.html?demo=1');
  await expect(page.locator('#overview-page [data-action="start-session"]')).toBeDisabled();
  await expect(page.locator('#overview-page [data-session-help]')).toContainText('记录均为虚构示例');
});

for (const viewport of [{ width: 1260, height: 850 }, { width: 760, height: 580 }, { width: 320, height: 720 }]) {
  test(`session collection controls stay reachable without overlap at ${viewport.width}px`, async ({ page }, testInfo) => {
    const data = desktopFixture();
    await page.setViewportSize(viewport);
    await openRecords(page, data, params => recordsResponse(data, params, [row('synthetic-session')]), { bridge: true });
    await hostState(page, data);
    await expect(page.locator('#recent-records')).toContainText('synthetic-session');
    for (const section of ['overview', 'records']) {
      await page.locator(`[data-page="${section}"]`).click();
      const button = page.locator(`#${section}-page [data-action="start-session"]`);
      await expect(button).toBeEnabled();
      await button.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      const help = await page.locator(`#${section}-page [data-session-help]`).boundingBox();
      expect(help.y).toBeGreaterThanOrEqual(box.y + box.height);
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: testInfo.outputPath(`${section}-${viewport.width}.png`), fullPage: true });
    }
  });
}
