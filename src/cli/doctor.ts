import crossSpawn from 'cross-spawn';

/** Read-only version check; give a freshly installed native runtime time to start. */
export async function probeCopilotVersion(command: string, bundled: boolean) {
  for (let attempt = 0; ; attempt++) {
    const result = crossSpawn.sync(command, bundled ? ['--no-auto-update', '--version'] : ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: bundled ? 30_000 : 5_000,
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    // A timed-out process has already started: restarting it repeats cold startup.
    // Only a known failure to create the bundled process is safe to retry here.
    if (!bundled || attempt >= 2 || result.pid !== 0 || !code || !['EPERM', 'EBUSY'].includes(code)) return result;
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
}
