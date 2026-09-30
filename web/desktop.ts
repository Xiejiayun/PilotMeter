import './desktop.css';
import type { AccountLogin, GitHubProfile } from '../src/shared/accounts';
import type { DesktopRecord, DesktopRecordsResponse, DesktopResponse } from '../src/shared/desktop';
import type { AccountModel } from '../src/shared/models';
import type { PersonalQuotaBucketView } from '../src/domain/personal-quota';
import { amount, element, emptyState, errorMessage, escape, hostName, hydrateIcons, icon, timestamp } from './desktop-ui';
import { initializeDesktopLogin } from './desktop-login';
import { designDemo } from './desktop-demo';
import { pets } from './desktop-pets';
import { renderAnimatedContent } from './desktop-motion';

type Page = 'overview' | 'models' | 'records' | 'accounts';
type ServiceState = { type: 'service-state'; connected: boolean; recoverable: boolean; recovering: boolean; epoch: number; instanceId?: string; version?: string; message?: string; accountId?: string | null; quotaKey?: string | null; sessionLaunchAvailable?: boolean };
type PetState = { type: 'pet-state'; petId: string; sizePixels: number; motionEnabled: boolean; alwaysOnTop: boolean; persistenceWarning?: string };
type MutationAck = { type: 'account-mutation-state'; pending: boolean; operationId: string; epoch: number };
type SessionStartResult = { type: 'session-start-result'; requestId: string; epoch: number; status: 'started' | 'cancelled' | 'error'; message?: string };
type SessionExit = { type: 'session-exit'; accountId: string; epoch: number; exitCode: number; normal?: boolean; message?: string };
type PetNoticeReason = 'sync-complete' | 'sync-failed' | 'login-complete' | 'login-failed' | 'login-expired' | 'account-changed';
type HostBridge = { postMessage: (message: object) => void; addEventListener: (type: 'message', listener: (event: { data: ServiceState | PetState | MutationAck | SessionStartResult | SessionExit | { type: 'error' | 'host-error'; message?: string } }) => void) => void };
const bridge = (window as unknown as { chrome?: { webview?: HostBridge } }).chrome?.webview;
const demo = new URLSearchParams(location.search).get('demo') === '1' || document.documentElement.dataset.designPreview === 'true';
const demoData = demo ? designDemo() : null;
const pages: Record<Page, { title: string; description: string }> = {
  overview: { title: '用量总览', description: '当前账号的额度、可用模型与本机记录。' },
  models: { title: '可用模型', description: '查看当前账号的模型权限、能力与计费倍率。' },
  records: { title: '用量记录', description: '回顾这台电脑上通过 PilotMeter 采集的会话。' },
  accounts: { title: '账户管理', description: '连接你的 GitHub 账号，给桌面选一个伙伴。' },
};
let page: Page = 'overview';
let desktop: DesktopResponse | null = null;
let records: DesktopRecordsResponse | null = null;
let recentRecords: DesktopRecordsResponse | null = null;
let viewGeneration = 0;
let recordsGeneration = 0;
let recentGeneration = 0;
let recordsLoading = false;
let recentLoading = false;
let recordPages = 1;
let recordFailure = '';
let recentFailure = '';
let service: ServiceState | null = null;
let browserIdentity: { instanceId: string; version: string } | null = null;
let petState: PetState | null = demo ? { type: 'pet-state', petId: '01', sizePixels: 96, motionEnabled: true, alwaysOnTop: true } : null;
let modelFilter = 'all';
let modelSearch = '';
let quotaKey: string | null = null;
let loading = false;
let mutationOwner: string | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
let mutationAck: { id: string; epoch: number; resolve: () => void; reject: (error: Error) => void; timer: number } | null = null;
let refreshTimer: number | undefined;
let refreshRequested: { accountId: string | null; eventId: string; epoch: number } | null = null;
let refreshPending: object | null = null;
let syncReadFailed = false;
let removeProfile: GitHubProfile | null = null;
let sessionLaunch: { requestId: string; accountId: string; epoch: number } | null = null;

const currentProfile = () => desktop?.accounts.find(account => account.id === desktop?.activeAccountId);
const epoch = () => service?.epoch ?? 0;
const instanceId = () => service?.instanceId ?? browserIdentity?.instanceId ?? null;
const isEnabled = () => !demo && desktop?.enabled !== false;
const busy = () => mutationOwner !== null;
const syncing = () => (!bridge || service?.connected === true) && !syncReadFailed && (refreshPending !== null || !!desktop?.refreshing);
const month = () => element<HTMLInputElement>('record-period').value;

function feedback(text: string, error = false): void {
  const node = element('feedback'); node.textContent = text; node.hidden = !text; node.dataset.state = error ? 'error' : 'success';
}

function quotaTimes(view: { providerUpdatedAt: string | null; fetchedAt: string | null }): string {
  return `${view.providerUpdatedAt ? `数据时间 ${timestamp(view.providerUpdatedAt, true)}` : '来源时间未知'}${view.fetchedAt ? ` · 读取于 ${timestamp(view.fetchedAt, true)}` : ''}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const operationEpoch = epoch();
  const operationInstance = instanceId();
  const headers = new Headers(init?.headers);
  if (operationInstance) headers.set('X-PilotMeter-Instance', operationInstance);
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000), ...init, headers, redirect: 'error' });
  if (operationEpoch !== epoch() || operationInstance !== instanceId()) throw new Error('本机服务已切换，请重试。');
  if (!response.ok) {
    let message = `本机服务暂时无法完成请求（${response.status}）`;
    try {
      const value = await response.json() as { error?: string | { message?: string }; message?: string };
      message = (typeof value.error === 'string' ? value.error : value.error?.message) ?? value.message ?? message;
    } catch { /* Keep the response status when the server returned a non-JSON error. */ }
    throw new Error(message);
  }
  const value = await response.json() as T;
  if (operationEpoch !== epoch() || operationInstance !== instanceId()) throw new Error('本机服务已切换，请重试。');
  return value;
}

async function mutate<T>(path: string, method: string, body?: object): Promise<T> {
  if (!isEnabled()) throw new Error('设计预览不执行账号操作。');
  const operationEpoch = epoch();
  const operationInstance = instanceId();
  if (!operationInstance) throw new Error('本机服务身份尚未确认，请稍后重试。');
  const session = await api<{ csrfToken: string }>('/api/session');
  if (operationEpoch !== epoch() || operationInstance !== instanceId()) throw new Error('本机服务已切换，请重试。');
  return api<T>(path, { method, headers: { 'Content-Type': 'application/json', 'X-PilotMeter-CSRF': session.csrfToken }, body: JSON.stringify(body ?? {}) });
}

function send(message: Record<string, unknown>): void { bridge?.postMessage({ ...message, epoch: epoch() }); }

// Only terminal outcomes of an operation notify the pet. Polls and progress
// feedback do not create events, and old service replies cannot notify a new one.
function notifyPet(reason: PetNoticeReason, eventId: string, operationEpoch: number): void {
  if (demo || !bridge || !service?.connected || operationEpoch !== epoch()) return;
  send({ type: 'pet-notify', reason, eventId });
}

/** Serialize account mutations and let the desktop owner pause native polling first. */
async function acquire(): Promise<() => void> {
  const previous = mutationQueue;
  let unlock!: () => void;
  mutationQueue = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  const operationId = crypto.randomUUID();
  const operationEpoch = epoch();
  mutationOwner = operationId;
  controls();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (bridge) bridge.postMessage({ type: 'account-mutation', operationId, epoch: operationEpoch, pending: false });
    if (mutationOwner === operationId) { mutationOwner = null; controls(); }
    unlock();
  };
  try {
    if (bridge) {
      if (!service?.connected) throw new Error(service?.message ?? '本机服务尚未连接，请稍后重试。');
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (mutationAck?.id === operationId) mutationAck = null;
          reject(new Error('桌面应用未能准备账号操作，请重试。'));
        }, 7000);
        mutationAck = { id: operationId, epoch: operationEpoch, resolve, reject, timer };
        bridge.postMessage({ type: 'account-mutation', operationId, epoch: operationEpoch, pending: true });
      });
      if (operationEpoch !== epoch()) throw new Error('本机服务已切换，请重试。');
    }
    return release;
  } catch (error) { release(); throw error; }
}

function identity(value: { app: string; instanceId: string; version: string }): void {
  const expected = service?.instanceId ? service : browserIdentity;
  if (value.app !== 'pilotmeter' || expected?.instanceId && value.instanceId !== expected.instanceId || expected?.version && value.version !== expected.version) throw new Error('本机服务已变化，请重新连接后同步。');
}

function controls(): void {
  const disconnected = !!bridge && service?.connected !== true;
  const selected = element<HTMLSelectElement>('account-select');
  selected.disabled = busy() || disconnected || !desktop?.accounts.length || !isEnabled();
  const refresh = element<HTMLButtonElement>('refresh-button');
  const active = syncing();
  refresh.disabled = busy() || disconnected || active || !isEnabled();
  refresh.classList.toggle('is-refreshing', active);
  refresh.setAttribute('aria-busy', String(active));
  refresh.querySelector('span:last-child')!.textContent = active ? '同步中' : '同步';
  element('quota-area').setAttribute('aria-busy', String(active));
  document.documentElement.classList.toggle('is-syncing', active);
  document.querySelectorAll<HTMLButtonElement>('[data-action="refresh"]').forEach(node => { node.disabled = refresh.disabled; });
  document.querySelectorAll<HTMLButtonElement>('[data-action="select-account"],[data-action="remove"],[data-action="reauth"]').forEach(node => { node.disabled = busy() || disconnected || !isEnabled(); });
  document.querySelectorAll<HTMLButtonElement>('[data-action="login"]').forEach(node => { node.disabled = busy() || !isEnabled(); });
  const category = document.getElementById('quota-category') as HTMLSelectElement | null;
  if (category) category.disabled = busy() || disconnected;
  element<HTMLButtonElement>('load-records').disabled = busy() || disconnected || recordsLoading;
  element<HTMLInputElement>('record-period').disabled = busy();
  element<HTMLSelectElement>('record-sort').disabled = busy();
  document.querySelectorAll<HTMLButtonElement>('[data-action="select-pet"]').forEach(node => { node.disabled = busy() || !petState || !bridge && !demo; });
  for (const id of ['pet-size', 'pet-motion', 'pet-topmost']) element<HTMLInputElement>(id).disabled = busy() || !petState || !bridge && !demo;
  const profile = currentProfile();
  document.querySelectorAll<HTMLButtonElement>('[data-action="start-session"]').forEach(button => {
    button.disabled = !isEnabled() || busy() || disconnected || !!sessionLaunch || !!bridge && service?.sessionLaunchAvailable !== true;
    button.querySelector('[data-session-start-label]')!.textContent = sessionLaunch ? '正在启动…' : !profile ? desktop?.accounts.length ? '选择账号后开始' : '连接账号并开始' : profile.status === 'reauth-required' ? '重新登录后开始' : '启动 Copilot 会话';
  });
  document.querySelectorAll<HTMLElement>('[data-session-help]').forEach(node => {
    node.textContent = demo ? '设计预览 · 启动会话已停用，记录均为虚构示例。' : bridge && service?.sessionLaunchAvailable !== true ? '启动会话需要桌面应用连接到本机服务。' : '从这里启动的 Copilot CLI 会话会自动记录用量。登录 GitHub 不会导入历史会话。';
  });
}

function renderHeader(): void {
  const profile = currentProfile();
  element('header-avatar').textContent = profile?.login.slice(0, 1).toUpperCase() ?? 'G';
  const select = element<HTMLSelectElement>('account-select');
  const options = desktop?.accounts.map(account => `<option value="${escape(account.id)}">${escape(account.login)} · ${escape(hostName(account.host))}</option>`).join('') ?? '';
  const markup = options + `<option value="">${options ? '全部本机记录' : '尚未连接账号'}</option>`;
  if (select.dataset.options !== markup) { select.innerHTML = markup; select.dataset.options = markup; }
  select.value = desktop?.activeAccountId ?? '';
  element('sidebar-status').textContent = demo ? '设计预览' : service?.connected === false ? '本机服务待连接' : desktop ? '本机服务已连接' : '正在连接本机服务';
  element('service-dot').classList.toggle('online', !!desktop && service?.connected !== false);
  element('app-version').textContent = desktop && !demo ? desktop.version.replace('0.1.0-', '') : '';
  element('page-meta').textContent = page === 'records' && month() ? `本机记录 · ${month().replace('-', ' / ')}（UTC）` : '';
  element('last-sync').textContent = desktop?.presentation.fetchedAt ? quotaTimes(desktop.presentation) : 'PilotMeter · 数据保存在本机';
  const modelCount = desktop?.models?.items.filter(model => model.status === 'available').length ?? 0;
  element('nav-model-count').hidden = !modelCount;
  element('nav-model-count').textContent = String(modelCount);
}

function loginButton(label = '连接 GitHub'): string { return `<button type="button" class="button button-primary" data-action="login">${icon('github')}${escape(label)}</button>`; }

function metric(label: string, value: string, note: string, className = ''): string {
  return `<div class="quota-metric"><div class="metric-label">${escape(label)}</div><strong class="metric-value ${className}" data-motion-key="${escape(label)}" tabindex="0" title="${escape(value)}">${escape(value)}</strong><div class="metric-note">${escape(note)}</div></div>`;
}

function quotaCard(bucket: PersonalQuotaBucketView, details: string): string {
  const stale = desktop!.presentation.stale;
  const state = !bucket.providerUpdatedAt ? '来源时间未知' : stale ? '数据较旧' : '数据已读取';
  const used = bucket.used ?? bucket.raw.used;
  const total = bucket.limit ?? bucket.raw.limit;
  const remaining = bucket.remaining !== null ? amount(bucket.remaining) : bucket.remainingPercentage !== null ? `${bucket.remainingPercentage}%` : bucket.unlimited ? '无固定上限' : '—';
  const remainingLabel = bucket.remaining !== null ? '剩余额度' : bucket.unlimited ? '额度状态' : '剩余比例';
  const unit = bucket.unit === 'unspecified' ? '额度数值 · 单位待确认' : bucket.unitLabel;
  const remainingNote = bucket.remainingSource === 'calculated' ? '按总额减已用计算' : bucket.remainingPercentage !== null ? 'GitHub 返回比例，可能已舍入' : bucket.unlimited ? '此类别不设固定额度' : 'GitHub 尚未提供';
  return `<article class="card quota-card" aria-label="${escape(bucket.label)}额度"><div class="quota-card-heading"><div><div class="quota-card-title"><h2>${escape(bucket.label)}</h2><span class="quota-unit">${bucket.unit === 'unspecified' ? icon('info') : ''}${escape(unit)}</span></div><p class="quota-card-subtitle">@${escape(currentProfile()?.login ?? '')} · ${escape(hostName(currentProfile()?.host ?? ''))}</p></div><span class="source-badge">${icon(stale ? 'clock' : 'check')}${state}</span></div><div class="quota-metrics">${metric('已用额度', amount(used), bucket.usageSource === 'remaining' ? '按总额减剩余量计算' : 'GitHub 返回值，精度依上游', 'used')}${metric('总额度', bucket.unlimited ? '无固定上限' : amount(total), bucket.unlimited ? '不代表所有模型都可用' : bucket.unit === 'unspecified' ? '未换算为次数或点数' : bucket.unitLabel)}${metric(remainingLabel, remaining, remainingNote, 'remaining')}</div>${bucket.percentage !== null ? `<progress class="quota-progress" max="100" value="${bucket.percentage}" aria-label="${escape(bucket.label)}已用比例" aria-valuetext="${escape(bucket.usedPercentage)}%"></progress>` : ''}<div class="quota-progress-label"><span>${bucket.usedPercentage !== null ? `已使用 <strong>${escape(bucket.usedPercentage)}%</strong>` : escape(bucket.unlimited ? '无固定上限' : '使用比例待确认')}</span><span>${bucket.nextResetAt ? `${escape(timestamp(bucket.nextResetAt, true))} 重置` : '重置时间待确认'}</span></div>${details}</article>`;
}

function otherQuota(bucket: PersonalQuotaBucketView): string {
  return `<article class="other-quota"><h3>${escape(bucket.label)}</h3><div class="other-quota-value">${bucket.unlimited ? '无固定上限' : `${escape(amount(bucket.used ?? bucket.raw.used))} / ${escape(amount(bucket.limit ?? bucket.raw.limit))}`}</div><p>${bucket.unlimited ? '' : '已用 / 总额 · '}${escape(bucket.unitLabel)}</p><p>${escape(bucket.detail)}</p><p>${escape(quotaTimes({ providerUpdatedAt: bucket.providerUpdatedAt, fetchedAt: desktop?.presentation.fetchedAt ?? null }))}</p></article>`;
}

function renderQuota(): void {
  const container = element('quota-area');
  const profile = currentProfile();
  if (!desktop) return;
  if (!profile) { container.innerHTML = `<div class="card">${emptyState('把你的 Copilot 用量，放在眼前', '连接 GitHub，查看属于这个账号的实际额度与可用模型。', loginButton(), false, 'github')}</div>`; return; }
  if (profile.status === 'reauth-required') { container.innerHTML = `<div class="card">${emptyState('这个账号需要重新连接', `@${profile.login} 的登录已失效。重新授权后继续查看额度。`, `<button type="button" class="button button-primary" data-action="reauth" data-account="${escape(profile.id)}">重新连接账号</button>`, false, 'user')}</div>`; return; }
  const view = desktop.presentation;
  let choice = '';
  if (view.selection === 'required' || view.selection === 'explicit') choice = `<label class="category-choice">额度类别<select id="quota-category"><option value="">选择一个类别</option>${view.buckets.map(bucket => `<option value="${escape(bucket.key)}"${view.primary?.key === bucket.key ? ' selected' : ''}>${escape(bucket.label)}</option>`).join('')}</select></label>`;
  const detailsOpen = container.querySelector<HTMLDetailsElement>('#quota-explanation')?.open ?? false;
  const details = `<details class="quota-details${view.primary ? ' quota-details-inline' : ''}" id="quota-explanation"${detailsOpen ? ' open' : ''}><summary><span>${view.stale && view.providerUpdatedAt ? '数据较旧 · ' : ''}${escape(quotaTimes(view))}</span><span>额度说明${view.buckets.length > 1 ? '与其他类别' : ''} ${icon('chevron')}</span></summary><div class="quota-details-body"><p>${view.primary?.unit === 'unspecified' ? 'GitHub 未声明数量单位，因此已用和总额不换算成请求次数或 AI Credits。优先按总额减剩余量计算已用，缺少精确数量时显示未知，不从百分比反推已用量。' : '当前额度来自已登录 GitHub 账号的 Copilot 快照。剩余额度仅在数量单位确认后按总额减已用计算。'}</p><p>逗号是千位分隔符（66,000 表示六万六千）；显示完整数值，不额外舍入。百分比由 GitHub 返回，可能已舍入，不能用于反算精确已用量。各类别独立计量，本机采集记录不会加进账号额度。</p>${desktop.quota?.error ? `<p class="error-text">同步提示：${escape(desktop.quota.error.message)}</p>` : ''}<div class="other-quotas">${view.buckets.filter(bucket => bucket.key !== view.primary?.key).map(otherQuota).join('')}</div></div></details>`;
  const primary = view.primary ? quotaCard(view.primary, details) : `<div class="card">${emptyState(view.selection === 'required' ? '选择你要查看的额度' : view.buckets.length ? '各类别均无固定上限' : desktop.refreshing ? '正在同步 Copilot 额度' : '还没有取得额度快照', view.selection === 'required' ? '不同类别独立计量，请从上方选择；不会将它们相加。' : view.buckets.length ? '展开下方说明，查看各类别的具体信息。' : desktop.quota?.error?.message ?? '点击同步重新获取。未知额度不代表没有消耗。', !view.buckets.length && !desktop.refreshing ? `<button type="button" class="button button-secondary" data-action="refresh">${icon('refresh')}同步额度</button>` : '', false, 'activity')}</div>`;
  const scope = JSON.stringify([instanceId(), epoch(), profile.id, view.primary?.key, view.primary?.unit]);
  renderAnimatedContent(container, `${choice}${primary}${view.primary ? '' : details}`, scope);
}

function family(model: AccountModel): string { const name = `${model.id} ${model.name}`.toLowerCase(); return name.includes('claude') ? 'claude' : name.includes('gpt') || name.includes('o3') || name.includes('o4') ? 'gpt' : name.includes('gemini') ? 'gemini' : 'other'; }
function availability(model: AccountModel): string { return `<span class="availability" data-state="${model.status}"><span class="status-dot"></span>${({ available: '可用', disabled: '不可用', unknown: '待确认' })[model.status]}</span>`; }
function modelGlyph(model: AccountModel): string { return `<span class="model-glyph" data-family="${family(model)}">${icon('sparkles')}</span>`; }
function modelEmpty(compact = false): string {
  const profile = currentProfile();
  const models = desktop?.models;
  return emptyState(!profile ? '连接账号后查看模型' : profile.status === 'reauth-required' ? '重新登录后查看模型' : '模型列表暂不可用', !profile ? '可用模型因账号和组织策略而异。' : models?.error?.message ?? '点击同步获取当前账号的模型权限。', !profile ? loginButton('连接账号') : '', compact);
}

function renderModels(): void {
  const models = desktop?.models;
  const all = models?.items ?? [];
  const available = all.filter(model => model.status === 'available');
  element('model-preview-list').innerHTML = available.length ? available.slice(0, 3).map(model => `<div class="model-preview-row">${modelGlyph(model)}<div class="model-identity"><div class="model-name">${escape(model.name)}</div><div class="model-id">${escape(model.id)}</div></div>${model.multiplier !== null ? `<span class="model-cost">${escape(model.multiplier)}× 倍率</span>` : ''}${availability(model)}</div>`).join('') : modelEmpty(true);
  element('model-total').textContent = String(all.length);
  element('models-context').textContent = models ? `${models.stale || models.state === 'error' ? '旧快照 · ' : ''}${models.refreshing ? '正在同步 · ' : ''}${available.length} 个可用 · ${models.fetchedAt ? `更新于 ${timestamp(models.fetchedAt, true)}` : '尚未取得更新时间'}。倍率来自 GitHub，不代表单个模型的额度。${models.error ? ` ${models.error.message}` : ''}` : '模型权限随当前 GitHub 账号切换。';
  const filtered = all.filter(model => (modelFilter === 'all' || model.status === modelFilter) && `${model.name} ${model.id}`.toLowerCase().includes(modelSearch.toLowerCase()));
  element('models-list').innerHTML = filtered.length ? filtered.map(model => `<article class="card model-card"><div class="model-card-top">${modelGlyph(model)}${availability(model)}</div><h3>${escape(model.name)}</h3><p class="model-id">${escape(model.id)}</p><div class="model-capabilities">${model.vision === true ? '<span class="capability">图像理解</span>' : ''}${model.reasoningEffort === true ? '<span class="capability">推理强度可调</span>' : ''}${model.contextWindowTokens !== null ? `<span class="capability">${escape(amount(String(model.contextWindowTokens)))} 上下文 tokens</span>` : ''}${model.vision === null && model.reasoningEffort === null && model.contextWindowTokens === null ? '<span class="capability">能力信息待确认</span>' : ''}</div><div class="model-card-footer"><span>计费倍率</span><strong>${model.multiplier !== null ? `${escape(model.multiplier)}×` : '尚未提供'}</strong></div>${model.reason ? `<p class="model-reason">${escape(model.reason)}</p>` : ''}</article>`).join('') : all.length ? emptyState('没有符合条件的模型', '换一个关键词或筛选条件试试。', '', false, 'search') : modelEmpty();
}

function renderLocal(): void {
  if (!desktop) return;
  const local = desktop.local;
  const calls = local.knownCalls + local.unknownCalls + local.pendingCalls;
  const markup = `<div class="local-stat-grid"><div><div class="local-stat-value" data-motion-key="sessions">${escape(amount(String(local.sessionCount)))}</div><div class="local-stat-label">会话</div></div><div><div class="local-stat-value" data-motion-key="calls">${escape(amount(String(calls)))}</div><div class="local-stat-label">采集调用</div></div><div><div class="local-stat-value" data-motion-key="unknown">${escape(amount(String(local.unknownCalls + local.pendingCalls)))}</div><div class="local-stat-label">用量待确认</div></div></div><div class="local-scope"><p>${local.unitVerified && local.credits !== null ? `已确认用量 <strong><span data-motion-key="credits">${escape(amount(local.credits))}</span> AI Credits</strong>` : local.nanoAiu !== null ? `采集原始量 <strong data-motion-key="raw">${escape(amount(local.nanoAiu))}</strong> · 单位待确认` : '本机尚未取得可确认的用量数值'}</p><p>${escape(local.scope)}。${local.retained ? '仅包含留存范围内的记录。' : ''}这些记录不代表账号的全部消耗。</p></div>`;
  renderAnimatedContent(element('local-summary'), markup, JSON.stringify([instanceId(), epoch(), local.accountId, local.period, local.unitVerified, local.retained]));
}

function recordTable(items: DesktopRecord[], recent = false, failure = ''): string {
  if (!items.length) return emptyState(failure ? '记录读取未完成' : '还没有本机记录', failure || '通过上方按钮启动 Copilot 会话，完成对话后，采集记录会自动显示在这里。', failure ? `<button type="button" class="button button-secondary" data-action="${recent ? 'reload-recent' : 'reload-records'}">重新读取</button>` : '', true, 'terminal');
  return `<div class="table-scroll" tabindex="0" aria-label="${recent ? '最近会话' : '会话记录'}，宽表可横向滚动"><table class="records-table"><thead><tr><th>会话</th><th>模型</th><th>调用</th><th>已知用量</th><th>最近活跃</th></tr></thead><tbody>${items.map(item => `<tr><td><div class="session-name">${icon('terminal')}<code title="${escape(item.sessionId)}">${escape(item.sessionId)}</code></div></td><td class="record-models">${escape(item.models.join(' / ') || '模型未知')}</td><td class="record-number">${escape(amount(String(item.knownCalls + item.unknownCalls + item.pendingCalls)))}${item.unknownCalls + item.pendingCalls ? `<span class="record-note">${item.unknownCalls + item.pendingCalls} 条用量待确认</span>` : ''}</td><td class="record-number">${escape(amount(item.unitVerified ? item.credits : item.nanoAiu))}<span class="record-note">${item.unitVerified ? 'AI Credits' : item.nanoAiu !== null ? '原始值 · 单位待确认' : '用量待确认'}</span></td><td class="record-number">${escape(timestamp(item.lastSeen, true))}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderRecords(): void {
  element('recent-description').textContent = `${recentRecords?.period ?? desktop?.local.period ?? new Date().toISOString().slice(0, 7)}（UTC）· 最近活跃的本机采集会话`;
  if (page === 'records') element('page-meta').textContent = `本机记录 · ${month().replace('-', ' / ')}（UTC）`;
  const items = records?.items ?? [];
  element('recent-records').innerHTML = recentLoading && !recentRecords ? emptyState('正在读取本机记录', '请稍候。', '', true, 'terminal') : recordTable(recentRecords?.items.slice(0, 3) ?? [], true, recentFailure);
  element('records-list').innerHTML = recordsLoading && !records ? emptyState('正在读取本机记录', '请稍候。', '', true, 'terminal') : recordTable(items, false, recordFailure);
  const staleNotice = (failure: string, action: string) => `<p class="context-line error-text" role="status">记录更新未完成，当前显示上次读取结果。${escape(failure)} <button type="button" class="text-button" data-action="${action}">重新读取</button></p>`;
  if (recentFailure && recentRecords?.items.length) element('recent-records').insertAdjacentHTML('afterbegin', staleNotice(recentFailure, 'reload-recent'));
  if (recordFailure && items.length) element('records-list').insertAdjacentHTML('afterbegin', staleNotice(recordFailure, 'reload-records'));
  element('records-context').textContent = records ? `${records.scope} · ${records.period}（UTC）· ${records.retained ? '仅包含留存记录' : '仅包含本机采集记录'}，不代表账号的全部消耗。` : '记录与当前选择的 GitHub 账号对应。';
  element<HTMLButtonElement>('load-records').hidden = !records?.nextCursor;
  controls();
}

function renderAccounts(): void {
  const profiles = desktop?.accounts ?? [];
  element('accounts-list').innerHTML = profiles.length ? profiles.map(profile => `<article class="card account-card${profile.id === desktop!.activeAccountId ? ' active' : ''}"><div class="account-card-top"><span class="account-avatar">${escape(profile.login.slice(0, 1).toUpperCase())}</span><div><h3>@${escape(profile.login)}</h3><p class="account-host">${escape(hostName(profile.host))}</p></div>${profile.id === desktop!.activeAccountId ? '<span class="subtle-badge">当前账号</span>' : ''}</div><div class="account-card-status" data-state="${profile.status}"><span class="status-dot"></span>${profile.status === 'connected' ? '账号已连接' : profile.status === 'reauth-required' ? '登录已失效，请重新授权' : '连接异常，请重新同步'}${profile.checkedAt ? ` · ${escape(timestamp(profile.checkedAt, true))}` : ''}</div><div class="account-card-actions">${profile.id !== desktop!.activeAccountId ? `<button type="button" class="button button-secondary" data-action="select-account" data-account="${escape(profile.id)}">切换到此账号</button>` : ''}<button type="button" class="text-button" data-action="reauth" data-account="${escape(profile.id)}">重新登录</button><button type="button" class="text-button" data-action="remove" data-account="${escape(profile.id)}">移除</button></div></article>`).join('') : `<div class="card">${emptyState('从连接第一个账号开始', '个人和工作账号可以同时保存，随时切换查看。', loginButton(), false, 'users')}</div>`;
}

function renderPets(): void {
  const enabled = !!petState && (!!bridge || demo) && !busy();
  element('pet-options').innerHTML = pets.map(pet => `<button type="button" class="pet-option" data-action="select-pet" data-pet="${pet.id}" aria-label="选择宠物 ${escape(pet.name)}" aria-pressed="${petState?.petId === pet.id}" title="${escape(pet.description)}"${enabled ? '' : ' disabled'}><img src="${escape(pet.image)}" width="72" height="72" alt="" loading="lazy"><span>${escape(pet.name)}</span></button>`).join('');
  const selected = pets.find(pet => pet.id === petState?.petId) ?? pets[0]!;
  element<HTMLImageElement>('sidebar-pet').src = selected.image;
  element('pet-selection-label').textContent = petState ? `当前 · ${selected.name}` : '10 个伙伴';
  const size = element<HTMLInputElement>('pet-size'); size.disabled = !enabled; size.value = String(petState?.sizePixels ?? 96);
  element('pet-size-value').textContent = `${size.value} px`;
  const motion = element<HTMLInputElement>('pet-motion'); motion.disabled = !enabled; motion.checked = petState?.motionEnabled ?? true;
  const top = element<HTMLInputElement>('pet-topmost'); top.disabled = !enabled; top.checked = petState?.alwaysOnTop ?? true;
  element('pet-help').textContent = demo ? '设计预览：可以切换伙伴和尺寸查看效果，此页不会保存设置。' : petState?.persistenceWarning || (enabled ? '选择立即生效并保存在本机。关闭主窗口后，桌面伙伴会继续陪着你。' : '在 Windows 桌面应用中设置伙伴，选择会保存在这台电脑。');
}

function updatePet(update: Partial<PetState>): void {
  if (!petState || busy()) return;
  if (demo) { petState = { ...petState, ...update }; renderPets(); }
  else send({ type: 'pet-update', ...update });
}

function render(): void { renderHeader(); renderQuota(); renderModels(); renderLocal(); renderAccounts(); controls(); }

function resetRecords(): void {
  recordsGeneration++; recentGeneration++;
  records = recentRecords = null;
  recordFailure = recentFailure = '';
  recordsLoading = recentLoading = false;
  recordPages = 1;
  sessionLaunch = null;
  element<HTMLDialogElement>('session-cli-dialog').close();
}

function startSession(): void {
  if (!isEnabled() || busy() || sessionLaunch) return;
  const profile = currentProfile();
  if (!profile && desktop?.accounts.length) {
    feedback('请在右上角选择一个已连接账号，再启动 Copilot 会话。');
    const selected = element<HTMLSelectElement>('account-select');
    selected.focus();
    try { selected.showPicker?.(); } catch { /* Focus still reaches the account list when the host cannot open its picker. */ }
    return;
  }
  if (!profile || profile.status === 'reauth-required') { login.open(profile); return; }
  if (!bridge) {
    element('session-cli-command').textContent = `pilotmeter run --account ${profile.id} --`;
    element('session-cli-account').textContent = `使用 @${profile.login} 的已保存账号连接。`;
    element('session-copy-feedback').textContent = '';
    element<HTMLDialogElement>('session-cli-dialog').showModal();
    return;
  }
  if (!service?.connected || service.sessionLaunchAvailable !== true) return;
  sessionLaunch = { requestId: crypto.randomUUID(), accountId: profile.id, epoch: epoch() };
  feedback('请选择项目文件夹，随后会打开 Copilot 终端。');
  controls();
  send({ type: 'start-session', ...sessionLaunch });
}

async function loadRecent(): Promise<void> {
  if (!desktop || recentLoading || busy()) return;
  const operation = ++recentGeneration;
  const account = desktop.activeAccountId;
  const currentEpoch = epoch();
  const period = desktop.local.period;
  if (recentRecords?.period !== period) recentRecords = null;
  recentLoading = true;
  recentFailure = '';
  renderRecords();
  try {
    const params = new URLSearchParams({ accountId: account ?? '', period, sort: 'recent' });
    const value = demo ? structuredClone(demoData!.records) : await api<DesktopRecordsResponse>(`/api/desktop/records?${params}`);
    if (operation !== recentGeneration || currentEpoch !== epoch() || account !== desktop?.activeAccountId) return;
    identity(value);
    if (value.accountId !== account || !demo && value.period !== period) throw new Error('账号或月份已变化，请重新读取记录。');
    recentRecords = value;
  } catch (error) {
    if (operation !== recentGeneration || currentEpoch !== epoch() || account !== desktop?.activeAccountId) return;
    recentFailure = errorMessage(error);
  } finally { if (operation === recentGeneration) { recentLoading = false; renderRecords(); } }
}

/** Refresh every loaded page together so new rows do not discard pagination or leave old totals behind. */
async function loadRecords(append = false, preserve = false): Promise<void> {
  if (!desktop || append && !records?.nextCursor || (append || preserve) && recordsLoading || busy()) return;
  const operation = ++recordsGeneration;
  const account = desktop.activeAccountId;
  const currentEpoch = epoch();
  const period = month();
  const sort = element<HTMLSelectElement>('record-sort').value;
  const pages = preserve ? recordPages : 1;
  const previous = records;
  recordsLoading = true;
  recordFailure = '';
  if (!append && !preserve) { records = null; recordPages = 1; }
  renderRecords();
  try {
    const params = new URLSearchParams({ accountId: account ?? '', period, sort });
    if (append && previous?.nextCursor) params.set('cursor', previous.nextCursor);
    let refreshed: DesktopRecordsResponse | null = null;
    let fetched = 0;
    do {
      const value = demo ? structuredClone(demoData!.records) : await api<DesktopRecordsResponse>(`/api/desktop/records?${params}`);
      if (operation !== recordsGeneration || currentEpoch !== epoch() || account !== desktop?.activeAccountId) return;
      identity(value);
      if (value.accountId !== account || !demo && value.period !== period) throw new Error('账号或月份已变化，请重新读取记录。');
      const existing: DesktopRecord[] = refreshed?.items ?? (append ? previous?.items : []) ?? [];
      refreshed = { ...value, items: [...new Map([...existing, ...value.items].map(item => [item.id, item])).values()] };
      fetched++;
      if (!value.nextCursor || demo) break;
      params.set('cursor', value.nextCursor);
    } while (fetched < pages);
    records = refreshed;
    recordPages = append ? recordPages + fetched : fetched;
  } catch (error) {
    if (operation !== recordsGeneration || currentEpoch !== epoch() || account !== desktop?.activeAccountId) return;
    recordFailure = errorMessage(error);
    if (append) feedback(`更多记录读取失败：${recordFailure}`, true);
  } finally { if (operation === recordsGeneration) { recordsLoading = false; renderRecords(); } }
}

async function loadDesktop(): Promise<void> {
  const operation = ++viewGeneration;
  const currentEpoch = epoch();
  loading = true;
  window.clearTimeout(refreshTimer);
  try {
    if (!bridge && !demo && !browserIdentity) {
      const health = await api<{ app: string; instanceId: string; version: string }>('/health');
      if (operation !== viewGeneration || currentEpoch !== epoch()) return;
      if (health.app !== 'pilotmeter' || typeof health.instanceId !== 'string' || typeof health.version !== 'string') throw new Error('本机服务身份无法确认。');
      browserIdentity = { instanceId: health.instanceId, version: health.version };
    }
    const params = new URLSearchParams();
    if (quotaKey) params.set('quotaKey', quotaKey);
    const value = demo ? structuredClone(demoData!.desktop) : await api<DesktopResponse>(`/api/desktop${params.size ? `?${params}` : ''}`);
    if (operation !== viewGeneration || currentEpoch !== epoch()) return;
    identity(value);
    const scopeChanged = value.activeAccountId !== desktop?.activeAccountId;
    if (scopeChanged) resetRecords();
    desktop = value;
    syncReadFailed = false;
    render();
    void loadRecent();
    if (!recordsLoading) void loadRecords(false, true);
    if (refreshRequested && refreshRequested.accountId !== value.activeAccountId) {
      refreshRequested = null;
      feedback('当前账号已切换，请在当前账号重新同步。', true);
    } else if (refreshRequested && !value.refreshing) {
      const completed = refreshRequested;
      refreshRequested = null;
      const failure = value.quota?.error ?? value.models?.error;
      feedback(completed.accountId === null ? '已读取本机用量记录。' : failure ? `同步未完成：${failure.message}` : !value.presentation.fetchedAt ? '尚未取得额度。可以稍后重试，或在账户页重新登录。'
        : !value.presentation.providerUpdatedAt ? '已完成读取，但额度来源时间未知，无法确认数据是否最新。'
          : value.presentation.stale ? `已完成读取，但 GitHub 数据较旧。${quotaTimes(value.presentation)}。`
            : '已读取 GitHub 返回的额度和模型快照。GitHub 用量可能延迟更新。', !!failure);
      notifyPet(failure || completed.accountId !== null && !value.presentation.fetchedAt ? 'sync-failed' : 'sync-complete', completed.eventId, completed.epoch);
    }
    if (!demo && value.refreshing) refreshTimer = window.setTimeout(() => { if (!busy()) void loadDesktop(); }, 1500);
  } catch (error) {
    if (operation !== viewGeneration || currentEpoch !== epoch()) return;
    syncReadFailed = true;
    if (refreshRequested && refreshRequested.accountId === desktop?.activeAccountId) notifyPet('sync-failed', refreshRequested.eventId, refreshRequested.epoch);
    refreshRequested = null;
    feedback(`读取未完成：${errorMessage(error)}`, true);
    if (!desktop) {
      element('quota-area').innerHTML = `<div class="card">${emptyState('暂时没有连接到本机服务', '可以重试连接，或先打开登录窗口查看具体提示。', `<button type="button" class="button button-secondary" data-action="reload">${icon('refresh')}重新连接</button> ${loginButton('登录 GitHub')}`, false, 'activity')}</div>`;
      renderModels(); renderAccounts(); renderRecords();
    }
  } finally { if (operation === viewGeneration) { loading = false; controls(); } }
}

async function changeAccount(accountId: string | null): Promise<void> {
  if (busy() || !isEnabled() || accountId === desktop?.activeAccountId) return;
  const currentEpoch = epoch();
  let release: (() => void) | undefined;
  try {
    release = await acquire();
    viewGeneration++; resetRecords(); quotaKey = null;
    if (desktop) { desktop = { ...desktop, activeAccountId: accountId, presentation: { selection: 'none', primary: null, buckets: [], fetchedAt: null, providerUpdatedAt: null, stale: true }, quota: null, models: null }; render(); element('local-summary').innerHTML = emptyState('正在切换账号', '本机记录将随账号更新。', '', true, 'terminal'); renderRecords(); }
    feedback('正在切换账号…');
    await mutate('/api/auth/select', 'POST', { accountId });
    if (currentEpoch !== epoch()) return;
    send({ type: 'quota-selection', accountId, key: null });
    notifyPet('account-changed', crypto.randomUUID(), currentEpoch);
  } catch (error) { if (currentEpoch === epoch()) feedback(`账号切换未完成：${errorMessage(error)}`, true); }
  finally { release?.(); if (currentEpoch === epoch()) await loadDesktop(); }
}

async function refresh(): Promise<void> {
  if (busy() || syncing() || !isEnabled()) return;
  const currentEpoch = epoch();
  const account = desktop?.activeAccountId ?? null;
  const notice = { accountId: account, eventId: crypto.randomUUID(), epoch: currentEpoch };
  const pending = {};
  refreshPending = pending;
  syncReadFailed = false;
  controls();
  feedback(account ? '正在同步账号额度与模型…' : '正在读取本机记录…');
  let release: (() => void) | undefined;
  let failed = false;
  try {
    release = await acquire();
    if (!account) { refreshRequested = notice; await loadDesktop(); return; }
    await mutate(`/api/auth/refresh?accountId=${encodeURIComponent(account)}`, 'POST');
    if (currentEpoch !== epoch()) return;
    refreshRequested = notice;
  } catch (error) {
    if (currentEpoch === epoch()) {
      feedback(`同步未完成：${errorMessage(error)}`, true);
      failed = true;
    }
  }
  finally {
    release?.();
    if (currentEpoch === epoch()) await loadDesktop();
    if (failed && account === desktop?.activeAccountId) notifyPet('sync-failed', notice.eventId, currentEpoch);
    if (refreshPending === pending) { refreshPending = null; controls(); }
  }
}

const login = initializeDesktopLogin({ api, mutate, permitted: isEnabled, existing: () => desktop?.login ?? null, changed: async () => { viewGeneration++; resetRecords(); quotaKey = null; await loadDesktop(); }, feedback, notify: notifyPet, acquire, epoch,
  external: (url, loginId) => {
    if (bridge) send({ type: 'open-external', url, loginId });
    else window.open(url, '_blank', 'noopener,noreferrer');
  },
});

function navigate(): void {
  const requested = location.hash.slice(1);
  page = Object.hasOwn(pages, requested) ? requested as Page : 'overview';
  const info = pages[page];
  for (const key of Object.keys(pages)) element(`${key}-page`).hidden = key !== page;
  document.querySelectorAll<HTMLElement>('[data-page]').forEach(node => { if (node.dataset.page === page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  element('breadcrumb-current').textContent = info.title;
  element('page-title').innerHTML = `${escape(info.title)}<span class="heading-dot">.</span>`;
  element('page-description').textContent = info.description;
  document.title = `${info.title} · PilotMeter`;
  renderHeader();
  if (page === 'records' && !recordsLoading) void loadRecords(false, true);
  if (page === 'overview' && !recentLoading) void loadRecent();
}

async function removeAccount(): Promise<void> {
  if (!removeProfile || busy()) return;
  const profile = removeProfile;
  const currentEpoch = epoch();
  let release: (() => void) | undefined;
  const button = document.querySelector<HTMLButtonElement>('[data-action="confirm-remove"]')!;
  button.disabled = true;
  try {
    release = await acquire();
    await mutate(`/api/auth/accounts/${encodeURIComponent(profile.id)}`, 'DELETE');
    if (currentEpoch !== epoch()) return;
    element<HTMLDialogElement>('remove-dialog').close(); removeProfile = null;
    viewGeneration++; resetRecords(); quotaKey = null;
    feedback(`已移除 @${profile.login} 的账号连接。本机历史记录已保留。`);
  } catch (error) { if (currentEpoch === epoch()) { element('remove-error').hidden = false; element('remove-error').textContent = errorMessage(error); } }
  finally { release?.(); button.disabled = false; if (currentEpoch === epoch()) await loadDesktop(); }
}

document.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!target || (target as HTMLButtonElement).disabled) return;
  const action = target.dataset.action;
  if (action === 'login') login.open();
  if (action === 'reauth') login.open(desktop?.accounts.find(account => account.id === target.dataset.account));
  if (action === 'select-account') void changeAccount(target.dataset.account ?? null);
  if (action === 'refresh') void refresh();
  if (action === 'reload') void loadDesktop();
  if (action === 'load-records') void loadRecords(true);
  if (action === 'reload-records') void loadRecords();
  if (action === 'reload-recent') void loadRecent();
  if (action === 'start-session') startSession();
  if (action === 'close-session-cli') element<HTMLDialogElement>('session-cli-dialog').close();
  if (action === 'copy-session-command') void navigator.clipboard.writeText(element('session-cli-command').textContent ?? '').then(() => {
    element('session-copy-feedback').textContent = '启动命令已复制。';
  }).catch(() => { element('session-copy-feedback').textContent = '复制未完成，请选择上方命令手动复制。'; });
  if (action === 'quota-details') { const details = element<HTMLDetailsElement>('quota-explanation'); details.open = !details.open; if (details.open) details.scrollIntoView({ block: 'nearest' }); }
  if (action === 'pets') { location.hash = 'accounts'; navigate(); element('pet-settings').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  if (action === 'select-pet' && petState && pets.some(pet => pet.id === target.dataset.pet)) updatePet({ petId: target.dataset.pet });
  if (action === 'restart' && service?.recoverable && !service.recovering) send({ type: 'restart-service' });
  if (action === 'remove') {
    removeProfile = desktop?.accounts.find(account => account.id === target.dataset.account) ?? null;
    if (removeProfile) { element('remove-description').textContent = `将从这台电脑移除 @${removeProfile.login}（${hostName(removeProfile.host)}）的登录连接。`; element('remove-error').hidden = true; element<HTMLDialogElement>('remove-dialog').showModal(); }
  }
  if (action === 'cancel-remove') element<HTMLDialogElement>('remove-dialog').close();
  if (action === 'confirm-remove') void removeAccount();
});

element<HTMLSelectElement>('account-select').addEventListener('change', event => { void changeAccount((event.target as HTMLSelectElement).value || null); });
element<HTMLInputElement>('model-search').addEventListener('input', event => { modelSearch = (event.target as HTMLInputElement).value; renderModels(); });
document.querySelectorAll<HTMLButtonElement>('[data-model-filter]').forEach(button => button.addEventListener('click', () => { modelFilter = button.dataset.modelFilter!; document.querySelectorAll('[data-model-filter]').forEach(node => node.setAttribute('aria-pressed', String(node === button))); renderModels(); }));
document.addEventListener('change', event => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  if (target.id === 'quota-category' && !busy()) { quotaKey = target.value || null; send({ type: 'quota-selection', accountId: desktop?.activeAccountId ?? null, key: quotaKey }); void loadDesktop(); }
  if (target.id === 'record-period' || target.id === 'record-sort') { if (/^\d{4}-\d{2}$/.test(month())) void loadRecords(); }
  if (target.id === 'pet-size' && petState) updatePet({ sizePixels: Number(target.value) });
  if (target.id === 'pet-motion' && petState) updatePet({ motionEnabled: (target as HTMLInputElement).checked });
  if (target.id === 'pet-topmost' && petState) updatePet({ alwaysOnTop: (target as HTMLInputElement).checked });
});
element<HTMLInputElement>('pet-size').addEventListener('input', event => { element('pet-size-value').textContent = `${(event.target as HTMLInputElement).value} px`; });
window.addEventListener('hashchange', navigate);

bridge?.addEventListener('message', event => {
  const value = event.data;
  if (!value || typeof value !== 'object') return;
  if (value.type === 'account-mutation-state') {
    if (mutationAck && value.pending && value.operationId === mutationAck.id && value.epoch === mutationAck.epoch) { window.clearTimeout(mutationAck.timer); mutationAck.resolve(); mutationAck = null; }
    return;
  }
  if (value.type === 'session-start-result') {
    if (!sessionLaunch || value.requestId !== sessionLaunch.requestId || value.epoch !== sessionLaunch.epoch || value.epoch !== epoch() || sessionLaunch.accountId !== desktop?.activeAccountId) return;
    sessionLaunch = null;
    controls();
    feedback(value.message ?? (value.status === 'started' ? 'Copilot 终端已打开。完成对话后，会话与用量会自动显示。' : value.status === 'cancelled' ? '已取消启动会话。' : '会话启动失败，请重试。'), value.status === 'error');
    if (value.status === 'started') void loadDesktop();
    return;
  }
  if (value.type === 'session-exit') {
    if (value.accountId !== desktop?.activeAccountId || value.epoch !== epoch()) return;
    feedback(value.message ?? (value.normal ? 'Copilot 终端已结束。本机用量记录已保留。' : 'Copilot 会话意外结束，请检查账号登录后重试。'), value.normal !== true);
    void loadDesktop();
    return;
  }
  if (value.type === 'pet-state') { petState = value; renderPets(); return; }
  if (value.type === 'error' || value.type === 'host-error') { feedback(value.message ?? '桌面操作未完成，请重试。', true); return; }
  if (value.type !== 'service-state' || !Number.isSafeInteger(value.epoch)) return;
  const changed = service !== null && service.epoch !== value.epoch;
  const recovered = value.connected && service?.connected !== true;
  const selectionChanged = !busy() && !!desktop && (Object.hasOwn(value, 'accountId') && value.accountId !== desktop.activeAccountId || Object.hasOwn(value, 'quotaKey') && value.quotaKey !== quotaKey);
  service = value;
  if (selectionChanged) quotaKey = value.quotaKey ?? null;
  if (changed) {
    viewGeneration++; resetRecords(); desktop = null; loading = false; refreshRequested = null; refreshPending = null; syncReadFailed = false; quotaKey = value.quotaKey ?? null;
    login.invalidate();
    if (mutationAck) { window.clearTimeout(mutationAck.timer); mutationAck.reject(new Error('本机服务已变化，请重试。')); mutationAck = null; }
    element('quota-area').innerHTML = `<div class="card">${emptyState('正在重新连接本机服务', '连接完成后自动读取当前账号。', '', false, 'activity')}</div>`;
    renderModels(); renderRecords(); renderAccounts();
  }
  const banner = element('service-banner');
  banner.hidden = value.connected && !value.message;
  element('service-message').textContent = value.message ?? (value.recovering ? '正在重启本机服务…' : value.connected ? '' : '本机服务暂时不可用，请稍后重试。');
  element<HTMLButtonElement>('restart-button').hidden = !value.recoverable;
  element<HTMLButtonElement>('restart-button').disabled = value.recovering || busy();
  renderHeader();
  controls();
  if (value.connected && (changed || recovered || selectionChanged)) void loadDesktop();
});

hydrateIcons();
element('demo-banner').hidden = !demo;
element('page-eyebrow').hidden = true;
element<HTMLInputElement>('record-period').value = new Date().toISOString().slice(0, 7);
renderPets(); navigate();
if (bridge) bridge.postMessage({ type: 'ready' });
else void loadDesktop();
window.setInterval(() => { if (!demo && !busy() && !loading && !document.hidden && (!bridge || service?.connected)) void loadDesktop(); }, 30000);
