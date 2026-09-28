import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const VERSION = '0.1.0-preview.1';
export const APP = 'pilotmeter';
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
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
export async function prepareDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); }
export function month(value = new Date().toISOString().slice(0, 7)): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) < 1970) throw new Error('period must be YYYY-MM (UTC)');
  return value;
}
