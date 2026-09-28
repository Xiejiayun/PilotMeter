import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, rm } from 'node:fs/promises';
import { Repository } from '../storage/repository.js';
import { parseOtlp } from '../collectors/otlp.js';
import { importJsonl } from '../collectors/jsonl.js';
import { APP, VERSION, prepareDirectory, atomicJson, month, readJson, sourceContextId } from '../shared/runtime.js';
import { acquireLock } from './lock.js';
import type { Instance } from './client.js';
import type { Settings, Summary, UsageSnapshot } from '../shared/types.js';
import { buildDisplay, officialSnapshotEligible } from '../domain/display.js';
import { BillingProvider, billingEntity } from '../providers/billing.js';
import { RefreshScheduler } from '../providers/scheduler.js';
import { adaptQuota, type QuotaData, type QuotaEvidence } from '../providers/quota.js';
import { seedDemo } from './demo.js';
import { inspectReconciliation, reconciliationReport, verifyReconciliationEvidence } from '../domain/reconciliation-evidence.js';
import { AccountsManager, AccountError, type AccountsOptions } from '../providers/accounts.js';
import { CopilotClientError } from '../providers/copilot-client.js';
import { buildWidget } from '../domain/widget.js';
import { projectPersonalQuota } from '../domain/personal-quota.js';
import type { WidgetResponse } from '../shared/widget.js';

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const defaultSettings: Settings = { monthlyBudget: null, unitVerification: null, account: null, retentionDays: null, demo: false };
function equal(a: string | undefined, b: string): boolean { return !!a && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Only application/json is supported.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Compressed payloads are not supported.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Request exceeds 2 MiB.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function json(res: ServerResponse, status: number, data: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
export async function serve(dir: string, demo = false, options: { accounts?: Pick<AccountsOptions, 'clientFactory' | 'now'> } = {}): Promise<void> {
  await prepareDirectory(dir);
  const release = await acquireLock(dir);
  let repo: Repository;
  try { repo = new Repository(join(dir, 'usage.db')); } catch (error) { await release(); throw error; }
  const instance: Instance = { app: APP, version: VERSION, pid: process.pid, instanceId: randomUUID(), url: '', managementToken: randomBytes(32).toString('hex'), collectorToken: randomBytes(32).toString('hex') };
  const csrf = randomBytes(32).toString('hex');
  const savedSettings = repo.getSetting<Settings>('settings');
  if (demo && savedSettings?.demo !== true && (savedSettings || repo.hasUsageEvents())) {
    repo.close(); await release(); throw new Error('Demo requires a separate unused directory; refusing to modify real data.');
  }
  let settings: Settings = { ...defaultSettings, ...savedSettings, demo: demo || savedSettings?.demo === true };
  if (settings.demo) settings = seedDemo(repo, settings);
  instance.demo = settings.demo;
  const billing = new BillingProvider();
  const scheduler = new RefreshScheduler();
  let lastActivity = Date.now();
  let refreshPending: Promise<unknown> | null = null;
  if (settings.account) {
    const saved = repo.getSnapshot(month(), { entity: billingEntity(settings.account), source: 'billing-rest' });
    if (saved) billing.restoreSnapshot(saved);
  }
  const source = `unverified:${sourceContextId()}`;
  const collectorContexts = new Map<string, string>([[instance.collectorToken, source]]);
  const shellQuote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
  const entry = fileURLToPath(new URL('../../bin/pilotmeter.js', import.meta.url));
  const invocation = process.env.PILOTMETER_LAUNCHER_PATH ? shellQuote(process.env.PILOTMETER_LAUNCHER_PATH) : `${shellQuote(process.execPath)} ${shellQuote(entry)}`;
  const accounts = new AccountsManager(dir, { ...options.accounts, runCommand: `${process.platform === 'win32' ? '& ' : ''}${invocation} --data-dir ${shellQuote(dir)} run --`, onChange: () => { void updateCache().catch(() => {}); } });
  try { await accounts.initialize(); } catch (error) { repo.close(); await release(); throw error; }
  const scope = () => { const active = accounts.active(); return active ? { sourceContextPrefix: `profile:${active.id}:` } : undefined; };
  function scopedSettings(): Settings {
    const active = accounts.active();
    return active ? { ...settings, account: null, monthlyBudget: repo.getSetting<string>(`github-budget:${active.id}`) } : settings;
  }
  function accountSnapshot(period: string): UsageSnapshot | null {
    // Legacy billing bindings were never verified against a signed-in profile.
    if (accounts.active()) return null;
    const entity = settings.account ? billingEntity(settings.account) : null;
    const quota = entity ? repo.getSnapshot(period, { entity, source: 'sdk-quota' }) : null;
    let account = entity ? (officialSnapshotEligible(quota, period, entity) ? quota : repo.getSnapshot(period, { entity, source: 'billing-rest' }) || quota) : null;
    if (account) account = { ...account, stale: account.stale || Date.now() - Date.parse(account.fetchedAt) > 15 * 60_000 };
    return account;
  }
  function reconciliation(period: string) {
    const account = accountSnapshot(period);
    const basis = repo.reconciliationBasis(period, account?.providerUpdatedAt ?? null, settings.unitVerification, scope());
    return { account, basis, report: reconciliationReport(basis, account, repo.getSetting(`reconciliation:${period}`)) };
  }
  function summary(period = month()): Summary {
    const local = repo.summary(period, settings.unitVerification, scope());
    const { account, report } = reconciliation(period);
    const retention = { days: settings.retentionDays, ...repo.getRetentionStatus() };
    const display = buildDisplay(local, account, scopedSettings());
    if (retention.prunedSpans > 0 && display.mode !== 'official') {
      display.scope = '本机仍保留的会话记录';
      display.reason = `${display.reason ? `${display.reason}；` : ''}部分历史明细已清理，当前小计不代表清理前的完整用量`;
    }
    const active = accounts.active();
    if (active && display.mode !== 'official') display.scope = `${active.login} · 通过 PilotMeter 启动的本机会话`;
    return { period, local, account, display, retention, reconciliation: report, updatedAt: new Date().toISOString(), demo: settings.demo,
      githubAccount: active ? { id: active.id, login: active.login, host: active.host } : null };
  }
  let cacheChain = Promise.resolve();
  function updateCache(): Promise<void> { const snapshot = summary(); cacheChain = cacheChain.catch(() => {}).then(() => atomicJson(join(dir, 'status.json'), snapshot)); return cacheChain; }
  async function refresh(manual = false): Promise<unknown> {
    const selected = settings.account;
    if (!selected) return { state: 'not-connected' };
    const period = month();
    const result = await scheduler.refresh(() => billing.fetchSnapshot(selected, period, process.env.PILOTMETER_GITHUB_TOKEN || ''), { manual, idle: Date.now() - lastActivity > 15 * 60_000, retryAt: () => billing.nextRetryAt(selected, period) });
    if (result) { repo.saveSnapshot(result); await updateCache(); }
    return result || { state: 'throttled', nextRefreshAt: scheduler.nextRefreshAt };
  }
  function trackedRefresh(manual = false): Promise<unknown> {
    if (refreshPending) return refreshPending;
    const pending = refresh(manual).finally(() => { refreshPending = null; });
    refreshPending = pending; return pending;
  }
  let closing = false;
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) throw new HttpError(503, 'Service is stopping.');
      if (req.headers.host !== new URL(instance.url).host) throw new HttpError(403, 'Invalid Host.');
      if (req.headers.origin && req.headers.origin !== instance.url) throw new HttpError(403, 'Cross-origin access is forbidden.');
      if (req.headers['x-pilotmeter-instance'] !== undefined && !equal(req.headers['x-pilotmeter-instance'] as string, instance.instanceId)) throw new HttpError(409, '本机服务已更换，请重新连接。');
      const url = new URL(req.url || '/', instance.url);
      const route = url.pathname;
      const requestProfile = accounts.active();
      if ((route === '/api/summary' || route === '/api/sessions' || route.startsWith('/api/sessions/') || route === '/api/settings') && url.searchParams.has('accountId')
        && url.searchParams.get('accountId') !== (accounts.active()?.id ?? '')) throw new HttpError(409, '当前账号已在另一窗口切换，请刷新后重试。');
      const management = equal(req.headers.authorization, `Bearer ${instance.managementToken}`);
      const presentedToken = (req.headers['x-pilotmeter-token'] as string | undefined) || req.headers.authorization?.replace(/^Bearer /, '');
      const collectorSource = typeof presentedToken === 'string' ? collectorContexts.get(presentedToken) : undefined;
      if (route.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site API access is forbidden.');
      if (route.startsWith('/v1/')) {
        if (req.method !== 'POST') throw new HttpError(405, 'POST required.');
        if (!collectorSource) throw new HttpError(401, 'Collector authentication required.');
        if (settings.demo) throw new HttpError(409, 'Demo data is isolated; use a normal data directory for live collection.');
        const payload = await body(req);
        if (route === '/v1/traces') {
          let spans;
          try { spans = parseOtlp(payload, collectorSource); } catch { throw new HttpError(400, 'Invalid OTLP trace structure.'); }
          const result = repo.ingest(spans);
          lastActivity = Date.now();
          await updateCache();
          json(res, 200, result.rejected || result.conflicts ? { partialSuccess: { rejectedSpans: String(result.rejected + result.conflicts), errorMessage: 'Some spans were invalid or conflicted; see local diagnostics.' } } : {});
          return;
        }
        const field = route === '/v1/metrics' ? 'resourceMetrics' : route === '/v1/logs' ? 'resourceLogs' : null;
        if (!field) throw new HttpError(404, 'Unknown signal.');
        if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>)[field])) throw new HttpError(400, 'Invalid OTLP signal.');
        json(res, 200, {}); return; // Accepted and discarded: only traces feed the usage ledger.
      }
      if (req.method === 'GET' && route === '/health') { json(res, 200, { app: APP, version: VERSION, instanceId: instance.instanceId }); return; }
      if (req.method === 'GET' && route === '/api/session') { json(res, 200, { csrfToken: csrf }); return; }
      if (route.startsWith('/api/') && req.method !== 'GET' && !management && !(req.headers.origin === instance.url && equal(req.headers['x-pilotmeter-csrf'] as string | undefined, csrf))) throw new HttpError(403, 'Mutation requires local authorization.');
      if (route.startsWith('/api/auth/')) {
        if (route === '/api/auth/accounts' && req.method === 'GET') { json(res, 200, accounts.overview(!settings.demo)); return; }
        if (settings.demo) throw new HttpError(409, '演示模式不能登录真实账号，请打开普通仪表盘。');
        if (route === '/api/auth/login' && req.method === 'POST') {
          const input = await body(req) as { host?: unknown; accountId?: unknown };
          if (!input || typeof input !== 'object' || Array.isArray(input) || input.host !== undefined && typeof input.host !== 'string' || input.accountId !== undefined && typeof input.accountId !== 'string') throw new HttpError(400, '登录参数无效。');
          json(res, 200, await accounts.startLogin(input.host as string | undefined, input.accountId as string | undefined)); return;
        }
        const loginRoute = /^\/api\/auth\/login\/([a-f0-9-]+)(\/cancel)?$/.exec(route);
        if (loginRoute && req.method === (loginRoute[2] ? 'POST' : 'GET')) {
          json(res, 200, loginRoute[2] ? await accounts.cancelLogin(loginRoute[1]!) : await accounts.loginStatus(loginRoute[1]!)); return;
        }
        if (route === '/api/auth/select' && req.method === 'POST') {
          const input = await body(req) as { accountId?: unknown };
          if (!input || input.accountId !== null && typeof input.accountId !== 'string') throw new HttpError(400, '请选择有效账号。');
          const result = await accounts.select(input.accountId as string | null); await updateCache(); json(res, 200, result); return;
        }
        const accountRoute = /^\/api\/auth\/accounts\/([a-f0-9-]+)$/.exec(route);
        if (accountRoute && req.method === 'DELETE') { const result = await accounts.remove(accountRoute[1]!); await updateCache(); json(res, 200, result); return; }
        if (route === '/api/auth/refresh' && req.method === 'POST') {
          // Start the bounded request without tying browser response latency to upstream RPC latency.
          void accounts.refresh().catch(() => {}); json(res, 200, accounts.overview()); return;
        }
        if (route === '/api/auth/run-context' && req.method === 'POST') {
          if (!management) throw new HttpError(403, '采集启动必须通过本机 CLI。');
          const input = await body(req) as { accountId?: unknown; sourceLabel?: unknown };
          if (!input || typeof input !== 'object' || Array.isArray(input) || input.accountId !== undefined && typeof input.accountId !== 'string' || input.sourceLabel !== undefined && (typeof input.sourceLabel !== 'string' || input.sourceLabel.length > 200)) throw new HttpError(400, '采集账号参数无效。');
          const selected = await accounts.runProfile(input.accountId as string | undefined);
          if (!selected) { json(res, 200, { profile: null }); return; }
          const context = `profile:${selected.profile.id}:${sourceContextId(input.sourceLabel as string | undefined, selected.home)}`;
          if (collectorContexts.size >= 1024) throw new HttpError(429, '采集上下文过多，请重启服务。');
          const token = randomBytes(32).toString('hex'); collectorContexts.set(token, context);
          json(res, 200, { ...selected, collectorToken: token }); return;
        }
        throw new HttpError(404, '账号接口不存在。');
      }
      if (req.method === 'GET' && route === '/api/summary') { json(res, 200, summary(month(url.searchParams.get('period') || undefined))); return; }
      if (req.method === 'GET' && route === '/api/desktop') {
        const overview = accounts.overview(!settings.demo);
        const profile = overview.accounts.find(item => item.id === overview.activeAccountId);
        const quota = profile && profile.status !== 'reauth-required' && overview.quota?.accountId === profile.id ? overview.quota : null;
        json(res, 200, { app: APP, version: VERSION, instanceId: instance.instanceId,
          accounts: overview.accounts, activeAccountId: overview.activeAccountId, login: overview.login,
          enabled: overview.enabled, refreshing: overview.refreshing,
          quota: quota ? { accountId: quota.accountId, state: quota.state, fetchedAt: quota.fetchedAt, stale: quota.stale, error: quota.error } : null,
          presentation: projectPersonalQuota(quota, Date.now(), url.searchParams.get('quotaKey')) });
        return;
      }
      if (req.method === 'GET' && route === '/api/widget') {
        const widget: WidgetResponse = { app: APP, version: VERSION, instanceId: instance.instanceId,
          ...buildWidget(summary(), accounts.overview(!settings.demo)) };
        json(res, 200, widget); return;
      }
      if (req.method === 'GET' && route === '/api/sessions') { json(res, 200, { ...repo.sessions(month(url.searchParams.get('period') || undefined), { cursor: url.searchParams.get('cursor') || undefined, sort: url.searchParams.get('sort') || 'usage', limit: 50, scope: scope() }), accountId: accounts.active()?.id ?? null }); return; }
      if (req.method === 'GET' && route.startsWith('/api/sessions/')) { const result = repo.session(decodeURIComponent(route.slice(14)), settings.unitVerification, scope()); if (!result) throw new HttpError(404, 'Session not found.'); json(res, 200, { ...result, accountId: accounts.active()?.id ?? null }); return; }
      if (req.method === 'GET' && route === '/api/settings') { json(res, 200, scopedSettings()); return; }
      if (req.method === 'GET' && route === '/api/reconciliation') {
        json(res, 200, reconciliation(month(url.searchParams.get('period') || undefined)).report); return;
      }
      if (req.method === 'GET' && route === '/api/reconciliation/inspect') {
        if (!management) throw new HttpError(403, 'Reconciliation inspection requires CLI authentication.');
        const { basis, account } = reconciliation(month(url.searchParams.get('period') || undefined));
        json(res, 200, inspectReconciliation(basis, account)); return;
      }
      if (route === '/api/reconciliation' && (req.method === 'POST' || req.method === 'DELETE')) {
        if (!management) throw new HttpError(403, 'Reconciliation evidence changes require CLI authentication.');
        if (settings.demo) throw new HttpError(409, 'Demo cannot verify real reconciliation evidence.');
        if (req.method === 'DELETE') {
          const period = month(url.searchParams.get('period') || undefined);
          repo.setSetting(`reconciliation:${period}`, null);
          await updateCache(); json(res, 200, reconciliation(period).report); return;
        }
        const input = await body(req) as { period?: unknown } | null;
        if (!input || typeof input !== 'object' || typeof input.period !== 'string') throw new HttpError(400, 'Expected a reconciliation evidence file with a UTC period.');
        const period = month(input.period);
        const { basis, account } = reconciliation(period);
        const result = verifyReconciliationEvidence(input, basis, account);
        if (!result.accepted) { json(res, 422, { error: result.report.reason, report: result.report }); return; }
        repo.setSetting(`reconciliation:${period}`, result.evidence);
        await updateCache(); json(res, 200, result.report); return;
      }
      if (req.method === 'POST' && route === '/api/collector-context') {
        if (!management) throw new HttpError(403, 'Collector registration requires CLI authentication.');
        if (settings.demo) throw new HttpError(409, 'Demo data is isolated; use a normal data directory for live collection.');
        const input = await body(req) as { contextId?: string };
        if (typeof input?.contextId !== 'string' || !/^[a-f0-9]{64}$/.test(input.contextId)) throw new HttpError(400, 'Invalid collection context.');
        const context = `unverified:${input.contextId}`;
        let token = [...collectorContexts].find(([, value]) => value === context)?.[0];
        if (!token) { if (collectorContexts.size >= 1024) throw new HttpError(429, 'Too many collector contexts; restart the local service.'); token = randomBytes(32).toString('hex'); collectorContexts.set(token, context); }
        json(res, 200, { collectorToken: token, identity: 'unverified' }); return;
      }
      if (req.method === 'POST' && route === '/api/refresh') { json(res, 200, await trackedRefresh(true)); return; }
      if (route === '/api/account' && req.method === 'POST') {
        if (!management) throw new HttpError(403, 'Account binding requires CLI authentication.');
        if (settings.demo) throw new HttpError(409, 'Demo cannot connect to a real account.');
        const input = await body(req) as { account?: Settings['account'] };
        const account = input?.account;
        if (account !== null) {
          if (!account || typeof account !== 'object') throw new HttpError(400, 'Account identity required.');
          try { billingEntity(account); } catch { throw new HttpError(400, 'Invalid billing identity.'); }
          if (account.kind === 'user' && account.directBilling !== true) throw new HttpError(400, 'Confirm personal direct billing explicitly; company-paid users need organization or enterprise billing.');
        }
        if (refreshPending) await refreshPending;
        settings.account = account === null ? null : { kind: account.kind, login: account.login.toLowerCase(), ...(account.kind === 'user' ? { directBilling: true } : {}) };
        repo.setSetting('settings', settings); scheduler.resume();
        if (settings.account) billing.resume(settings.account, month());
        await updateCache();
        json(res, 200, { account: settings.account, credentialPresent: !!process.env.PILOTMETER_GITHUB_TOKEN }); return;
      }
      if (req.method === 'POST' && route === '/api/unit-verification') {
        if (!management) throw new HttpError(403, 'Unit verification requires CLI authentication.');
        const input = await body(req) as { cliVersion?: unknown; evidence?: unknown; clear?: unknown };
        if (input?.clear === true) settings.unitVerification = null;
        else {
          if (input?.cliVersion !== '1.0.88' || typeof input.evidence !== 'string' || input.evidence.trim().length < 10 || input.evidence.length > 2000 || /[\u0000-\u001f]/.test(input.evidence)) throw new HttpError(400, 'Provide supported CLI version and a description of the actual /usage comparison.');
          settings.unitVerification = { cliVersion: input.cliVersion, evidence: input.evidence, verifiedAt: new Date().toISOString() };
        }
        repo.setSetting('settings', settings); await updateCache(); json(res, 200, settings.unitVerification); return;
      }
      if (req.method === 'POST' && route === '/api/quota-import') {
        if (!management) throw new HttpError(403, 'Quota evidence import requires CLI authentication.');
        if (!settings.account) throw new HttpError(400, 'Connect an explicit billing entity first.');
        const input = await body(req) as { raw: QuotaData; evidence: QuotaEvidence; period?: string };
        if (!input || typeof input !== 'object' || !input.raw) throw new HttpError(400, 'Expected quota data and evidence.');
        if (input.period !== undefined && typeof input.period !== 'string') throw new HttpError(400, 'period must be YYYY-MM (UTC)');
        const result = adaptQuota(input.raw, input.evidence, settings.account, month(input.period));
        repo.saveSnapshot(result.snapshot); await updateCache(); json(res, 200, result); return;
      }
      if (req.method === 'PATCH' && route === '/api/settings') {
        const patch = await body(req) as Record<string, unknown>;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Expected settings object.');
        if (Object.keys(patch).some(key => !['monthlyBudget', 'retentionDays'].includes(key))) throw new HttpError(400, 'Unknown settings field.');
        if ('monthlyBudget' in patch && patch.monthlyBudget !== null && (typeof patch.monthlyBudget !== 'string' || !/^\d{1,18}(\.\d{1,9})?$/.test(patch.monthlyBudget))) throw new HttpError(400, 'Budget must be a nonnegative decimal string.');
        if ('retentionDays' in patch) {
          if (!management) throw new HttpError(403, 'Retention changes require explicit CLI authentication.');
          if (settings.demo) throw new HttpError(409, 'Retention is not configurable for synthetic demo data.');
          if (patch.retentionDays !== null && (typeof patch.retentionDays !== 'number' || !Number.isSafeInteger(patch.retentionDays) || patch.retentionDays < 1 || patch.retentionDays > 36500)) throw new HttpError(400, 'Retention days must be an integer from 1 to 36500, or null to disable future cleanup.');
        }
        if (requestProfile?.id !== accounts.active()?.id) throw new HttpError(409, '当前账号已切换，请刷新后重试。');
        const globalPatch = { ...patch };
        if (requestProfile && 'monthlyBudget' in patch) {
          repo.setSetting(`github-budget:${requestProfile.id}`, patch.monthlyBudget);
          delete globalPatch.monthlyBudget;
        }
        const nextSettings = { ...settings, ...globalPatch } as Settings;
        if ('retentionDays' in patch) repo.saveSettingsWithRetention(nextSettings);
        else repo.setSetting('settings', nextSettings);
        settings = nextSettings;
        await updateCache(); json(res, 200, scopedSettings()); return;
      }
      if (req.method === 'GET' && route === '/api/diagnostics') { json(res, 200, { items: repo.diagnostics(), collection: 'Traces only; metrics and logs are acknowledged without storage.' }); return; }
      if (req.method === 'POST' && route === '/api/import') {
        if (!management) throw new HttpError(403, 'Import requires CLI authentication.');
        if (settings.demo) throw new HttpError(409, 'Demo cannot import real telemetry.');
        const input = await body(req) as { path?: unknown; collectorToken?: unknown };
        if (typeof input?.path !== 'string') throw new HttpError(400, 'File path required.');
        const context = input.collectorToken === undefined ? source : typeof input.collectorToken === 'string' ? collectorContexts.get(input.collectorToken) : undefined;
        if (!context) throw new HttpError(400, 'Unknown import source context.');
        const result = await importJsonl(repo, input.path, context); await updateCache(); json(res, 200, result); return;
      }
      if (req.method === 'POST' && route === '/api/shutdown') {
        if (!management) throw new HttpError(403, 'Shutdown requires CLI authentication.');
        json(res, 200, { stopping: true }); setImmediate(() => { void shutdown(); }); return;
      }
      if (req.method === 'GET' && !route.startsWith('/api/')) {
        if (route !== '/' && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(route)) throw new HttpError(404, 'Not found.');
        const path = fileURLToPath(new URL(`../../public${route === '/' ? '/index.html' : route}`, import.meta.url));
        try {
          const bytes = await readFile(path);
          res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' } as Record<string, string>)[extname(path)] || 'application/octet-stream' }); res.end(bytes);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (route !== '/') throw new HttpError(404, 'Not found.');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PilotMeter</title><h1>PilotMeter</h1><p>本地采集服务已运行。使用 pilotmeter status 查看用量。</p></html>');
        }
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      const status = error instanceof HttpError || error instanceof AccountError ? error.status : error instanceof CopilotClientError ? error.code === 'HOST_INVALID' ? 400 : 503 : error instanceof RangeError || /period must|cursor|YYYY-MM/i.test((error as Error).message) ? 400 : 500;
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Local operation failed; refresh status to confirm any changes before retrying.' : (error as Error).message }); else res.end();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  async function shutdown(): Promise<void> {
    if (closing) return; closing = true;
    clearInterval(refreshTimer); clearInterval(loginTimer);
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
      server.close(() => { clearTimeout(deadline); resolve(); }); server.closeIdleConnections();
    });
    await accounts.close(); await refreshPending?.catch(() => {}); await cacheChain.catch(() => {}); repo.close();
    if ((await readJson<Instance>(join(dir, 'instance.json')))?.instanceId === instance.instanceId) await rm(join(dir, 'instance.json'), { force: true });
    await release();
  }
  const refreshTimer = setInterval(() => {
    if (!closing) {
      try { repo.applyRetention(settings.retentionDays); }
      catch { console.error('PilotMeter: retention cleanup failed; the cleanup transaction was not applied.'); }
      try { repo.refreshPendingClassifications(); }
      catch { console.error('PilotMeter: pending classification maintenance failed; its transaction was not applied.'); }
      void updateCache().catch(() => {}); void trackedRefresh().catch(() => {});
      if (!settings.demo) void accounts.refresh().catch(() => {});
    }
  }, 60_000); refreshTimer.unref();
  const loginTimer = setInterval(() => {
    const login = accounts.overview().login;
    if (!closing && login && ['starting', 'pending', 'verifying'].includes(login.status)) void accounts.loginStatus(login.id).catch(() => {});
  }, 1000); loginTimer.unref();
  try {
    repo.applyRetention(settings.retentionDays);
    repo.refreshPendingClassifications();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    instance.url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    await updateCache(); await atomicJson(join(dir, 'instance.json'), instance);
    void trackedRefresh().catch(() => {});
    if (!settings.demo) void accounts.refresh().catch(() => {});
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) { clearInterval(refreshTimer); clearInterval(loginTimer); await accounts.close(); server.close(); repo.close(); await release(); throw error; }
}
