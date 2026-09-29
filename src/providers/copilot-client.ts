import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { compareDecimals, nonNegativeDecimal, normalizeDecimal } from '../domain/decimal.js';
import type { AccountModel } from '../shared/models.js';

/** Account RPCs are experimental. These wire shapes were checked against SDK 1.0.14 / CLI 1.0.88. */
export const COPILOT_RUNTIME_VERSION = '1.0.88';
const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_LOGIN_OUTPUT = 64 * 1024;
const require = createRequire(import.meta.url);

export interface CopilotSafeError { code: string; message: string }
export class CopilotClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CopilotClientError'; }
}
export interface CopilotAccount {
  selectionId: string;
  host: string;
  login: string;
  authType: string;
  isCurrent: boolean;
}
export interface CopilotQuotaSnapshot {
  type: string;
  isUnlimitedEntitlement: boolean;
  entitlementRequests: string;
  usedRequests: string;
  remainingPercentage: string;
  overage: string;
  usageAllowedWithExhaustedQuota: boolean;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate: string | null;
  /** The experimental SDK quota schema does not declare a unit. No unit is inferred from its key. */
  unit: string | null;
  billingMode: 'ai-credits' | 'premium-requests' | 'unknown';
}
export interface CopilotQuota {
  selectionId: string;
  fetchedAt: string;
  scope: 'user';
  snapshots: CopilotQuotaSnapshot[];
}
export interface CopilotModels {
  selectionId: string;
  fetchedAt: string;
  items: AccountModel[];
}
export interface CopilotLogin {
  id: string;
  status: 'starting' | 'pending' | 'complete' | 'cancelled' | 'failed' | 'expired';
  host: string;
  verificationUri: string | null;
  userCode: string | null;
  /** Local maximum waiting time; the upstream device code may expire earlier. */
  expiresAt: string;
  error: CopilotSafeError | null;
}
export interface CopilotClientOptions {
  /** Required separate profile directory. The normal user's Copilot home is never used. */
  home: string;
  cwd?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  loginTimeoutMs?: number;
  /** Stop a login that cannot obtain a device code; default 60 seconds. */
  loginCodeTimeoutMs?: number;
  /** Close an unused account-query runtime after this delay; default 60 seconds. */
  idleTimeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function fail(code: string, message: string): CopilotClientError { return new CopilotClientError(code, message); }

/** Only public GitHub and Enterprise Cloud data-residency hosts are supported by this login UI. */
export function copilotHost(input = 'https://github.com'): string {
  let url: URL;
  try { url = new URL(input); } catch { throw fail('HOST_INVALID', 'GitHub 登录主机无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== '/' || !/^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/.test(url.hostname)) {
    throw fail('HOST_INVALID', '仅支持 github.com 或 GitHub Enterprise Cloud 登录主机');
  }
  return url.origin;
}

/** Official account metadata may use a bare hostname; user login input still requires an HTTPS URL. */
function accountHost(input: unknown): string | null {
  if (!safeText(input, 256)) return null;
  const value = /^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/i.test(input) ? `https://${input}` : input;
  try { return copilotHost(value); } catch { return null; }
}

export function resolveCopilotCommand(): string {
  const platforms: string[] = [process.platform];
  if (process.platform === 'linux') {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    if (!report.header?.glibcVersionRuntime) platforms.unshift('linuxmusl');
  }
  for (const platform of platforms) {
    try { return require.resolve(`@github/copilot-${platform}-${process.arch}`); } catch { /* Try the official fallback. */ }
  }
  throw fail('CLI_NOT_FOUND', '未找到随应用安装的 GitHub Copilot CLI，请重新安装 PilotMeter');
}

/** Do not inherit account overrides, exporters, loaders, or app-specific authentication secrets. */
export function copilotEnvironment(input: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (/^(?:COPILOT_|PILOTMETER_|GITHUB_|GH_|OTEL_|NODE_OPTIONS$|NODE_DEBUG$|BASH_ENV$|ENV$)/i.test(key)) continue;
    env[key] = value;
  }
  env.COPILOT_HOME = home;
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

interface SpawnedProcess { child: ChildProcessWithoutNullStreams; exited: Promise<void> }

async function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, assertOpen: () => void): Promise<SpawnedProcess> {
  // A direct executable avoids shell expansion and the npm loader's synchronous parent process.
  const js = /\.(?:mjs|cjs|js)$/i.test(command);
  for (let attempt = 0; attempt < 3; attempt++) {
    assertOpen();
    let exited: Promise<void> | undefined;
    try {
      const child = spawn(js ? process.execPath : command, js ? [command, ...args] : args,
        { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      exited = new Promise<void>(resolveExit => child.once('close', () => resolveExit()));
      await new Promise<void>((resolveSpawn, reject) => {
        const closedBeforeSpawn = () => reject(fail('CLI_START_FAILED', '无法启动 GitHub Copilot CLI'));
        child.once('spawn', () => { child.off('close', closedBeforeSpawn); resolveSpawn(); });
        // Keep this listener through the handoff so an error can never become unhandled.
        child.once('error', reject);
        child.once('close', closedBeforeSpawn);
      });
      // Do not consume either output stream here: the owner attaches its listeners before they flow.
      // After spawn succeeds the process is never retried, even if it immediately fails.
      return { child, exited };
    } catch (error) {
      if (exited) await waitForExit(exited);
      const code = object(error)?.code;
      if (attempt === 2 || code !== 'EPERM' && code !== 'EBUSY') throw fail('CLI_START_FAILED', '无法启动 GitHub Copilot CLI');
      await new Promise(resolveRetry => setTimeout(resolveRetry, 100 * (attempt + 1)));
    }
  }
  throw fail('CLI_START_FAILED', '无法启动 GitHub Copilot CLI');
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: CopilotClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

async function waitForExit(exited: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail('CLI_CLOSE_FAILED', 'Copilot 进程未能及时关闭，请重试')), 3000);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Minimal, bounded LSP-style JSON-RPC transport. It never logs runtime output or exposes raw errors. */
class Runtime {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #timeout: number;
  readonly #exited: Promise<void>;
  #buffer: Buffer = Buffer.alloc(0);
  #nextId = 0;
  #closed = false;
  get closed(): boolean { return this.#closed; }

  constructor(child: ChildProcessWithoutNullStreams, timeout: number, exited: Promise<void>) {
    this.#child = child; this.#timeout = timeout;
    this.#exited = exited;
    child.stdout.on('data', (chunk: Buffer) => this.#read(chunk));
    // Drain stderr without recording diagnostics that could contain authentication information.
    child.stderr.resume();
    child.on('error', () => this.#abort(fail('CLI_START_FAILED', '无法启动 GitHub Copilot CLI')));
    child.on('close', () => this.#abort(fail('CLI_CLOSED', 'GitHub Copilot CLI 连接已关闭')));
    child.stdin.on('error', () => this.#abort(fail('CLI_CLOSED', 'GitHub Copilot CLI 连接已关闭')));
    child.stdout.on('error', () => this.#abort(fail('CLI_PROTOCOL', 'GitHub Copilot CLI 响应无效')));
    child.stderr.on('error', () => this.#abort(fail('CLI_CLOSED', 'GitHub Copilot CLI 连接已关闭')));
  }

  #abort(error: CopilotClientError): void {
    if (this.#closed) return;
    this.#closed = true; this.#buffer = Buffer.alloc(0);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.#child.kill();
  }

  #write(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message));
    this.#child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  #read(chunk: Buffer): void {
    if (this.#closed) return;
    if (this.#buffer.length + chunk.length > MAX_MESSAGE + 8192) { this.#abort(fail('CLI_PROTOCOL', 'GitHub Copilot CLI 响应过大')); return; }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && this.#buffer.length) {
      const end = this.#buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (this.#buffer.length > 8192) this.#abort(fail('CLI_PROTOCOL', 'GitHub Copilot CLI 响应头无效')); return; }
      if (end > 8192) { this.#abort(fail('CLI_PROTOCOL', 'GitHub Copilot CLI 响应头无效')); return; }
      const header = this.#buffer.subarray(0, end).toString('ascii');
      const lengths = header.split('\r\n').map(line => /^Content-Length: ([0-9]+)$/i.exec(line)).filter(match => match !== null);
      const length = lengths.length === 1 ? Number(lengths[0]![1]) : NaN;
      if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MESSAGE) { this.#abort(fail('CLI_PROTOCOL', 'GitHub Copilot CLI 响应长度无效')); return; }
      if (this.#buffer.length < end + 4 + length) return;
      const bytes = this.#buffer.subarray(end + 4, end + 4 + length);
      this.#buffer = this.#buffer.subarray(end + 4 + length);
      let response: Record<string, unknown> | null;
      try {
        response = object(JSON.parse(bytes.toString('utf8'), (key: string, value: unknown, context?: { source?: string }) => {
          if (!['entitlementRequests', 'usedRequests', 'remainingPercentage', 'overage', 'multiplier'].includes(key) || typeof value !== 'number') return value;
          if (!context?.source) throw fail('EXACT_JSON_UNAVAILABLE', '当前运行时无法保留额度小数精度');
          return context.source;
        }));
      } catch { response = null; }
      if (!response || response.jsonrpc !== '2.0') { this.#abort(fail('CLI_PROTOCOL', 'GitHub Copilot CLI 响应格式无效')); return; }
      // This client opens no sessions and grants no tools. Decline any unexpected server request.
      if (typeof response.method === 'string') {
        if (typeof response.id === 'number' || typeof response.id === 'string') {
          this.#write({ jsonrpc: '2.0', id: response.id, error: { code: -32601, message: 'Method not supported' } });
        }
        continue;
      }
      if (typeof response.id !== 'number') continue;
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id); clearTimeout(pending.timer);
      if (response.error !== undefined) {
        const code = object(response.error)?.code;
        pending.reject(code === -32601 ? fail('RPC_UNSUPPORTED', '当前 Copilot CLI 不支持所需账号接口') : fail('RPC_FAILED', 'Copilot 账号请求失败，请检查登录与网络后重试'));
      } else if (!Object.hasOwn(response, 'result')) pending.reject(fail('CLI_PROTOCOL', 'GitHub Copilot CLI 响应缺少结果'));
      else pending.resolve(response.result);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(fail('CLI_CLOSED', 'GitHub Copilot CLI 连接已关闭'));
    const id = ++this.#nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => this.#abort(fail('CLI_TIMEOUT', 'Copilot 账号请求超时，请重试')), this.#timeout);
      timer.unref();
      this.#pending.set(id, { resolve: resolveRequest, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async close(): Promise<void> {
    this.#abort(fail('CLI_CLOSED', 'GitHub Copilot CLI 连接已关闭'));
    await waitForExit(this.#exited);
  }
}

interface LoginOperation {
  state: CopilotLogin; child: ChildProcessWithoutNullStreams; timer: ReturnType<typeof setTimeout>;
  codeTimer: ReturnType<typeof setTimeout> | null;
  stdoutText: string; stderrText: string; bytes: number; stdout: StringDecoder; stderr: StringDecoder;
  exited: Promise<void>;
}

/** Classify known CLI failures without returning its output, URLs, or credential diagnostics. */
function loginFailure(operation: LoginOperation): CopilotSafeError {
  const output = stripVTControlCharacters(`${operation.stdoutText}\n${operation.stderrText}`);
  if (/\b(?:expired_token|device code (?:has )?expired|code has expired)\b/i.test(output)) {
    return { code: 'LOGIN_EXPIRED', message: 'GitHub 验证码已过期，请重新登录获取新验证码。' };
  }
  if (/\b(?:access_denied|authorization (?:was )?denied|authorization (?:was )?declined)\b/i.test(output)) {
    return { code: 'LOGIN_DENIED', message: 'GitHub 授权未获批准，请重新登录，并在授权页确认允许访问。' };
  }
  if (/\b(?:request failed|error sending request|fetch failed|network error|connection (?:refused|reset|timed out)|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|certificate verify failed|unable to (?:get local issuer|verify the first) certificate)\b/i.test(output)) {
    return { code: 'LOGIN_NETWORK_ERROR', message: '无法连接 GitHub 登录服务。请检查网络或代理设置，再重试登录。' };
  }
  return { code: 'LOGIN_FAILED', message: 'GitHub 登录未完成。请重新登录，并在浏览器中输入验证码、确认授权后返回。' };
}

/** All credentials stay with the official CLI; only safe account metadata and user quota leave this boundary. */
export class CopilotClient {
  readonly #options: CopilotClientOptions;
  readonly #home: string;
  readonly #env: NodeJS.ProcessEnv;
  #runtime: Promise<Runtime> | null = null;
  #closingRuntime: Promise<void> | null = null;
  #login: LoginOperation | null = null;
  #startingLogin: Promise<void> | null = null;
  #closed = false;
  #accounts = new Set<string>();
  #accountRuntime: Runtime | null = null;
  #activeQueries = 0;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CopilotClientOptions) {
    if (!options || typeof options.home !== 'string' || !isAbsolute(options.home)) throw fail('HOME_INVALID', 'Copilot 账号需要独立的绝对路径目录');
    this.#home = resolve(options.home);
    const normalHome = resolve(join(homedir(), '.copilot'));
    if (this.#home.toLowerCase() === normalHome.toLowerCase() || this.#home.toLowerCase() === homedir().toLowerCase()) {
      throw fail('HOME_INVALID', '不能使用默认 Copilot 目录管理 PilotMeter 账号');
    }
    for (const value of [options.requestTimeoutMs, options.loginTimeoutMs, options.loginCodeTimeoutMs, options.idleTimeoutMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 30 * 60_000)) throw fail('OPTIONS_INVALID', 'Copilot 超时设置无效');
    }
    this.#options = options;
    this.#env = copilotEnvironment(options.env ?? process.env, this.#home);
  }

  #assertOpen(): void { if (this.#closed) throw fail('CLIENT_CLOSED', 'Copilot 账号连接已关闭'); }
  #loginActive(): boolean { return this.#startingLogin !== null || this.#login?.state.status === 'starting' || this.#login?.state.status === 'pending'; }
  #assertQueryAvailable(): void {
    this.#assertOpen();
    if (this.#loginActive()) throw fail('LOGIN_IN_PROGRESS', '请先完成或取消当前 GitHub 登录');
  }
  async #prepareHome(): Promise<void> {
    try { await mkdir(this.#home, { recursive: true, mode: 0o700 }); }
    catch { throw fail('HOME_UNAVAILABLE', '无法创建独立 Copilot 账号目录'); }
  }
  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
  async #query<T>(action: (runtime: Runtime) => Promise<T>): Promise<T> {
    this.#clearIdle(); this.#activeQueries++;
    try { return await action(await this.#openRuntime()); }
    finally {
      this.#activeQueries--;
      if (this.#activeQueries === 0 && this.#runtime && !this.#closed && !this.#loginActive()) {
        const expected = this.#runtime;
        this.#idleTimer = setTimeout(() => {
          this.#idleTimer = null;
          if (this.#activeQueries === 0 && this.#runtime === expected) void this.#closeRuntime().catch(() => {});
        }, this.#options.idleTimeoutMs ?? 60_000);
        this.#idleTimer.unref();
      }
    }
  }

  async #openRuntime(): Promise<Runtime> {
    this.#assertQueryAvailable();
    while (this.#closingRuntime) {
      await this.#closingRuntime;
      this.#assertQueryAvailable();
    }
    while (this.#runtime) {
      const opening = this.#runtime;
      const current = await opening;
      this.#assertQueryAvailable();
      if (this.#runtime !== opening) continue;
      if (!current.closed) return current;
      this.#runtime = null;
    }
    this.#accounts.clear(); this.#accountRuntime = null;
    const opening = (async () => {
      await this.#prepareHome();
      this.#assertQueryAvailable();
      const { child, exited } = await launch(this.#options.command ?? resolveCopilotCommand(),
        ['--headless', '--no-auto-update', '--log-level', 'none', '--stdio'], this.#options.cwd ?? this.#home, this.#env, () => this.#assertQueryAvailable());
      const runtime = new Runtime(child, this.#options.requestTimeoutMs ?? 15_000, exited);
      try {
        this.#assertQueryAvailable();
        const connected = object(await runtime.request('connect', {}));
        if (connected?.ok !== true || connected.protocolVersion !== 3 || connected.version !== COPILOT_RUNTIME_VERSION) {
          throw fail('CLI_INCOMPATIBLE', 'Copilot CLI 版本不兼容，需要随应用提供的 1.0.88');
        }
        return runtime;
      } catch (error) { await runtime.close(); throw error; }
    })();
    this.#runtime = opening;
    try { return await opening; }
    catch (error) { if (this.#runtime === opening) this.#runtime = null; throw error; }
  }

  async #closeRuntime(): Promise<void> {
    this.#clearIdle();
    const runtime = this.#runtime; this.#runtime = null; this.#accounts.clear(); this.#accountRuntime = null;
    if (!runtime) {
      if (this.#closingRuntime) await this.#closingRuntime;
      return;
    }
    const previous = this.#closingRuntime;
    const closing = (async () => {
      if (previous) await previous;
      let current: Runtime;
      try { current = await runtime; } catch { return; }
      await current.close();
    })();
    this.#closingRuntime = closing;
    try { await closing; }
    finally { if (this.#closingRuntime === closing) this.#closingRuntime = null; }
  }

  async listAccounts(): Promise<CopilotAccount[]> {
    return this.#query(async runtime => {
    const auth = object(await runtime.request('auth.getStatus', {}));
    const currentHost = accountHost(auth?.host);
    const result = await runtime.request('account.getAllUsers', {});
    if (!Array.isArray(result) || result.length > 100) throw fail('ACCOUNTS_INVALID', 'Copilot 账号列表格式无法识别');
    const accounts: CopilotAccount[] = [];
    const seen = new Set<string>();
    for (const raw of result) {
      const entry = object(raw); const info = object(entry?.authInfo);
      if (!entry || !info || !safeText(entry.selectionId, 4096) || !safeText(info.login, 128)
        || !/^[a-z\d](?:[a-z\d_-]{0,126}[a-z\d])?$/i.test(info.login)
        || !['user', 'gh-cli', 'env', 'token', 'token-provider', 'copilot-api-token'].includes(String(info.type))) continue;
      const host = accountHost(info.host);
      if (host === null) continue;
      if (seen.has(entry.selectionId)) throw fail('ACCOUNTS_INVALID', 'Copilot 账号标识重复');
      seen.add(entry.selectionId);
      accounts.push({ selectionId: entry.selectionId, host, login: info.login, authType: String(info.type),
        isCurrent: auth?.isAuthenticated === true && typeof auth.login === 'string' && auth.login.toLowerCase() === info.login.toLowerCase()
          && currentHost === host });
    }
    if (runtime.closed) throw fail('CLI_CLOSED', 'GitHub Copilot CLI 连接已关闭');
    this.#accounts = new Set(accounts.map(account => account.selectionId)); this.#accountRuntime = runtime;
    return accounts;
    });
  }

  async getQuota(selectionId: string): Promise<CopilotQuota> {
    if (!safeText(selectionId, 4096)) throw fail('ACCOUNT_INVALID', 'Copilot 账号标识无效');
    return this.#query(async runtime => {
    if (this.#accountRuntime !== runtime || !this.#accounts.has(selectionId)) throw fail('ACCOUNT_NOT_FOUND', '请重新获取账号列表后选择账号');
    const result = object(await runtime.request('account.getQuota', { selectionId }));
    const rawSnapshots = object(result?.quotaSnapshots);
    if (!rawSnapshots || Object.keys(rawSnapshots).length > 64) throw fail('QUOTA_INVALID', 'Copilot 额度响应格式无法识别');
    const snapshots: CopilotQuotaSnapshot[] = [];
    for (const [type, raw] of Object.entries(rawSnapshots)) {
      if (raw === undefined || raw === null) continue;
      const snapshot = object(raw);
      if (!snapshot || !/^[a-z][a-z\d_\-]{0,63}$/i.test(type)
        || ['isUnlimitedEntitlement', 'usageAllowedWithExhaustedQuota', 'overageAllowedWithExhaustedQuota'].some(key => typeof snapshot[key] !== 'boolean')
        || typeof snapshot.remainingPercentage !== 'string'
        || snapshot.resetDate !== undefined && (!safeText(snapshot.resetDate, 64) || !Number.isFinite(Date.parse(snapshot.resetDate)))) {
        throw fail('QUOTA_INVALID', 'Copilot 额度字段无法识别');
      }
      let entitlement: string; let used: string; let overage: string; let remainingPercentage: string;
      try {
        if (typeof snapshot.entitlementRequests !== 'string') throw new Error();
        entitlement = normalizeDecimal(snapshot.entitlementRequests);
        if (entitlement !== '-1' || !snapshot.isUnlimitedEntitlement) entitlement = nonNegativeDecimal(entitlement);
        used = nonNegativeDecimal(snapshot.usedRequests); overage = nonNegativeDecimal(snapshot.overage);
        remainingPercentage = nonNegativeDecimal(nonNegativeDecimal(snapshot.remainingPercentage));
        if (compareDecimals(remainingPercentage, '100') > 0) throw new Error();
      } catch { throw fail('QUOTA_INVALID', 'Copilot 额度数值无法识别'); }
      const unit = ['ai-credits', 'premium-requests'].includes(String(snapshot.unit)) ? snapshot.unit as string : null;
      const billingMode = unit !== null && snapshot.billingMode === unit ? unit as 'ai-credits' | 'premium-requests' : 'unknown';
      snapshots.push({ type, isUnlimitedEntitlement: snapshot.isUnlimitedEntitlement as boolean,
        entitlementRequests: entitlement, usedRequests: used,
        remainingPercentage, overage,
        usageAllowedWithExhaustedQuota: snapshot.usageAllowedWithExhaustedQuota as boolean,
        overageAllowedWithExhaustedQuota: snapshot.overageAllowedWithExhaustedQuota as boolean,
        resetDate: snapshot.resetDate === undefined ? null : snapshot.resetDate as string, unit, billingMode });
    }
    return { selectionId, fetchedAt: new Date().toISOString(), scope: 'user', snapshots };
    });
  }

  /** SDK v1.0.14 ModelsListRequest binds this read-only RPC to an account.getAllUsers selection. */
  async listModels(selectionId: string): Promise<CopilotModels> {
    if (!safeText(selectionId, 4096)) throw fail('ACCOUNT_INVALID', 'Copilot 账号标识无效');
    return this.#query(async runtime => {
      if (this.#accountRuntime !== runtime || !this.#accounts.has(selectionId)) throw fail('ACCOUNT_NOT_FOUND', '请重新获取账号列表后选择账号');
      const result = object(await runtime.request('models.list', { selectionId }));
      if (!Array.isArray(result?.models) || result.models.length > 512) throw fail('MODELS_INVALID', 'Copilot 模型目录格式无法识别');
      const ids = new Set<string>();
      const items: AccountModel[] = result.models.map(raw => {
        const model = object(raw);
        if (!model || !safeText(model.id, 128) || !/^[a-z\d][a-z\d._:/-]*$/i.test(model.id)
          || !safeText(model.name, 160) || ids.has(model.id)) throw fail('MODELS_INVALID', 'Copilot 模型标识无法识别');
        ids.add(model.id);
        const policy = object(model.policy)?.state;
        const policyState: AccountModel['policyState'] = policy === 'enabled' || policy === 'disabled' || policy === 'unconfigured' ? policy : null;
        const status = policyState === 'enabled' ? 'available' : policyState === 'disabled' ? 'disabled' : 'unknown';
        const capabilities = object(model.capabilities);
        const supports = object(capabilities?.supports);
        const context = object(capabilities?.limits)?.max_context_window_tokens;
        const rawMultiplier = object(model.billing)?.multiplier;
        let multiplier: string | null = null;
        try { if (rawMultiplier !== undefined) multiplier = nonNegativeDecimal(nonNegativeDecimal(rawMultiplier)); } catch { /* Omit unsupported billing metadata. */ }
        return { id: model.id, name: model.name, status, policyState,
          reason: status === 'available' ? '官方模型策略明确启用；不代表已完成实际调用验证。'
            : status === 'disabled' ? '官方模型策略明确禁用；未推断禁用主体。' : '模型目录已返回，当前策略未明确确认使用资格。',
          vision: typeof supports?.vision === 'boolean' ? supports.vision : null,
          reasoningEffort: typeof supports?.reasoningEffort === 'boolean' ? supports.reasoningEffort : null,
          contextWindowTokens: typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? context : null,
          multiplier,
        };
      });
      return { selectionId, fetchedAt: new Date().toISOString(), items };
    });
  }

  async startLogin(inputHost = 'https://github.com'): Promise<CopilotLogin> {
    this.#assertOpen();
    const host = copilotHost(inputHost);
    if (this.#loginActive()) throw fail('LOGIN_IN_PROGRESS', '已有 GitHub 登录正在进行');
    let finishStarting!: () => void;
    this.#startingLogin = new Promise<void>(resolveStarting => { finishStarting = resolveStarting; });
    try {
      if (this.#login) await waitForExit(this.#login.exited);
      await this.#closeRuntime();
      await this.#prepareHome();
      this.#assertOpen();
      const timeout = this.#options.loginTimeoutMs ?? 15 * 60_000;
      const state: CopilotLogin = { id: randomUUID(), status: 'starting', host, verificationUri: null, userCode: null,
        expiresAt: new Date(Date.now() + timeout).toISOString(), error: null };
      const { child, exited } = await launch(this.#options.command ?? resolveCopilotCommand(),
        ['--no-auto-update', '--no-color', 'login', '--device-code', '--host', host], this.#options.cwd ?? this.#home, this.#env, () => this.#assertOpen());
      if (this.#closed) {
        child.stdout.resume(); child.stderr.resume(); child.kill();
        await waitForExit(exited);
        this.#assertOpen();
      }
      const timer = setTimeout(() => this.#finishLogin(operation, 'expired', { code: 'LOGIN_EXPIRED', message: '登录等待已超时，请重新发起登录' }), timeout);
      timer.unref();
      const codeTimer = setTimeout(() => this.#finishLogin(operation, 'failed', { code: 'LOGIN_CODE_TIMEOUT',
        message: '暂未获取到 GitHub 验证码。请检查网络或代理设置，再重试登录。' }), this.#options.loginCodeTimeoutMs ?? 60_000);
      codeTimer.unref();
      const operation: LoginOperation = { state, child, timer, codeTimer, stdoutText: '', stderrText: '', bytes: 0, stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8'), exited };
      this.#login = operation;
      child.stdin.on('error', () => { /* The login command may close stdin immediately. */ });
      child.stdout.on('data', (chunk: Buffer) => this.#loginOutput(operation, chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => this.#loginOutput(operation, chunk, 'stderr'));
      child.stdout.on('error', () => this.#finishLogin(operation, 'failed', { code: 'LOGIN_FAILED', message: '无法读取 GitHub 登录状态' }));
      child.stderr.on('error', () => this.#finishLogin(operation, 'failed', { code: 'LOGIN_FAILED', message: '无法读取 GitHub 登录状态' }));
      child.on('error', () => this.#finishLogin(operation, 'failed', { code: 'LOGIN_START_FAILED', message: '无法启动 GitHub 登录' }));
      child.on('close', code => {
        if (operation.state.status !== 'starting' && operation.state.status !== 'pending') return;
        if (code === 0 && operation.state.verificationUri && operation.state.userCode) this.#finishLogin(operation, 'complete');
        else {
          const error = loginFailure(operation);
          this.#finishLogin(operation, error.code === 'LOGIN_EXPIRED' ? 'expired' : 'failed', error);
        }
      });
      // The official device flow polls GitHub; PilotMeter never exchanges or receives an OAuth token.
      child.stdin.end();
      return { ...state };
    } finally { this.#startingLogin = null; finishStarting(); }
  }

  #loginOutput(operation: LoginOperation, chunk: Buffer, stream: 'stdout' | 'stderr'): void {
    if (operation.state.status !== 'starting' && operation.state.status !== 'pending') return;
    operation.bytes += chunk.length;
    if (operation.bytes > MAX_LOGIN_OUTPUT) {
      this.#finishLogin(operation, 'failed', { code: 'LOGIN_OUTPUT_INVALID', message: 'GitHub 登录输出超出支持范围' }); return;
    }
    operation[`${stream}Text`] += operation[stream].write(chunk);
    const output = stripVTControlCharacters(`${operation.stdoutText}\n${operation.stderrText}`);
    const urls = output.match(/https:\/\/[^\s<>"']+/g) ?? [];
    const expected = `${operation.state.host}/login/device`;
    operation.state.verificationUri = null;
    for (const candidate of urls) {
      // CLI decoration may put a period or a closing parenthesis after a URL.
      const trimmed = candidate.replace(/[).,;]+$/, '');
      if (trimmed === expected) operation.state.verificationUri = expected;
    }
    const codes = new Set([...output.matchAll(/(?<![\p{L}\p{N}_-])([A-Z0-9]{4}-[A-Z0-9]{4})(?![\p{L}\p{N}_-])/gu)].map(match => match[1]!));
    if (codes.size > 1) { this.#finishLogin(operation, 'failed', { code: 'LOGIN_OUTPUT_INVALID', message: 'GitHub 登录输出含有不一致的设备码' }); return; }
    operation.state.userCode = codes.size === 1 && /\bcode\b/i.test(output) ? [...codes][0]! : null;
    operation.state.status = operation.state.verificationUri && operation.state.userCode ? 'pending' : 'starting';
    if (operation.state.status === 'pending' && operation.codeTimer) { clearTimeout(operation.codeTimer); operation.codeTimer = null; }
  }

  #finishLogin(operation: LoginOperation, status: CopilotLogin['status'], error: CopilotSafeError | null = null): void {
    if (operation.state.status !== 'starting' && operation.state.status !== 'pending') return;
    clearTimeout(operation.timer);
    if (operation.codeTimer) clearTimeout(operation.codeTimer);
    operation.codeTimer = null; operation.stdoutText = ''; operation.stderrText = '';
    operation.state = { ...operation.state, status, error, userCode: null, verificationUri: null };
    operation.child.kill();
    this.#accounts.clear(); this.#accountRuntime = null;
  }

  getLogin(id: string): CopilotLogin | null { return this.#login?.state.id === id ? { ...this.#login.state } : null; }
  cancelLogin(id: string): CopilotLogin | null {
    if (this.#login?.state.id !== id) return null;
    this.#finishLogin(this.#login, 'cancelled');
    return this.getLogin(id);
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#login) this.#finishLogin(this.#login, 'cancelled');
    await this.#closeRuntime();
    if (this.#startingLogin) await this.#startingLogin;
    if (this.#login) await waitForExit(this.#login.exited);
  }
}
