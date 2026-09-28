import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicJson, readJson } from '../shared/runtime.js';
import { compareDecimals, nonNegativeDecimal, percentageOf, subtractDecimals } from '../domain/decimal.js';
import { quotaBucketLabel } from '../domain/personal-quota.js';
import type { AccountLogin, AccountsOverview, GitHubProfile, PersonalQuota } from '../shared/accounts.js';
import { CopilotClient, CopilotClientError, copilotHost, type CopilotQuota } from './copilot-client.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
interface StoredProfile extends GitHubProfile { homeId: string }
interface Registry { version: 1; activeAccountId: string | null; profiles: StoredProfile[] }
type Backend = Pick<CopilotClient, 'listAccounts' | 'getQuota' | 'startLogin' | 'getLogin' | 'cancelLogin' | 'close'>;
interface Attempt { view: AccountLogin; client: Backend; providerId: string; homeId: string; expected: StoredProfile | null; finalizing: Promise<void> | null; committing: boolean }
export class AccountError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const profileView = ({ id, login, host, status, createdAt, checkedAt }: StoredProfile): GitHubProfile => ({ id, login, host, status, createdAt, checkedAt });
function quantity(input: unknown): string | null {
  try { return nonNegativeDecimal(typeof input === 'number' && Number.isSafeInteger(input) ? String(input) : input); } catch { return null; }
}
function percent(input: unknown): string | null {
  try {
    const result = nonNegativeDecimal(typeof input === 'number' && Number.isFinite(input) ? String(input) : input);
    return compareDecimals(result, '100') <= 0 ? result : null;
  } catch { return null; }
}
function safeError(error: unknown): { code: string; message: string } {
  return error instanceof CopilotClientError ? { code: error.code, message: error.message }
    : { code: 'ACCOUNT_UNAVAILABLE', message: '账号读取失败，请重试或重新登录。' };
}

/** User quotas are separate from organization/enterprise billing and reconciliation evidence. */
export function personalQuota(accountId: string, result: CopilotQuota): PersonalQuota {
  return {
    accountId, state: result.snapshots.length ? 'available' : 'unavailable', scope: 'signed-in-user',
    fetchedAt: result.fetchedAt, stale: false, error: result.snapshots.length ? null : { code: 'QUOTA_EMPTY', message: 'GitHub 尚未返回该账号的 Copilot 额度，请确认订阅和组织策略。' },
    buckets: result.snapshots.map(snapshot => {
      const unit = snapshot.unit === 'ai-credits' ? 'ai-credits' as const : snapshot.unit === 'premium-requests' ? 'premium-requests' as const : 'unspecified' as const;
      const used = quantity(snapshot.usedRequests); const limit = snapshot.isUnlimitedEntitlement ? null : quantity(snapshot.entitlementRequests);
      const remainingPercentage = snapshot.isUnlimitedEntitlement ? null : percent(snapshot.remainingPercentage);
      const usedPercentage = snapshot.isUnlimitedEntitlement ? null : remainingPercentage !== null ? subtractDecimals('100', remainingPercentage)
        : used !== null && limit !== null ? percentageOf(used, limit, 2) : null;
      return { key: snapshot.type, label: quotaBucketLabel(snapshot.type),
        unit, used, limit, remainingPercentage, usedPercentage, unlimited: snapshot.isUnlimitedEntitlement, resetAt: snapshot.resetDate };
    }),
  };
}

export interface AccountsOptions {
  runCommand?: string;
  clientFactory?: (home: string) => Backend;
  now?: () => number;
  onChange?: () => void;
}

/** Only identities persist here. OAuth material remains in the official CLI's credential storage. */
export class AccountsManager {
  readonly #dir: string;
  readonly #file: string;
  readonly #options: AccountsOptions;
  #registry: Registry = { version: 1, activeAccountId: null, profiles: [] };
  readonly #clients = new Map<string, Backend>();
  readonly #quotas = new Map<string, PersonalQuota>();
  readonly #refreshes = new Map<string, Promise<void>>();
  readonly #nextRefresh = new Map<string, number>();
  #attempt: Attempt | null = null;
  #mutation: Promise<unknown> = Promise.resolve();
  #writes: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(directory: string, options: AccountsOptions = {}) {
    this.#dir = resolve(directory, 'github-accounts'); this.#file = join(this.#dir, 'accounts.json'); this.#options = options;
  }
  #now(): number { return this.#options.now?.() ?? Date.now(); }
  #changed(): void { this.#options.onChange?.(); }
  async initialize(): Promise<void> {
    // An empty installation is read-only until a login is explicitly requested.
    const saved = await readJson<Registry>(this.#file);
    if (!saved) return;
    if (saved.version !== 1 || !Array.isArray(saved.profiles) || saved.profiles.length > 20) throw new Error('Invalid account registry');
    const ids = new Set<string>(); const identities = new Set<string>();
    for (const profile of saved.profiles) {
      if (!profile || !UUID.test(profile.id) || !UUID.test(profile.homeId) || !/^[a-z\d](?:[a-z\d_-]{0,126}[a-z\d])?$/i.test(profile.login)
        || !['connected', 'reauth-required', 'error'].includes(profile.status) || !Number.isFinite(Date.parse(profile.createdAt))
        || profile.checkedAt !== null && !Number.isFinite(Date.parse(profile.checkedAt))) throw new Error('Invalid account registry');
      if (copilotHost(profile.host) !== profile.host || ids.has(profile.id) || identities.has(`${profile.host}/${profile.login.toLowerCase()}`)) throw new Error('Invalid account registry');
      ids.add(profile.id); identities.add(`${profile.host}/${profile.login.toLowerCase()}`);
    }
    if (saved.activeAccountId !== null && !ids.has(saved.activeAccountId)) throw new Error('Invalid selected account');
    this.#registry = { version: 1, activeAccountId: saved.activeAccountId, profiles: saved.profiles.map(p => ({ ...profileView(p), homeId: p.homeId })) };
  }
  active(): GitHubProfile | null { const profile = this.#registry.profiles.find(p => p.id === this.#registry.activeAccountId); return profile ? profileView(profile) : null; }
  #find(id: string): StoredProfile {
    if (!UUID.test(id)) throw new AccountError(400, '账号标识无效。');
    const profile = this.#registry.profiles.find(p => p.id === id);
    if (!profile) throw new AccountError(404, '账号已移除，请刷新账号列表。');
    return profile;
  }
  #home(homeId: string): string { if (!UUID.test(homeId)) throw new Error('Invalid profile directory'); return join(this.#dir, homeId, 'copilot'); }
  #client(profile: StoredProfile): Backend {
    let client = this.#clients.get(profile.id);
    if (!client) { client = this.#newClient(profile.homeId); this.#clients.set(profile.id, client); }
    return client;
  }
  #newClient(homeId: string): Backend { return this.#options.clientFactory?.(this.#home(homeId)) ?? new CopilotClient({ home: this.#home(homeId), cwd: this.#dir }); }
  #persist(registry = this.#registry): Promise<void> {
    const snapshot = structuredClone(registry);
    const write = this.#writes.catch(() => {}).then(async () => { await mkdir(this.#dir, { recursive: true, mode: 0o700 }); await atomicJson(this.#file, snapshot); });
    this.#writes = write; return write;
  }
  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.#mutation.then(() => { if (this.#closed) throw new AccountError(503, '服务正在停止。'); return action(); });
    this.#mutation = pending.catch(() => {}); return pending;
  }
  overview(enabled = true): AccountsOverview {
    const id = this.#registry.activeAccountId; const cached = id ? this.#quotas.get(id) : null;
    return {
      accounts: this.#registry.profiles.map(profileView), activeAccountId: id,
      quota: cached ? structuredClone({ ...cached, stale: cached.stale || !cached.fetchedAt || this.#now() - Date.parse(cached.fetchedAt) > 5 * 60_000 }) : null,
      login: this.#attempt ? structuredClone(this.#attempt.view) : null, refreshing: !!id && this.#refreshes.has(id), enabled,
      runCommand: this.#options.runCommand ?? 'pilotmeter run --',
    };
  }
  async select(id: string | null): Promise<AccountsOverview> {
    return this.#serialize(async () => {
      if (id !== null) this.#find(id);
      const next = { ...this.#registry, activeAccountId: id };
      await this.#persist(next); this.#registry = next; this.#changed();
      if (id) void this.refresh(id).catch(() => {});
      return this.overview();
    });
  }
  async remove(id: string): Promise<AccountsOverview> {
    return this.#serialize(async () => {
      this.#find(id);
      if (this.#attempt?.expected?.id === id && ['starting', 'pending', 'verifying'].includes(this.#attempt.view.status)) await this.#cancel(this.#attempt);
      const next = { ...this.#registry, profiles: this.#registry.profiles.filter(p => p.id !== id),
        activeAccountId: this.#registry.activeAccountId === id ? null : this.#registry.activeAccountId };
      await this.#persist(next); this.#registry = next;
      const client = this.#clients.get(id); this.#clients.delete(id);
      this.#quotas.delete(id); this.#nextRefresh.delete(id);
      await client?.close(); this.#changed(); return this.overview();
    });
  }
  async startLogin(host = 'https://github.com', accountId?: string): Promise<AccountLogin> {
    return this.#serialize(async () => {
      const targetHost = copilotHost(host);
      if (this.#attempt && ['starting', 'pending', 'verifying'].includes(this.#attempt.view.status)) throw new AccountError(409, '请先完成或取消当前登录。');
      const expected = accountId === undefined ? null : this.#find(accountId);
      if (expected && expected.host !== targetHost) throw new AccountError(400, '重新登录必须使用该账号的原 GitHub 主机。');
      if (!expected && this.#registry.profiles.length >= 20) throw new AccountError(409, '最多保存 20 个账号，请先移除不再使用的账号。');
      const homeId = randomUUID(); const client = this.#newClient(homeId);
      let started;
      try { await mkdir(this.#dir, { recursive: true, mode: 0o700 }); started = await client.startLogin(targetHost); }
      catch (error) { await client.close(); throw error; }
      const view: AccountLogin = { ...started, accountId: null };
      this.#attempt = { view, client, providerId: started.id, homeId, expected, finalizing: null, committing: false };
      this.#changed(); return structuredClone(view);
    });
  }
  async loginStatus(id: string): Promise<AccountLogin> {
    const attempt = this.#attempt;
    if (!attempt || attempt.view.id !== id) throw new AccountError(404, '登录已结束或不存在，请重新开始。');
    const state = attempt.client.getLogin(attempt.providerId);
    if (state && ['starting', 'pending'].includes(attempt.view.status)) {
      if (state.status === 'complete') {
        attempt.view = { ...attempt.view, status: 'verifying', userCode: null, verificationUri: null };
        attempt.finalizing = this.#serialize(() => this.#finishLogin(attempt)).catch(() => {
          if (attempt.view.status !== 'verifying' || this.#attempt !== attempt || this.#closed) return;
          attempt.view = { ...attempt.view, status: 'failed', error: { code: 'LOGIN_VERIFY_FAILED', message: '无法确认登录结果，请重新登录。' } };
        });
      } else attempt.view = { ...state, accountId: null };
    }
    return structuredClone(attempt.view);
  }
  async #finishLogin(attempt: Attempt): Promise<void> {
    try {
      const accounts = await attempt.client.listAccounts();
      const current = accounts.filter(a => a.isCurrent && a.host === attempt.view.host);
      if (current.length !== 1) throw new CopilotClientError('LOGIN_IDENTITY_UNKNOWN', '登录后无法唯一确认当前 GitHub 身份，请重试。');
      const account = current[0]!;
      if (attempt.expected && (attempt.expected.login.toLowerCase() !== account.login.toLowerCase() || attempt.expected.host !== account.host)) {
        throw new CopilotClientError('LOGIN_IDENTITY_MISMATCH', `登录的账号与需要重新授权的账号不一致，请在 GitHub 授权页选择正确账号。`);
      }
      if (attempt.view.status !== 'verifying' || this.#attempt !== attempt || this.#closed) return;
      const existing = this.#registry.profiles.find(p => p.host === account.host && p.login.toLowerCase() === account.login.toLowerCase());
      const date = new Date(this.#now()).toISOString();
      const profile: StoredProfile = { id: existing?.id ?? randomUUID(), homeId: attempt.homeId, host: account.host, login: account.login,
        createdAt: existing?.createdAt ?? date, checkedAt: date, status: 'connected' };
      const oldClient = this.#clients.get(profile.id);
      const next: Registry = { ...this.#registry, profiles: [...this.#registry.profiles.filter(p => p.id !== profile.id), profile], activeAccountId: profile.id };
      attempt.committing = true;
      await this.#persist(next);
      this.#registry = next;
      this.#clients.set(profile.id, attempt.client); this.#quotas.delete(profile.id); this.#nextRefresh.delete(profile.id);
      attempt.view = { ...attempt.view, status: 'complete', accountId: profile.id, error: null };
      if (oldClient && oldClient !== attempt.client) await oldClient.close().catch(() => {});
      this.#changed(); void this.refresh(profile.id).catch(() => {});
    } catch (error) {
      if (attempt.view.status === 'cancelled' || this.#attempt !== attempt || this.#closed) return;
      attempt.view = { ...attempt.view, status: 'failed', error: safeError(error), userCode: null, verificationUri: null };
      await attempt.client.close(); this.#changed();
    } finally { attempt.committing = false; }
  }
  async #cancel(attempt: Attempt): Promise<void> {
    // The identity is already verified; finish the atomic registry commit before reporting its outcome.
    if (attempt.committing) { await attempt.finalizing; return; }
    if (!['starting', 'pending', 'verifying'].includes(attempt.view.status)) return;
    attempt.client.cancelLogin(attempt.providerId);
    attempt.view = { ...attempt.view, status: 'cancelled', userCode: null, verificationUri: null };
    await attempt.client.close(); this.#changed();
  }
  async cancelLogin(id: string): Promise<AccountLogin> {
    const attempt = this.#attempt;
    if (!attempt || attempt.view.id !== id) throw new AccountError(404, '登录不存在。');
    await this.#cancel(attempt); return structuredClone(attempt.view);
  }
  async refresh(id = this.#registry.activeAccountId): Promise<void> {
    if (!id || this.#closed) return;
    const profile = this.#find(id); const pending = this.#refreshes.get(id); if (pending) return pending;
    if (this.#now() < (this.#nextRefresh.get(id) ?? 0)) return;
    this.#nextRefresh.set(id, this.#now() + 60_000);
    const client = this.#client(profile);
    const task = (async () => {
      let quota: PersonalQuota; let status: GitHubProfile['status']; let checkedAt = profile.checkedAt;
      try {
        const accounts = await client.listAccounts();
        const matches = accounts.filter(a => a.host === profile.host && a.login.toLowerCase() === profile.login.toLowerCase());
        if (matches.length !== 1) throw new CopilotClientError('AUTH_REQUIRED', '该账号的授权已失效，请重新登录。');
        const data = await client.getQuota(matches[0]!.selectionId);
        status = 'connected'; checkedAt = new Date(this.#now()).toISOString(); quota = personalQuota(id, data);
      } catch (error) {
        const safe = safeError(error); const old = this.#quotas.get(id);
        status = ['AUTH_REQUIRED', 'AUTHENTICATION_FAILED', 'ACCOUNT_NOT_FOUND'].includes(safe.code) ? 'reauth-required' : 'error';
        quota = { accountId: id, scope: 'signed-in-user', state: 'error', fetchedAt: old?.fetchedAt ?? null, stale: true, buckets: old?.buckets ?? [], error: safe };
      }
      if (this.#closed) return;
      await this.#serialize(async () => {
        if (!this.#registry.profiles.includes(profile) || this.#closed) return;
        const updated = { ...profile, status, checkedAt };
        await this.#persist({ ...this.#registry, profiles: this.#registry.profiles.map(p => p === profile ? updated : p) });
        Object.assign(profile, updated); this.#quotas.set(id, quota); this.#changed();
      });
    })().finally(() => { this.#refreshes.delete(id); });
    this.#refreshes.set(id, task); return task;
  }
  /** Capture this immutable launch profile once; later UI switches cannot relabel a live collector. */
  async runProfile(id = this.#registry.activeAccountId): Promise<{ profile: GitHubProfile; home: string } | null> {
    if (!id) return null;
    const profile = this.#find(id); const accounts = await this.#client(profile).listAccounts();
    if (!this.#registry.profiles.includes(profile)) throw new AccountError(409, '账号已移除或更新，请重新选择账号。');
    const current = accounts.filter(a => a.isCurrent);
    if (current.length !== 1 || current[0]!.host !== profile.host || current[0]!.login.toLowerCase() !== profile.login.toLowerCase()) {
      await this.#serialize(async () => {
        if (!this.#registry.profiles.includes(profile)) return;
        await this.#persist({ ...this.#registry, profiles: this.#registry.profiles.map(p => p === profile ? { ...p, status: 'reauth-required' } : p) });
        profile.status = 'reauth-required'; this.#changed();
      });
      throw new AccountError(409, '该账号的登录状态已改变，请重新登录后启动采集。');
    }
    return { profile: profileView(profile), home: this.#home(profile.homeId) };
  }
  async close(): Promise<void> {
    this.#closed = true;
    const clients = new Set(this.#clients.values()); if (this.#attempt) clients.add(this.#attempt.client);
    await Promise.allSettled([...clients].map(client => client.close()));
    await Promise.allSettled([...this.#refreshes.values(), this.#mutation, this.#writes]);
  }
}
