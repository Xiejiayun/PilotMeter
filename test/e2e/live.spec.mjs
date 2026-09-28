import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureService, request } from '../../dist/daemon/client.js';

test('installed production page talks to the real daemon, persists CSRF edits and shows session detail', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'pilotmeter-live-ui-'));
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
      expect(response.status).toBe(409);
    }).toPass();
  } finally {
    await request(instance, '/api/shutdown', 'POST');
    await new Promise(resolve => setTimeout(resolve, 300));
    await rm(directory, { recursive: true, force: true });
  }
});
