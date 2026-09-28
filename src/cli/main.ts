import { Command } from 'commander';
import { join, resolve } from 'node:path';
import crossSpawn from 'cross-spawn';
import { open, readFile, writeFile } from 'node:fs/promises';
import { dataDirectory, month, VERSION } from '../shared/runtime.js';
import { ensureService, instanceAt, request, collectorForRun } from '../daemon/client.js';
import { statusText, cachedStatus, watch, openBrowser, terminalLink } from './terminal.js';
import { runCopilot } from './run.js';
import type { Summary } from '../shared/types.js';
import { installStatusline, restoreStatusline, inspectStatusline } from './statusline-config.js';
import type { ReconciliationInspection, ReconciliationReport } from '../domain/reconciliation-evidence.js';
import { resolveCopilotCommand } from '../providers/copilot-client.js';
import type { AccountLogin, AccountsOverview } from '../shared/accounts.js';

const program = new Command().name('pilotmeter').description('Local Copilot CLI usage meter; official quota stays unknown until verified.').version(VERSION).option('--data-dir <directory>', 'isolated application data directory').enablePositionalOptions();
const dir = () => dataDirectory(program.opts().dataDir);
const copilotCommand = () => process.env.PILOTMETER_COPILOT_BIN || resolveCopilotCommand();
async function copilotVersion() {
  const override = !!process.env.PILOTMETER_COPILOT_BIN;
  const command = copilotCommand();
  for (let attempt = 0; ; attempt++) {
    const result = crossSpawn.sync(command, override ? ['--version'] : ['--no-auto-update', '--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    // A newly extracted executable can be temporarily busy. Never retry an already completed command.
    if (override || attempt >= 2 || !code || !['EPERM', 'EBUSY', 'ETIMEDOUT'].includes(code)) return result;
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
}
program.command('__serve', { hidden: true }).option('--demo').action(async options => { const { serve } = await import('../daemon/server.js'); await serve(dir(), options.demo); });
program.command('doctor').description('Read-only environment and service checks').action(async () => {
  const copilot = await copilotVersion();
  const probeError = (copilot.error as NodeJS.ErrnoException | undefined)?.code;
  const copilotProbe = { state: copilot.status === 0 ? 'ready' : 'error', errorCode: copilot.status === 0 ? null : probeError && /^[A-Z0-9_]{1,32}$/.test(probeError) ? probeError : 'VERSION_UNAVAILABLE' };
  const instance = await instanceAt(dir());
  console.log(JSON.stringify({ node: process.version, platform: process.platform, copilot: copilot.status === 0 ? copilot.stdout.trim().slice(0, 120) : 'not-found', copilotProbe, dataDirectory: dir(), service: instance ? { version: instance.version, url: instance.url } : 'stopped', officialQuota: 'unverified', statusline: inspectStatusline(), remoteTerminal: !!(process.env.SSH_CONNECTION || process.env.WSL_DISTRO_NAME), terminal: process.env.WT_SESSION ? 'Windows Terminal' : process.env.TERM_PROGRAM || process.env.TERM || 'unknown' }, null, 2));
});
program.command('start').option('--background', 'run detached in background').option('--open', 'open the local dashboard').action(async options => {
  if (options.background) { const instance = await ensureService(dir()); console.log(instance.url); if (options.open) await openBrowser(instance.url); }
  else { const existing = await instanceAt(dir()); if (existing) { console.log(existing.url); if (options.open) await openBrowser(existing.url); return; } const { serve } = await import('../daemon/server.js'); await serve(dir()); const instance = await instanceAt(dir()); console.log(instance?.url); if (options.open && instance) await openBrowser(instance.url); }
});
program.command('status').option('--json').action(async options => {
  const instance = await instanceAt(dir()); if (!instance) { if (options.json) console.log(JSON.stringify({ state: 'stopped' })); else console.log('PilotMeter 未启动 · pilotmeter start --background'); return; }
  const data = await request<Summary>(instance, '/api/summary'); console.log(options.json ? JSON.stringify(data) : `${statusText(data)}\n${terminalLink(instance.url)}`);
});
program.command('run').option('--replace-telemetry', 'replace existing exporter only for this child').option('--source-label <label>', 'collection context label').option('--account <id>', 'use this saved GitHub account instead of the selected account').argument('[args...]').allowUnknownOption().passThroughOptions().description('Run Copilot as the selected GitHub account with local telemetry; use -- before Copilot arguments').action(async (args, options) => {
  const service = await ensureService(dir());
  const selected = await request<{profile: {id: string; login: string} | null; home?: string; collectorToken?: string}>(service, '/api/auth/run-context', 'POST', { accountId: options.account, sourceLabel: options.sourceLabel });
  const instance = selected.profile ? { ...service, collectorToken: selected.collectorToken! } : await collectorForRun(service, options.sourceLabel);
  const forwarded = process.env.PILOTMETER_COPILOT_BIN || args.includes('--no-auto-update') ? args : ['--no-auto-update', ...args];
  process.exitCode = await runCopilot(instance, forwarded, options.replaceTelemetry, copilotCommand(), selected.home);
});
program.command('watch').description('Independent terminal usage display; o opens, q exits').action(async () => { await watch(dir()); });
program.command('statusline').description('Read only the small local snapshot, suitable for Copilot statusLine').action(async () => { process.stdin.resume(); console.log(await cachedStatus(dir())); process.stdin.pause(); });
program.command('open').action(async () => { const instance = await ensureService(dir()); await openBrowser(instance.url); console.log(instance.url); });
program.command('demo').option('--open').description('Launch clearly labeled synthetic data in the separate demo subdirectory').action(async options => { const instance = await ensureService(join(dir(), 'demo'), true); console.log(`[虚构演示] ${instance.url}\n停止演示：pilotmeter --data-dir "${join(dir(), 'demo')}" stop`); if (options.open) await openBrowser(instance.url); });
program.command('init').option('--statusline', 'install the optional native statusline bridge').option('--restore-statusline', 'restore only fields still owned by PilotMeter').option('--replace', 'explicitly replace an existing statusLine after reviewing the proposed change').action(async options => {
  if (!!options.statusline === !!options.restoreStatusline) throw new Error('Choose --statusline or --restore-statusline.');
  if (options.restoreStatusline) { console.log(JSON.stringify(restoreStatusline({ dataDir: dir() }), null, 2)); return; }
  const version = await copilotVersion();
  const cliVersion = version.status === 0 ? version.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] : null;
  if (!cliVersion) throw new Error('Cannot read the bundled Copilot CLI version; reinstall PilotMeter or check the PILOTMETER_COPILOT_BIN override before statusline integration.');
  console.log(JSON.stringify(installStatusline({ dataDir: dir(), cliVersion, replace: options.replace }), null, 2));
});
program.command('stop').action(async () => { const instance = await instanceAt(dir()); if (!instance) { console.log('PilotMeter 已停止'); return; } await request(instance, '/api/shutdown', 'POST'); console.log('PilotMeter 正在正常停止'); });
program.command('import <file>').option('--source-label <label>', 'collection context matching run').description('Import supported OTLP traces JSONL through the shared ledger').action(async (file, options) => { const instance = await collectorForRun(await ensureService(dir()), options.sourceLabel); console.log(JSON.stringify(await request(instance, '/api/import', 'POST', { path: resolve(file), collectorToken: instance.collectorToken }))); });
program.command('config').command('set <key> <value>').action(async (key, value) => {
  if (key === 'budget.monthlyCredits') {
    const instance = await ensureService(dir()); await request(instance, '/api/settings', 'PATCH', { monthlyBudget: value === 'null' ? null : value }); console.log('已保存自定义月度预算（本机采集范围）。');
  } else if (key === 'retention.days') {
    if (value !== 'null' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 36500)) throw new Error('retention.days must be 1–36500, or null to disable future cleanup.');
    const instance = await ensureService(dir());
    await request(instance, '/api/settings', 'PATCH', { retentionDays: value === 'null' ? null : Number(value) });
    console.log(value === 'null' ? '已关闭后续明细清理；此前已清理的记录不会恢复。' : `已设置 ${Number(value)} 天明细保留策略，并执行清理。早于阈值且已完整结束的调用链会被清理；仅保留防重放标记，账单快照和备份不受影响。`);
  } else throw new Error('Supported keys: budget.monthlyCredits, retention.days');
});
const account = program.command('account').description('Sign in and switch GitHub accounts; optionally connect a separate billing entity');
account.command('list').description('List saved GitHub sign-in profiles; no credentials are printed').action(async () => {
  console.log(JSON.stringify(await request<AccountsOverview>(await ensureService(dir()), '/api/auth/accounts'), null, 2));
});
account.command('login').option('--host <url>', 'github.com or Enterprise Cloud host', 'https://github.com').option('--account <id>', 're-authorize a saved account').description('Sign in through the official GitHub Copilot device authorization flow').action(async options => {
  const instance = await ensureService(dir());
  let state = await request<AccountLogin>(instance, '/api/auth/login', 'POST', { host: options.host, accountId: options.account });
  let shown = false; let cancelled = false;
  const interrupt = () => { cancelled = true; void request(instance, `/api/auth/login/${state.id}/cancel`, 'POST').catch(() => {}); };
  process.once('SIGINT', interrupt);
  try {
    while (!cancelled && ['starting', 'pending', 'verifying'].includes(state.status)) {
      if (!shown && state.userCode && state.verificationUri) { console.log(`请在 ${state.verificationUri} 输入一次性代码 ${state.userCode}，并确认要添加的 GitHub 账号。`); shown = true; }
      await new Promise(resolve => setTimeout(resolve, 1000));
      state = await request<AccountLogin>(instance, `/api/auth/login/${state.id}`);
    }
    if (cancelled) { console.log('登录已取消。'); process.exitCode = 130; }
    else if (state.status === 'complete') console.log(`GitHub 登录成功，当前账号 ID：${state.accountId}`);
    else throw new Error(state.error?.message || `登录未完成：${state.status}`);
  } finally { process.off('SIGINT', interrupt); }
});
account.command('use <id>').description('Select a saved GitHub account; use none to show all local records').action(async id => {
  const result = await request<AccountsOverview>(await ensureService(dir()), '/api/auth/select', 'POST', { accountId: id === 'none' ? null : id });
  console.log(result.activeAccountId ? `当前 GitHub 账号：${result.accounts.find(a => a.id === result.activeAccountId)?.login}` : '当前显示全部本机记录。');
});
account.command('remove <id>').description('Remove a PilotMeter account profile; does not revoke GitHub authorization or delete usage history').action(async id => {
  await request(await ensureService(dir()), `/api/auth/accounts/${encodeURIComponent(id)}`, 'DELETE'); console.log('已从 PilotMeter 移除账号；历史记录保留，GitHub 授权未撤销。');
});
account.command('connect').option('--user <login>').option('--organization <login>').option('--enterprise <slug>').option('--direct-billing', 'confirm that this personal account pays directly').action(async options => {
  const entries = [['user', options.user], ['organization', options.organization], ['enterprise', options.enterprise]].filter(([, login]) => !!login);
  if (entries.length !== 1) throw new Error('Select exactly one of --user, --organization or --enterprise.');
  const [kind, login] = entries[0]!;
  const result = await request<{credentialPresent: boolean}>(await ensureService(dir()), '/api/account', 'POST', { account: { kind, login, directBilling: options.directBilling === true } });
  console.log(`已绑定 ${kind}:${login}。${result.credentialPresent ? '可使用 account refresh --billing 获取只读账单。' : '服务尚无专用凭据；设置 PILOTMETER_GITHUB_TOKEN 后 stop/start，再刷新。'}`);
});
account.command('disconnect').action(async () => { await request(await ensureService(dir()), '/api/account', 'POST', { account: null }); console.log('账户已断开；本地采集记录保留。'); });
account.command('refresh').option('--billing', 'refresh the separately connected billing entity instead of the selected GitHub account').description('Refresh the selected GitHub account quota; without a selected account, refresh legacy billing').action(async options => {
  const instance = await ensureService(dir());
  const selected = options.billing ? null : (await request<AccountsOverview>(instance, '/api/auth/accounts')).activeAccountId;
  console.log(JSON.stringify(await request(instance, selected ? '/api/auth/refresh' : '/api/refresh', 'POST'), null, 2));
});
account.command('import-quota <file>').description('Import read-only quota with explicit monthly identity, pool and official-page verification evidence').action(async file => {
  const input = JSON.parse(await readFile(resolve(file), 'utf8'));
  console.log(JSON.stringify(await request(await ensureService(dir()), '/api/quota-import', 'POST', input), null, 2));
});
const unit = program.command('unit').description('Record or remove evidence that nano AIU matches Credits for the tested CLI');
unit.command('verify').requiredOption('--cli-version <version>').requiredOption('--evidence <description>', 'actual same-session /usage comparison').action(async options => { await request(await ensureService(dir()), '/api/unit-verification', 'POST', { cliVersion: options.cliVersion, evidence: options.evidence }); console.log('已保存单位核验证据；仅应用于相同 CLI 版本。'); });
unit.command('clear').action(async () => { await request(await ensureService(dir()), '/api/unit-verification', 'POST', { clear: true }); console.log('已撤销单位验证。'); });
const reconcile = program.command('reconcile').description('Compare a verified finite local range with its official account snapshot');
const reconciliationPath = (period?: string) => `/api/reconciliation?period=${month(period)}`;
reconcile.command('status').option('--period <YYYY-MM>', 'UTC month').option('--json').action(async options => {
  const report = await request<ReconciliationReport>(await ensureService(dir()), reconciliationPath(options.period));
  console.log(options.json ? JSON.stringify(report, null, 2) : `${report.label}${report.difference === null ? '' : ` · ${report.difference} AI Credits（账户减本机）`}\n${report.reason}`);
});
reconcile.command('inspect').option('--period <YYYY-MM>', 'UTC month').option('--output <file>', 'write a new unverified evidence template without overwriting an existing file').action(async options => {
  const result = await request<ReconciliationInspection>(await ensureService(dir()), `/api/reconciliation/inspect?period=${month(options.period)}`);
  if (options.output) {
    if (!result.template) throw new Error(result.report.reason);
    await writeFile(resolve(options.output), `${JSON.stringify(result.template, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`已写入待核验模板：${resolve(options.output)}。完成实际来源、额度池、产品和时间覆盖核对后再填写；不要把未知事实标为 true。`);
  } else console.log(JSON.stringify(result, null, 2));
});
reconcile.command('verify <file>').description('Validate explicit evidence against current ledger and account hashes; never imports amounts').action(async file => {
  const handle = await open(resolve(file), 'r');
  let input: unknown;
  try {
    const maximum = 256 * 1024;
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Evidence must be a regular JSON file no larger than 256 KiB.');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('Evidence exceeds 256 KiB.');
    input = JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, ''));
  } finally { await handle.close(); }
  console.log(JSON.stringify(await request(await ensureService(dir()), '/api/reconciliation', 'POST', input), null, 2));
});
reconcile.command('clear').option('--period <YYYY-MM>', 'UTC month').action(async options => {
  await request(await ensureService(dir()), reconciliationPath(options.period), 'DELETE'); console.log('已撤销所选月份的对账证据；本地调用与账户快照保留。');
});
void program.parseAsync().catch(error => { console.error(`PilotMeter: ${(error as Error).message}`); process.exitCode = 1; });
