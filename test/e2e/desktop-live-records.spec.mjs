import { test, expect } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ensureService, request } from '../../dist/daemon/client.js';
import { envelope, nanos, span } from '../fixtures/synthetic-otlp.mjs';

async function absent(path) {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

test('desktop discovers newly ingested sessions from a real daemon without reopening the app', async ({ page }) => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'pilotmeter-desktop-records-'));
  const instance = await ensureService(directory);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.clock.install();
    await page.goto(`${instance.url}/desktop.html`);
    await expect(page.locator('#recent-records')).toContainText('还没有');
    const period = new Date().toISOString().slice(0, 7);
    const ingest = async (number, session, cost) => {
      const payload = envelope([span(number, { session, cost,
        startTimeUnixNano: nanos(`${period}-01T00:00:0${number}.000Z`),
        endTimeUnixNano: nanos(`${period}-01T00:00:0${number}.500Z`),
      })]);
      const response = await fetch(`${instance.url}/v1/traces`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pilotmeter-token': instance.collectorToken },
        body: JSON.stringify(payload) });
      expect(response.status).toBe(200); await response.arrayBuffer();
    };
    await ingest(1, 'synthetic-new-session', '1234567890123456789');
    await page.clock.fastForward(30_050);
    await expect(page.locator('#recent-records')).toContainText('synthetic-new-session');
    await expect(page.locator('#recent-records')).toContainText('1,234,567,890,123,456,789');
    await page.getByRole('link', { name: '用量记录', exact: true }).click();
    await expect(page.locator('#records-list')).toContainText('synthetic-new-session');
    await ingest(2, 'synthetic-second-session', null);
    await page.getByRole('button', { name: '同步', exact: true }).click();
    await expect(page.locator('#records-list')).toContainText('synthetic-second-session');
    await page.getByRole('link', { name: '用量总览', exact: true }).click();
    await expect(page.locator('#recent-records')).toContainText('synthetic-second-session');
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) await page.close();
    await request(instance, '/api/shutdown', 'POST');
    await expect.poll(async () => await absent(join(directory, 'instance.json')) && await absent(join(directory, 'writer.lock')),
      { timeout: 10_000 }).toBe(true);
    expect(dirname(resolve(directory))).toBe(root);
    expect(directory.startsWith(join(root, 'pilotmeter-desktop-records-'))).toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
