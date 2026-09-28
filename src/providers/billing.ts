import type { UsageSnapshot } from '../shared/types.js';
import { addDecimals, nonNegativeDecimal } from '../domain/decimal.js';
import { monthlyPeriod, timestamp } from '../domain/period.js';

export interface BillingAccount { kind: 'user' | 'organization' | 'enterprise'; login: string; directBilling?: boolean }
export interface BillingProviderOptions { now?: () => Date; timeoutMs?: number; minIntervalMs?: number }
type Fetcher = typeof globalThis.fetch;
type SafeError = NonNullable<UsageSnapshot['lastError']>;
interface Entry {
  snapshot: UsageSnapshot | null; nextAllowedAt: number; permissionDenied: boolean;
  failures: number; inFlight: Promise<UsageSnapshot> | null;
}

/** Endpoint-specific requirements; this metadata does not claim the current token has permission. */
export const BILLING_REQUIREMENTS = {
  user: { permission: 'Plan: read', role: '个人直接付费账户', fineGrainedPat: true },
  organization: { permission: 'Administration: read', role: '具备用量读取权限的组织管理员', fineGrainedPat: true },
  enterprise: { permission: 'Enterprise billing: read', role: '具备企业账单读取权限的企业身份', fineGrainedPat: false },
} as const;

export function billingEntity(account: BillingAccount): string {
  if (!['user', 'organization', 'enterprise'].includes(account.kind) || typeof account.login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i.test(account.login)) throw new RangeError('Invalid billing identity');
  return `${account.kind}:${account.login.toLowerCase()}`;
}

export function unknownBillingSnapshot(account: BillingAccount, period: string, now: Date, error: SafeError | null = null): UsageSnapshot {
  const entity = billingEntity(account); const range = monthlyPeriod(period);
  return {
    source: 'billing-rest', billingEntity: entity, usageSubject: entity, poolId: null, products: [],
    periodStart: range.start, periodEnd: range.end, billingMode: 'unknown', unit: 'unknown',
    used: null, coverage: 'unknown', state: 'unknown', limit: null, limitKind: 'unknown',
    verifiedAt: null, fetchedAt: now.toISOString(), providerUpdatedAt: null, stale: false, lastError: error,
  };
}

class ProviderFailure extends Error {
  constructor(readonly safe: SafeError) { super(safe.message); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Parse grossQuantity from its JSON source text before IEEE-754 can round it. Node 24 supplies context.source. */
function parseReport(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key !== 'grossQuantity' || typeof value !== 'number') return value;
    if (!context?.source) throw new ProviderFailure({ code: 'EXACT_JSON_UNAVAILABLE', message: '当前运行时不能保留账单小数精度' });
    return context.source;
  });
}

async function boundedBody(response: Response): Promise<string> {
  const maximum = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new ProviderFailure({ code: 'REPORT_TOO_LARGE', message: '账单响应超过大小限制' });
  }
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new ProviderFailure({ code: 'REPORT_TOO_LARGE', message: '账单响应超过大小限制' }); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length).toString('utf8');
}

export function mapBillingReport(report: unknown, account: BillingAccount, period: string, now = new Date()): UsageSnapshot {
  const base = unknownBillingSnapshot(account, period, now);
  const invalid = (code: string, message: string, state: UsageSnapshot['state'] = 'unknown'): UsageSnapshot => ({ ...base, state, lastError: { code, message } });
  const data = object(report); const requested = monthlyPeriod(period);
  if (!data || !Array.isArray(data.usageItems)) return invalid('REPORT_INVALID', '账单响应结构无法识别');
  const subject = data[account.kind === 'organization' ? 'organization' : account.kind === 'enterprise' ? 'enterprise' : 'user'];
  if (typeof subject !== 'string' || subject.toLowerCase() !== account.login.toLowerCase()) return invalid('SUBJECT_MISMATCH', '账单响应与所选计费主体不一致');
  const range = object(data.timePeriod);
  if (!range || range.year !== requested.year || range.month !== requested.month || range.day !== undefined && range.day !== null) return invalid('PERIOD_MISMATCH', '账单响应未确认所选完整 UTC 月份');
  const filters = ['product', 'model', 'costCenter', ...(account.kind !== 'user' ? ['user'] : []), ...(account.kind === 'enterprise' ? ['organization'] : [])];
  if (filters.some(key => data[key] !== undefined && data[key] !== null && data[key] !== '')) return invalid('FILTERED_REPORT', '账单响应包含未请求的范围筛选');
  if (account.kind === 'user' && account.directBilling !== true) return invalid('BILLING_ENTITY_UNVERIFIED', '个人端点不代表组织或企业承担的消费');
  if (data.usageItems.length === 0) return invalid('REPORT_EMPTY', '报告无条目；不能据此确认用量为零', 'empty');

  let sum = '0'; let recognized = 0; let unsupported = 0;
  for (const raw of data.usageItems) {
    const item = object(raw);
    if (!item || item.product !== 'Copilot AI Credits' || item.sku !== 'AI Credit' || item.unitType !== 'ai-credits') { unsupported++; continue; }
    try {
      // mapBillingReport can be called with already parsed fixtures. Only safe integer Numbers are lossless.
      const gross = typeof item.grossQuantity === 'number' && Number.isSafeInteger(item.grossQuantity) ? String(item.grossQuantity) : item.grossQuantity;
      sum = addDecimals(sum, nonNegativeDecimal(gross)); recognized++;
    } catch { return invalid('QUANTITY_INVALID', '已识别账单产品包含无效或精度不明的数量', 'unsupported'); }
  }
  if (recognized === 0) return invalid('PRODUCT_UNSUPPORTED', '报告产品、SKU 或单位尚未验证', 'unsupported');
  return {
    ...base, billingMode: 'ai-credits', unit: 'ai-credits', used: sum, coverage: 'partial', state: 'known',
    products: ['Copilot AI Credits'],
    lastError: unsupported ? { code: 'PRODUCTS_PARTIAL', message: '仅展示已识别 Copilot 产品；其他条目不计入当前小计' } : null,
  };
}

function retryDeadline(response: Response, now: number, failures: number): number {
  const retryAfter = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  let deadline = now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 4));
  if (retryAfter !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const requested = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(requested)) deadline = Math.max(deadline, requested);
  }
  if (reset !== null && /^\d+$/.test(reset)) {
    const requested = Number(reset) * 1000;
    if (Number.isFinite(requested)) deadline = Math.max(deadline, requested);
  }
  return deadline;
}

/** No credentials are cached, persisted, logged, put in a URL, or forwarded through a redirect. */
export class BillingProvider {
  readonly #fetch: Fetcher;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #minIntervalMs: number;
  readonly #entries = new Map<string, Entry>();

  constructor(fetcher: Fetcher = globalThis.fetch, options: BillingProviderOptions = {}) {
    this.#fetch = fetcher; this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 15_000; this.#minIntervalMs = options.minIntervalMs ?? 30_000;
  }

  #key(account: BillingAccount, period: string): string { monthlyPeriod(period); return `${billingEntity(account)}/${period}`; }

  #entry(key: string): Entry {
    let entry = this.#entries.get(key);
    if (!entry) { entry = { snapshot: null, nextAllowedAt: 0, permissionDenied: false, failures: 0, inFlight: null }; this.#entries.set(key, entry); }
    return entry;
  }

  /** Explicit reconnection may resume permission failures, but must not bypass retry deadlines. */
  resume(account: BillingAccount, period: string): void {
    const entry = this.#entry(this.#key(account, period));
    if (!entry.permissionDenied) return;
    entry.permissionDenied = false; entry.nextAllowedAt = 0; entry.failures = 0;
  }

  nextRetryAt(account: BillingAccount, period: string): string | null {
    const entry = this.#entries.get(this.#key(account, period));
    return entry && !entry.permissionDenied && entry.nextAllowedAt > 0 ? new Date(entry.nextAllowedAt).toISOString() : null;
  }

  /** Restore data and retry gates together; a restart must not bypass an upstream retry deadline. */
  restoreSnapshot(snapshot: UsageSnapshot): void {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.billingEntity !== 'string') return;
    const match = /^(user|organization|enterprise):([a-z\d-]+)$/i.exec(snapshot.billingEntity);
    if (!match || snapshot.source !== 'billing-rest' || !['known', 'empty', 'unknown', 'unsupported'].includes(snapshot.state)
      || typeof snapshot.usageSubject !== 'string' || snapshot.usageSubject.toLowerCase() !== snapshot.billingEntity.toLowerCase()
      || typeof snapshot.periodStart !== 'string' || typeof snapshot.stale !== 'boolean' || snapshot.poolId !== null) return;
    const account: BillingAccount = { kind: match[1]!.toLowerCase() as BillingAccount['kind'], login: match[2]! };
    const period = snapshot.periodStart.slice(0, 7); let range;
    try { billingEntity(account); range = monthlyPeriod(period); } catch { return; }
    if (timestamp(snapshot.periodStart) !== Date.parse(range.start) || timestamp(snapshot.periodEnd) !== Date.parse(range.end)) return;
    if (timestamp(snapshot.fetchedAt) === null || !Array.isArray(snapshot.products)
      || snapshot.products.some(product => product !== 'Copilot AI Credits') || snapshot.products.length > 1) return;
    if (snapshot.state === 'known') {
      if (snapshot.billingMode !== 'ai-credits' || snapshot.unit !== 'ai-credits' || snapshot.products.length !== 1) return;
      try { nonNegativeDecimal(snapshot.used); } catch { return; }
    } else if (snapshot.used !== null || snapshot.billingMode !== 'unknown' || snapshot.unit !== 'unknown' || snapshot.products.length !== 0) return;
    const error = snapshot.lastError;
    if (error !== null && (!object(error) || typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      || typeof error.message !== 'string' || error.message.length > 1000 || /[\u0000-\u001f\u007f-\u009f]/.test(error.message))) return;
    const retry = snapshot.retryAt === undefined || snapshot.retryAt === null ? null : timestamp(snapshot.retryAt);
    if (snapshot.retryAt !== undefined && snapshot.retryAt !== null && retry === null) return;
    const entry = this.#entry(this.#key(account, period));
    entry.permissionDenied = error?.code === 'PERMISSION_DENIED' || error?.code === 'AUTHENTICATION_FAILED';
    entry.nextAllowedAt = entry.permissionDenied ? 0 : retry ?? 0;
    entry.snapshot = { ...structuredClone(snapshot), stale: snapshot.state === 'known' || snapshot.stale,
      coverage: snapshot.state === 'known' ? 'partial' : 'unknown', limit: null, limitKind: 'unknown', verifiedAt: null,
      retryAt: entry.permissionDenied ? null : snapshot.retryAt ?? null };
  }

  async fetchSnapshot(account: BillingAccount, period: string, token: string): Promise<UsageSnapshot> {
    const key = this.#key(account, period); const now = this.#now(); const entry = this.#entry(key);
    if (account.kind === 'user' && account.directBilling !== true) return unknownBillingSnapshot(account, period, now, { code: 'BILLING_ENTITY_UNVERIFIED', message: '请使用实际组织或企业计费主体；个人消费不能代表公司付费消费' });
    if (typeof token !== 'string' || !token || token.length > 4096 || /\s/.test(token)) return this.#failure(entry, account, period, { code: 'CREDENTIAL_MISSING', message: '缺少有效的显式账单凭据' });
    if (entry.inFlight) return structuredClone(await entry.inFlight);
    if ((entry.permissionDenied || now.getTime() < entry.nextAllowedAt) && entry.snapshot) return structuredClone(entry.snapshot);
    const pending = this.#perform(entry, account, period, token);
    entry.inFlight = pending;
    try { return structuredClone(await pending); } finally { entry.inFlight = null; }
  }

  #failure(entry: Entry, account: BillingAccount, period: string, error: SafeError, state: UsageSnapshot['state'] = 'unknown'): UsageSnapshot {
    const previous = entry.snapshot;
    const retryAt = !entry.permissionDenied && entry.nextAllowedAt > 0 ? new Date(entry.nextAllowedAt).toISOString() : null;
    const snapshot: UsageSnapshot = previous?.state === 'known'
      ? { ...previous, stale: true, lastError: error, retryAt }
      : { ...unknownBillingSnapshot(account, period, this.#now(), error), state, retryAt };
    entry.snapshot = snapshot;
    return structuredClone(snapshot);
  }

  async #perform(entry: Entry, account: BillingAccount, period: string, token: string): Promise<UsageSnapshot> {
    const range = monthlyPeriod(period);
    const segment = account.kind === 'user' ? 'users' : account.kind === 'organization' ? 'organizations' : 'enterprises';
    const url = new URL(`https://api.github.com/${segment}/${encodeURIComponent(account.login)}/settings/billing/ai_credit/usage`);
    url.searchParams.set('year', String(range.year)); url.searchParams.set('month', String(range.month));
    try {
      const response = await this.#fetch(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, 'User-Agent': 'PilotMeter' },
      });
      const now = this.#now().getTime();
      if (response.redirected || response.url && new URL(response.url).origin !== 'https://api.github.com') {
        await response.body?.cancel();
        throw new ProviderFailure({ code: 'UPSTREAM_REDIRECT', message: '账单接口重定向已拒绝' });
      }
      if (response.status === 429 || response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0')) {
        entry.failures++; entry.nextAllowedAt = retryDeadline(response, now, entry.failures); await response.body?.cancel();
        return this.#failure(entry, account, period, { code: 'RATE_LIMITED', message: '账单接口限流；已按重试提示延后同步' });
      }
      if (response.status === 403 || response.status === 401) {
        entry.permissionDenied = true; await response.body?.cancel();
        return this.#failure(entry, account, period, { code: response.status === 403 ? 'PERMISSION_DENIED' : 'AUTHENTICATION_FAILED', message: response.status === 403 ? `权限不足；需要 ${BILLING_REQUIREMENTS[account.kind].permission} 和相应账单角色，更新权限后再重试` : '账单认证失败；更新凭据后再重试' });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderFailure({ code: response.status >= 300 && response.status < 400 ? 'UPSTREAM_REDIRECT' : 'UPSTREAM_ERROR', message: '账单接口暂不可用' });
      }
      const report = parseReport(await boundedBody(response));
      const snapshot = mapBillingReport(report, account, period, this.#now());
      entry.nextAllowedAt = now + this.#minIntervalMs;
      if (snapshot.state !== 'known' && snapshot.lastError && entry.snapshot?.state === 'known') return this.#failure(entry, account, period, snapshot.lastError);
      entry.failures = 0; entry.snapshot = snapshot;
      return snapshot;
    } catch (error) {
      entry.failures++;
      entry.nextAllowedAt = this.#now().getTime() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(entry.failures - 1, 5));
      return this.#failure(entry, account, period, error instanceof ProviderFailure ? error.safe : { code: 'FETCH_FAILED', message: '账单请求或解析失败；保留上次成功值' });
    }
  }
}
