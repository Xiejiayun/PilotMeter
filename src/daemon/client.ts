import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { APP, VERSION, readJson, prepareDirectory, sourceContextId } from '../shared/runtime.js';
export interface Instance { app: string; version: string; pid: number; instanceId: string; url: string; managementToken: string; collectorToken: string; demo?: boolean }
export async function instanceAt(dir: string): Promise<Instance | null> {
  let instance: Instance | null;
  try { instance = await readJson<Instance>(join(dir, 'instance.json')); } catch { return null; }
  if (!instance || instance.app !== APP || !/^http:\/\/127\.0\.0\.1:\d+$/.test(instance.url)) return null;
  try {
    const response = await fetch(`${instance.url}/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    const health = await response.json() as Partial<Instance>;
    if (!response.ok || health.app !== APP || health.instanceId !== instance.instanceId || health.version !== instance.version) return null;
    return instance;
  } catch { return null; }
}
export async function request<T>(instance: Instance, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${instance.url}${path}`, { method, headers: { authorization: `Bearer ${instance.managementToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}
export async function collectorForRun(instance: Instance, label = ''): Promise<Instance> {
  const contextId = sourceContextId(label);
  const { collectorToken } = await request<{collectorToken: string}>(instance, '/api/collector-context', 'POST', { contextId });
  return { ...instance, collectorToken };
}
export async function ensureService(dir: string, demo = false): Promise<Instance> {
  const existing = await instanceAt(dir);
  if (existing) { if (existing.version !== VERSION) throw new Error('Stop the running older PilotMeter version before upgrading.'); if (demo && !existing.demo) throw new Error('Demo requires a separate unused directory; this service contains real data.'); return existing; }
  await prepareDirectory(dir);
  const log = await open(join(dir, 'daemon.log'), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/pilotmeter.js', import.meta.url)), '--data-dir', dir, '__serve', ...(demo ? ['--demo'] : [])], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  let launchError: Error | undefined;
  child.on('error', error => { launchError = error; });
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (launchError) throw launchError;
    const found = await instanceAt(dir);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not become ready. Inspect ${join(dir, 'daemon.log')}`);
}
