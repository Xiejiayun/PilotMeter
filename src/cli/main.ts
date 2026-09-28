import { Command } from 'commander';
import { join, resolve } from 'node:path';
import crossSpawn from 'cross-spawn';
import { readFile } from 'node:fs/promises';
import { dataDirectory, VERSION } from '../shared/runtime.js';
import { ensureService, instanceAt, request, collectorForRun } from '../daemon/client.js';
import { statusText, cachedStatus, watch, openBrowser, terminalLink } from './terminal.js';
import { runCopilot } from './run.js';
import type { Summary } from '../shared/types.js';
import { installStatusline, restoreStatusline, inspectStatusline } from './statusline-config.js';

const program = new Command().name('pilotmeter').description('Local Copilot CLI usage meter; official quota stays unknown until verified.').version(VERSION).option('--data-dir <directory>', 'isolated application data directory').enablePositionalOptions();
const dir = () => dataDirectory(program.opts().dataDir);
const copilotCommand = () => process.env.PILOTMETER_COPILOT_BIN || 'copilot';
program.command('__serve', { hidden: true }).option('--demo').action(async options => { const { serve } = await import('../daemon/server.js'); await serve(dir(), options.demo); });
program.command('doctor').description('Read-only environment and service checks').action(async () => {
  const copilot = crossSpawn.sync(copilotCommand(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const instance = await instanceAt(dir());
  console.log(JSON.stringify({ node: process.version, platform: process.platform, copilot: copilot.status === 0 ? copilot.stdout.trim().slice(0, 120) : 'not-found', dataDirectory: dir(), service: instance ? { version: instance.version, url: instance.url } : 'stopped', officialQuota: 'unverified', statusline: inspectStatusline(), remoteTerminal: !!(process.env.SSH_CONNECTION || process.env.WSL_DISTRO_NAME), terminal: process.env.WT_SESSION ? 'Windows Terminal' : process.env.TERM_PROGRAM || process.env.TERM || 'unknown' }, null, 2));
});
program.command('start').option('--background', 'run detached in background').option('--open', 'open the local dashboard').action(async options => {
  if (options.background) { const instance = await ensureService(dir()); console.log(instance.url); if (options.open) await openBrowser(instance.url); }
  else { const existing = await instanceAt(dir()); if (existing) { console.log(existing.url); if (options.open) await openBrowser(existing.url); return; } const { serve } = await import('../daemon/server.js'); await serve(dir()); const instance = await instanceAt(dir()); console.log(instance?.url); if (options.open && instance) await openBrowser(instance.url); }
});
program.command('status').option('--json').action(async options => {
  const instance = await instanceAt(dir()); if (!instance) { if (options.json) console.log(JSON.stringify({ state: 'stopped' })); else console.log('PilotMeter 未启动 · pilotmeter start --background'); return; }
  const data = await request<Summary>(instance, '/api/summary'); console.log(options.json ? JSON.stringify(data) : `${statusText(data)}\n${terminalLink(instance.url)}`);
});
program.command('run').option('--replace-telemetry', 'replace existing exporter only for this child').option('--source-label <label>', 'explicit collection context for an account switch within the same COPILOT_HOME').argument('[args...]').allowUnknownOption().passThroughOptions().description('Run the original Copilot CLI with local telemetry; use -- before Copilot arguments').action(async (args, options) => { const instance = await collectorForRun(await ensureService(dir()), options.sourceLabel); process.exitCode = await runCopilot(instance, args, options.replaceTelemetry, copilotCommand()); });
program.command('watch').description('Independent terminal usage display; o opens, q exits').action(async () => { await watch(dir()); });
program.command('statusline').description('Read only the small local snapshot, suitable for Copilot statusLine').action(async () => { process.stdin.resume(); console.log(await cachedStatus(dir())); process.stdin.pause(); });
program.command('open').action(async () => { const instance = await ensureService(dir()); await openBrowser(instance.url); console.log(instance.url); });
program.command('demo').option('--open').description('Launch clearly labeled synthetic data in the separate demo subdirectory').action(async options => { const instance = await ensureService(join(dir(), 'demo'), true); console.log(`[虚构演示] ${instance.url}\n停止演示：pilotmeter --data-dir "${join(dir(), 'demo')}" stop`); if (options.open) await openBrowser(instance.url); });
program.command('init').option('--statusline', 'install the optional native statusline bridge').option('--restore-statusline', 'restore only fields still owned by PilotMeter').option('--replace', 'explicitly replace an existing statusLine after reviewing the proposed change').action(async options => {
  if (!!options.statusline === !!options.restoreStatusline) throw new Error('Choose --statusline or --restore-statusline.');
  if (options.restoreStatusline) { console.log(JSON.stringify(restoreStatusline({ dataDir: dir() }), null, 2)); return; }
  const version = crossSpawn.sync(copilotCommand(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const cliVersion = version.status === 0 ? version.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] : null;
  if (!cliVersion) throw new Error('Copilot CLI was not found; install it independently before statusline integration.');
  console.log(JSON.stringify(installStatusline({ dataDir: dir(), cliVersion, replace: options.replace }), null, 2));
});
program.command('stop').action(async () => { const instance = await instanceAt(dir()); if (!instance) { console.log('PilotMeter 已停止'); return; } await request(instance, '/api/shutdown', 'POST'); console.log('PilotMeter 正在正常停止'); });
program.command('import <file>').option('--source-label <label>', 'collection context matching run').description('Import supported OTLP traces JSONL through the shared ledger').action(async (file, options) => { const instance = await collectorForRun(await ensureService(dir()), options.sourceLabel); console.log(JSON.stringify(await request(instance, '/api/import', 'POST', { path: resolve(file), collectorToken: instance.collectorToken }))); });
program.command('config').command('set <key> <value>').action(async (key, value) => {
  if (key !== 'budget.monthlyCredits') throw new Error('Supported key: budget.monthlyCredits');
  const instance = await ensureService(dir()); await request(instance, '/api/settings', 'PATCH', { monthlyBudget: value === 'null' ? null : value }); console.log('已保存自定义月度预算（本机采集范围）。');
});
const account = program.command('account').description('Bind an explicit billing entity; credentials use PILOTMETER_GITHUB_TOKEN only');
account.command('connect').option('--user <login>').option('--organization <login>').option('--enterprise <slug>').option('--direct-billing', 'confirm that this personal account pays directly').action(async options => {
  const entries = [['user', options.user], ['organization', options.organization], ['enterprise', options.enterprise]].filter(([, login]) => !!login);
  if (entries.length !== 1) throw new Error('Select exactly one of --user, --organization or --enterprise.');
  const [kind, login] = entries[0]!;
  const result = await request<{credentialPresent: boolean}>(await ensureService(dir()), '/api/account', 'POST', { account: { kind, login, directBilling: options.directBilling === true } });
  console.log(`已绑定 ${kind}:${login}。${result.credentialPresent ? '可使用 account refresh 获取只读账单。' : '服务尚无专用凭据；设置 PILOTMETER_GITHUB_TOKEN 后 stop/start，再刷新。'}`);
});
account.command('disconnect').action(async () => { await request(await ensureService(dir()), '/api/account', 'POST', { account: null }); console.log('账户已断开；本地采集记录保留。'); });
account.command('refresh').action(async () => { console.log(JSON.stringify(await request(await ensureService(dir()), '/api/refresh', 'POST'), null, 2)); });
account.command('import-quota <file>').description('Import read-only quota with explicit monthly identity, pool and official-page verification evidence').action(async file => {
  const input = JSON.parse(await readFile(resolve(file), 'utf8'));
  console.log(JSON.stringify(await request(await ensureService(dir()), '/api/quota-import', 'POST', input), null, 2));
});
const unit = program.command('unit').description('Record or remove evidence that nano AIU matches Credits for the tested CLI');
unit.command('verify').requiredOption('--cli-version <version>').requiredOption('--evidence <description>', 'actual same-session /usage comparison').action(async options => { await request(await ensureService(dir()), '/api/unit-verification', 'POST', { cliVersion: options.cliVersion, evidence: options.evidence }); console.log('已保存单位核验证据；仅应用于相同 CLI 版本。'); });
unit.command('clear').action(async () => { await request(await ensureService(dir()), '/api/unit-verification', 'POST', { clear: true }); console.log('已撤销单位验证。'); });
void program.parseAsync().catch(error => { console.error(`PilotMeter: ${(error as Error).message}`); process.exitCode = 1; });
