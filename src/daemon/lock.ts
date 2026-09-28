import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson } from '../shared/runtime.js';
export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, 'writer.lock');
  const id = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
      await atomicJson(join(path, 'owner.json'), { pid: process.pid, id });
      return async () => {
        const owner = await readJson<{id: string}>(join(path, 'owner.json'));
        if (owner?.id === id) await rm(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readJson<{pid: number}>(join(path, 'owner.json'));
      if (owner) {
        try { process.kill(owner.pid, 0); throw new Error('A writer already owns this data directory.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      } else if (Date.now() - (await stat(path)).mtimeMs < 30_000) throw new Error('A writer is starting. Try again shortly.');
      const stale = join(dir, `writer.stale-${id}`);
      await rename(path, stale);
      await rm(stale, { recursive: true, force: true });
    }
  }
  throw new Error('Unable to acquire writer lock.');
}
