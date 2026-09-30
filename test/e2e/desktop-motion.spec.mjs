import { test, expect } from '@playwright/test';
import { aliceId, bobId, desktopFixture, desktopSnapshot, mockDesktop, queueDesktopReply } from '../fixtures/desktop-browser.mjs';

const initial = ['123.456789012345678901', '987.654312098765431208', '864.197523086419752307'];
const updated = ['223.456789012345678901', '987.654312098765431208', '764.197523086419752307'];
const values = page => page.locator('#quota-area .metric-value');
const localValues = page => page.locator('#local-summary .local-stat-value');
const progress = page => page.locator('#quota-area .quota-progress');

async function open(page, data) {
  // Freeze before the first render so assertions can distinguish a direct value
  // from an animation that would eventually happen to reach the same value.
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1_000));
  await mockDesktop(page, data);
  await page.goto('/desktop.html');
  await expect(page.locator('#account-select')).toBeEnabled();
}

async function syncing(page) {
  const button = page.locator('#refresh-button');
  await expect(button).toHaveText('同步中');
  await expect(button).toBeDisabled();
  await expect(button).toHaveClass(/is-refreshing/);
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#quota-area')).toHaveAttribute('aria-busy', 'true');
}

async function idle(page) {
  const button = page.locator('#refresh-button');
  await expect(button).toHaveText('同步');
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveClass(/is-refreshing/);
  await expect(button).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#quota-area')).not.toHaveAttribute('aria-busy', 'true');
}

async function syncSnapshot(page, data, marker) {
  data.modelSets[data.activeAccountId].items[0].name = marker;
  await page.locator('#refresh-button').click();
  // The model name is rendered from the same snapshot as the animated values.
  // Waiting for it avoids advancing the clock before fetch has completed.
  await expect(page.locator('#model-preview-list')).toContainText(marker);
}

test('sync animation starts while CSRF is pending and lasts through the provider refresh', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await expect(values(page)).toHaveText(initial);
  const session = queueDesktopReply(data, '/api/session', { hold: true });
  const mutation = queueDesktopReply(data, '/api/auth/refresh', { method: 'POST', hold: true });
  data.refreshing = true;
  data.modelSets[aliceId].items[0].name = 'Provider refresh pending';
  try {
    await page.locator('#refresh-button').click();
    await session.arrived;
    await syncing(page);
    expect(await page.locator('#refresh-button svg').evaluate(node => getComputedStyle(node).animationName)).not.toBe('none');
    await expect(values(page)).toHaveText(initial);
    session.release();
    await mutation.arrived;
    await syncing(page);
    mutation.release();
    await expect(page.locator('#model-preview-list')).toContainText('Provider refresh pending');
    await syncing(page);

    data.refreshing = false;
    data.modelSets[aliceId].items[0].name = 'Provider refresh complete';
    await page.clock.runFor(1_600);
    await expect(page.locator('#model-preview-list')).toContainText('Provider refresh complete');
    await idle(page);
    await expect(values(page)).toHaveText(initial);
  } finally {
    session.release();
    mutation.release();
  }
});

test('changed numbers and progress pass through intermediate values then preserve every source digit', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await expect(values(page)).toHaveText(initial);
  await expect(localValues(page)).toHaveText(['1', '2', '0']);
  expect(await progress(page).evaluate(node => node.value)).toBe(12.5);

  Object.assign(data.quotas[aliceId].buckets[0], { used: '223.456789012345678901', usedPercentage: '25', remainingPercentage: '75' });
  data.overrideDesktop = desktopSnapshot(data);
  Object.assign(data.overrideDesktop.local, { sessionCount: 21, knownCalls: 42, unknownCalls: 6 });
  data.overrideDesktop.models.items[0].name = 'Animated snapshot';
  await page.locator('#refresh-button').click();
  await expect(page.locator('#model-preview-list')).toContainText('Animated snapshot');
  await page.clock.runFor(240);
  const middle = (await values(page).allTextContents()).map(value => Number(value.replaceAll(',', '')));
  expect(middle[0]).toBeGreaterThan(Number(initial[0]));
  expect(middle[0]).toBeLessThan(Number(updated[0]));
  expect(middle[2]).toBeGreaterThan(Number(updated[2]));
  expect(middle[2]).toBeLessThan(Number(initial[2]));
  const localMiddle = (await localValues(page).allTextContents()).map(Number);
  for (const [index, start, end] of [[0, 1, 21], [1, 2, 48], [2, 0, 6]]) {
    expect(localMiddle[index]).toBeGreaterThan(start);
    expect(localMiddle[index]).toBeLessThan(end);
  }
  const progressMiddle = await progress(page).evaluate(node => node.value);
  expect(progressMiddle).toBeGreaterThan(12.5);
  expect(progressMiddle).toBeLessThan(25);

  await page.clock.runFor(700);
  await expect(values(page)).toHaveText(updated);
  await expect(localValues(page)).toHaveText(['21', '48', '6']);
  expect(await progress(page).evaluate(node => node.value)).toBe(25);
  await idle(page);

  data.overrideDesktop.models.items[0].name = 'Unchanged periodic snapshot';
  await page.clock.runFor(30_000);
  await expect(page.locator('#model-preview-list')).toContainText('Unchanged periodic snapshot');
  await expect(values(page)).toHaveText(updated);
  await page.clock.runFor(240);
  await expect(values(page)).toHaveText(updated);
  await expect(localValues(page)).toHaveText(['21', '48', '6']);
  expect(await progress(page).evaluate(node => node.value)).toBe(25);
});

test('account, category and unit changes snap directly, and an unknown quantity never counts from zero', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  await page.locator('#account-select').selectOption(bobId);
  await expect(values(page)).toHaveText(['44', '100', '56']);
  expect(await progress(page).evaluate(node => node.value)).toBe(44);

  const bucket = data.quotas[bobId].buckets[0];
  bucket.key = 'chat';
  const completion = { ...bucket, key: 'completions', used: '160', limit: '200', usedPercentage: '80', remainingPercentage: '20' };
  data.quotas[bobId].buckets.push(completion);
  await syncSnapshot(page, data, 'Choose a quota category');
  await page.locator('#quota-category').selectOption('chat');
  await expect(values(page)).toHaveText(['44', '100', '56']);
  await page.locator('#quota-category').selectOption('completions');
  await expect(values(page)).toHaveText(['160', '200', '40']);
  expect(await progress(page).evaluate(node => node.value)).toBe(80);

  Object.assign(completion, { unit: 'premium-requests', used: '12', limit: '20', usedPercentage: '60', remainingPercentage: '40' });
  await syncSnapshot(page, data, 'Changed quota unit');
  await expect(values(page)).toHaveText(['12', '20', '8']);
  expect(await progress(page).evaluate(node => node.value)).toBe(60);

  completion.used = null;
  await syncSnapshot(page, data, 'Unknown usage');
  await expect(values(page).first()).toHaveText('—');
  Object.assign(completion, { used: '13', usedPercentage: '65', remainingPercentage: '35' });
  await syncSnapshot(page, data, 'Known usage');
  await expect(values(page)).toHaveText(['13', '20', '7']);
});

test('reduced motion shows updated exact values and progress without waiting for animation frames', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const data = desktopFixture();
  await open(page, data);
  Object.assign(data.quotas[aliceId].buckets[0], { used: '223.456789012345678901', usedPercentage: '25', remainingPercentage: '75' });
  data.overrideDesktop = desktopSnapshot(data);
  Object.assign(data.overrideDesktop.local, { sessionCount: 21, knownCalls: 42, unknownCalls: 6 });
  data.overrideDesktop.models.items[0].name = 'Reduced motion snapshot';
  await page.locator('#refresh-button').click();
  await expect(page.locator('#model-preview-list')).toContainText('Reduced motion snapshot');
  await expect(values(page)).toHaveText(updated);
  await expect(localValues(page)).toHaveText(['21', '48', '6']);
  expect(await progress(page).evaluate(node => node.value)).toBe(25);
  await idle(page);
});

test('a failed refresh stops the busy animation and preserves the readable previous snapshot', async ({ page }) => {
  const data = desktopFixture();
  await open(page, data);
  const mutation = queueDesktopReply(data, '/api/auth/refresh', {
    method: 'POST', hold: true, status: 503, json: { error: 'Provider temporarily unavailable' },
  });
  try {
    await page.locator('#refresh-button').click();
    await mutation.arrived;
    await syncing(page);
    mutation.release();
    await expect(page.locator('#feedback')).toContainText('Provider temporarily unavailable');
    await idle(page);
    await expect(values(page)).toHaveText(initial);
  } finally { mutation.release(); }
});
