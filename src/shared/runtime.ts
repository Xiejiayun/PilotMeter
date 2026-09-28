import { homedir, hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
export const VERSION = '0.1.0-preview.8';
export const APP = 'pilotmeter';
export function sourceContextId(label = '', explicitHome?: string): string {
  let home = resolve(explicitHome || process.env.COPILOT_HOME || join(homedir(), '.copilot'));
  try { home = realpathSync.native(home); } catch { /* A not-yet-created home still has a canonical absolute path. */ }
  if (process.platform === 'win32') home = home.toLowerCase();
  return createHash('sha256').update(JSON.stringify([hostname(), home, label])).digest('hex');
}
export function dataDirectory(explicit?: string): string {
  if (explicit || process.env.PILOTMETER_DATA_DIR) return resolve(explicit || process.env.PILOTMETER_DATA_DIR!);
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'PilotMeter');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'PilotMeter');
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pilotmeter');
}
export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, path); }
  catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
}
export async function prepareDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); }
export function month(value = new Date().toISOString().slice(0, 7)): string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) < 1970 || Number(value.slice(0, 4)) > 9998) throw new Error('period must be YYYY-MM (UTC)');
  return value;
}
