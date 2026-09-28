import { test, expect } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ensureService, request } from '../../dist/daemon/client.js';

async function absent(path) {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function processExited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

test('installed production page talks to the real daemon, persists CSRF edits and shows session detail', async ({ page }) => {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'pilotmeter-live-ui-'));
  const instance = await ensureService(directory, true);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(instance.url);
    await expect(page.locator('#demo-banner')).toBeVisible();
    await expect(page.locator('#session-count')).toHaveText('4');
    await expect(page.locator('#primary-value')).toHaveText('130.7');
    await page.getByRole('textbox', { name: '预算 AI Credits / 月' }).fill('200');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#budget-feedback')).toHaveText('预算已保存。');
    await expect(page.locator('#primary-value')).toContainText('98');
    expect((await request(instance, '/api/settings')).monthlyBudget).toBe('200');
    await page.getByRole('button', { name: /查看会话/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.detail-total')).not.toContainText('—');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    await expect(async () => {
      const response = await fetch(`${instance.url}/v1/traces`, { method: 'POST', headers: { 'x-pilotmeter-token': instance.collectorToken, 'content-type': 'application/json' }, body: '{"resourceSpans":[]}' });
      await response.arrayBuffer();
      expect(response.status).toBe(409);
    }).toPass();
  } finally {
    // Stop browser polling and release its connections before requesting shutdown.
    if (!page.isClosed()) await page.close();
    expect(await request(instance, '/api/shutdown', 'POST')).toEqual({ stopping: true });
    // The response acknowledges a request, not process exit. The daemon removes
    // these markers only after SQLite closes and its writer ownership is released.
    await expect.poll(async () => ({
      instanceRemoved: await absent(join(directory, 'instance.json')),
      writerLockRemoved: await absent(join(directory, 'writer.lock')),
      processExited: processExited(instance.pid),
    }), {
      message: 'Daemon must close SQLite, release its instance/lock and exit before cleanup',
      timeout: 10_000,
      intervals: [50, 100, 250, 500],
    }).toEqual({ instanceRemoved: true, writerLockRemoved: true, processExited: true });
    expect(dirname(resolve(directory))).toBe(tempRoot);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(await absent(directory)).toBe(true);
  }
});
