import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson } from '../shared/runtime.js';

interface Owner { pid: number; id: string }

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Writer lock has an invalid owner; inspect it before removing it.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

/**
 * Serialize stale-owner inspection and rename. This mutex is deliberately never
 * auto-reclaimed: doing so would introduce the same check/rename race one level up.
 * A crash during recovery leaves an actionable, fail-safe manual recovery step.
 */
async function recoverStaleLock(dir: string, path: string, id: string): Promise<void> {
  const recoveryPath = join(dir, 'writer.recovery.lock');
  let handle;
  try { handle = await open(recoveryPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`Writer recovery is already in progress. If its process exited, verify PilotMeter is stopped before removing ${recoveryPath}.`);
  }
  const identity = await handle.stat();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, id }));
    // The owner must be re-read AFTER acquiring recovery ownership. A different
    // process may already have replaced the stale lock while this one was waiting.
    const owner = await readJson<Owner>(join(path, 'owner.json'));
    if (!owner) {
      try { await stat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      // Age cannot establish that an interrupted creator is dead. Never take an
      // ownerless directory away from a process that may still be writing its ID.
      throw new Error(`Writer lock is starting or incomplete. If startup was interrupted, verify PilotMeter is stopped before removing ${path}.`);
    }
    if (processAlive(owner.pid)) throw new Error('A writer already owns this data directory.');
    const stale = join(dir, `writer.stale-${id}`);
    await rename(path, stale);
    await rm(stale, { recursive: true, force: true });
  } finally {
    await handle.close();
    try {
      const current = await stat(recoveryPath);
      if (current.dev === identity.dev && current.ino === identity.ino) await unlink(recoveryPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, 'writer.lock');
  const id = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await recoverStaleLock(dir, path, id);
      continue;
    }
    try { await atomicJson(join(path, 'owner.json'), { pid: process.pid, id }); }
    catch (error) {
      // Other legitimate contenders cannot reclaim an ownerless lock. It is safe
      // for its creator to clean up a failed owner write while still running.
      await rm(path, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      const owner = await readJson<Owner>(join(path, 'owner.json'));
      if (owner?.id === id) await rm(path, { recursive: true, force: true });
    };
  }
  throw new Error('Unable to acquire writer lock.');
}
