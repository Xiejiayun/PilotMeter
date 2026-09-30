import { test, expect } from '@playwright/test';
import { aliceId, bobId, desktopFixture, mockDesktop, queueDesktopReply } from '../fixtures/desktop-browser.mjs';

const notices = page => page.evaluate(() => window.__desktopBridgeMessages.filter(message => message.type === 'pet-notify'));
const reasons = async page => (await notices(page)).map(message => message.reason);

async function hostState(page, data, epoch = 1) {
  await page.evaluate(message => window.__desktopBridgeReceive(message), {
    type: 'service-state', connected: true, epoch, instanceId: data.identity.instanceId,
    version: data.identity.version, recoverable: false, recovering: false, message: '',
    accountId: data.activeAccountId, quotaKey: null,
  });
}

async function open(page, data) {
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1_000));
  await mockDesktop(page, data, { bridge: true });
  await page.goto('/desktop.html');
  await hostState(page, data);
  await expect(page.locator('#account-select')).toBeEnabled();
  await expect(page.locator('#model-preview-list')).toContainText('Alpha Vision');
}

async function login(page) {
  await page.locator('[data-page="accounts"]').click();
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.locator('#login-code')).toHaveText('ABCD-1234');
}

test('manual sync notifies once after completion and unchanged polling stays quiet', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  data.refreshing = true;
  await page.locator('#refresh-button').click();
  await expect(page.locator('#refresh-button')).toHaveText('同步中');
  await expect.poll(() => reasons(page)).toEqual([]);
  data.refreshing = false;
  await page.clock.runFor(1_600);
  await expect.poll(() => reasons(page)).toEqual(['sync-complete']);
  const [event] = await notices(page);
  expect(event).toEqual({ type: 'pet-notify', reason: 'sync-complete', eventId: expect.stringMatching(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/), epoch: 1 });
  await page.clock.runFor(60_000);
  expect(await reasons(page)).toEqual(['sync-complete']);
});

test('a failed manual sync notifies once while later failed reads remain quiet', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  queueDesktopReply(data, '/api/auth/refresh', { method: 'POST', status: 503, json: { error: 'Synthetic sync failure' } });
  await page.locator('#refresh-button').click();
  await expect.poll(() => reasons(page)).toEqual(['sync-failed']);
  await expect(page.locator('#refresh-button')).toBeEnabled();
  queueDesktopReply(data, '/api/desktop', { status: 503, json: { error: 'Synthetic read failure' } });
  await page.clock.runFor(30_000);
  await expect(page.locator('#feedback')).toContainText('Synthetic read failure');
  await page.clock.runFor(30_000);
  expect(await reasons(page)).toEqual(['sync-failed']);
});

for (const [status, reason] of [['complete', 'login-complete'], ['failed', 'login-failed'], ['expired', 'login-expired']]) {
  test(`login ${status} produces one terminal notice`, async ({ page }) => {
    const data = desktopFixture();
    await open(page, data);
    await login(page);
    expect(await reasons(page)).toEqual([]);
    data.login.status = status;
    data.login.accountId = status === 'complete' ? aliceId : null;
    data.login.userCode = data.login.verificationUri = null;
    await page.clock.runFor(1_200);
    await expect.poll(() => reasons(page)).toEqual([reason]);
    await page.clock.runFor(60_000);
    expect(await reasons(page)).toEqual([reason]);
  });
}

test('transient login polling errors do not notify before the terminal result', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await login(page);
  queueDesktopReply(data, `/api/auth/login/${data.login.id}`, { status: 503, json: { error: 'Synthetic temporary interruption' } });
  await page.clock.runFor(1_200);
  await expect(page.locator('#login-status')).toContainText('暂时无法确认');
  expect(await reasons(page)).toEqual([]);
  data.login.status = 'complete';
  data.login.accountId = aliceId;
  await page.clock.runFor(1_200);
  await expect.poll(() => reasons(page)).toEqual(['login-complete']);
});

test('a sync completed for another account produces no success notice', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  data.refreshing = true;
  await page.locator('#refresh-button').click();
  await expect(page.locator('#refresh-button')).toHaveText('同步中');
  data.activeAccountId = bobId;
  data.refreshing = false;
  await page.clock.runFor(1_600);
  await expect(page.locator('#account-select')).toHaveValue(bobId);
  expect(await reasons(page)).toEqual([]);
});

test('a sync rejected after an external account switch does not notify the new account', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  const mutation = queueDesktopReply(data, '/api/auth/refresh', { method: 'POST', status: 409, hold: true, json: { error: 'Account changed' } });
  try {
    await page.locator('#refresh-button').click();
    await mutation.arrived;
    data.activeAccountId = bobId;
    mutation.release();
    await expect(page.locator('#account-select')).toHaveValue(bobId);
    await expect(page.locator('#refresh-button')).toBeEnabled();
    expect(await reasons(page)).toEqual([]);
  } finally { mutation.release(); }
});

test('closing login discards a late terminal reply and keeps the new attempt quiet', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await login(page);
  const terminal = { ...data.login, status: 'complete', accountId: aliceId, userCode: null, verificationUri: null };
  const oldStatus = queueDesktopReply(data, `/api/auth/login/${data.login.id}`, { hold: true, json: terminal });
  try {
    await page.clock.runFor(1_200);
    await oldStatus.arrived;
    await page.getByRole('button', { name: '取消登录', exact: true }).click();
    await expect(page.locator('#login-dialog')).toBeHidden();
    await page.locator('#accounts-page [data-action="login"]').click();
    await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
    oldStatus.release();
    await page.clock.runFor(1_200);
    expect(await reasons(page)).toEqual([]);
    await expect(page.locator('#login-code')).toHaveText('WXYZ-9876');
  } finally { oldStatus.release(); }
});

test('late sync and login replies from an old service epoch cannot notify the current pet', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  const refresh = queueDesktopReply(data, '/api/auth/refresh', { method: 'POST', hold: true });
  try {
    await page.locator('#refresh-button').click();
    await refresh.arrived;
    await hostState(page, data, 2);
    refresh.release();
    await expect(page.locator('#refresh-button')).toBeEnabled();
    expect(await reasons(page)).toEqual([]);
  } finally { refresh.release(); }

  await login(page);
  const terminal = { ...data.login, status: 'complete', accountId: aliceId, userCode: null, verificationUri: null };
  const poll = queueDesktopReply(data, `/api/auth/login/${data.login.id}`, { hold: true, json: terminal });
  try {
    await page.clock.runFor(1_200);
    await poll.arrived;
    await hostState(page, data, 3);
    poll.release();
    await expect(page.locator('#login-status')).toContainText('本机服务已切换');
    await page.clock.runFor(1_200);
    expect(await reasons(page)).toEqual([]);
  } finally { poll.release(); }
});
