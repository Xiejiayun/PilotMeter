import './style.css';
import type { Diagnostic, SessionSummary, Settings, SpanRecord, Summary } from '../src/shared/types';

type SessionPage = { items: SessionSummary[]; nextCursor: string | null };
type Totals = Pick<SessionSummary, 'nanoAiu' | 'knownCalls' | 'unknownCalls' | 'pendingCalls'>;
type SessionDetail = SessionSummary & {
  events: SpanRecord[];
  lifetime: Totals;
  monthly: Record<string, Totals>;
  modelBreakdown: { model: string; nanoAiu: string | null; calls: number; unknownCalls: number; unitVerified: boolean; source: string }[];
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
}
function text(id: string, value: string | number): void { el(id).textContent = String(value); }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined) result.textContent = content;
  return result;
}
function formatDecimal(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return '—';
  const [integer = '0', fractional = ''] = value.split('.');
  const normalized = integer.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const remainder = fractional.replace(/0+$/, '');
  return normalized + (remainder ? `.${remainder}` : '');
}
// Decimal strings stay exact, including values beyond Number.MAX_SAFE_INTEGER.
function nanoToCredits(value: string): string {
  const normalized = BigInt(value).toString().padStart(10, '0');
  return `${normalized.slice(0, -9)}.${normalized.slice(-9)}`;
}
function measured(value: string | null, verified: boolean): string {
  return formatDecimal(value !== null && verified ? nanoToCredits(value) : value);
}
function dateTime(value: string | null, compact = false): string {
  if (!value || Number.isNaN(Date.parse(value))) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    ...(compact ? {} : { year: 'numeric' as const }), hour12: false,
  }).format(new Date(value));
}
function currentPeriod(): string { return new Date().toISOString().slice(0, 7); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }

let summary: Summary | null = null;
let settings: Settings | null = null;
let sessionItems: SessionSummary[] = [];
let nextCursor: string | null = null;
let visiblePages = 1;
let csrfToken: string | null = null;
let requestGeneration = 0;
let refreshing = false;
let budgetDirty = false;
let sessionSignature = '';
let detail: SessionDetail | null = null;
let detailRange: 'month' | 'lifetime' = 'month';
let detailRequest = 0;
let selectedSession: string | null = null;
let detailLastRead: string | null = null;
let detailRefreshing = false;
let lastRead: string | null = null;

const periodInput = el<HTMLInputElement>('period');
const budgetInput = el<HTMLInputElement>('budget');
const dialog = el<HTMLDialogElement>('session-dialog');
periodInput.value = currentPeriod();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8_000), ...init });
  if (!response.ok) {
    let message = `本地接口请求失败（${response.status}）`;
    try {
      const error = await response.json() as { error?: string | { message?: string }; message?: string };
      if (typeof error.error === 'string') message = error.error;
      else if (error.error?.message) message = error.error.message;
      else if (error.message) message = error.message;
    } catch { /* Non-JSON failures still retain their HTTP status. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function mutate<T>(path: string, method: string, body?: object): Promise<T> {
  // Refresh this capability after a daemon restart; it lives only in page memory.
  csrfToken = (await api<{ csrfToken: string }>('/api/session')).csrfToken;
  return api<T>(path, { method, headers: { 'Content-Type': 'application/json', 'X-PilotMeter-CSRF': csrfToken }, body: JSON.stringify(body ?? {}) });
}

function connection(connected: boolean, error?: string): void {
  el('connection-dot').className = `status-dot${connected ? '' : ' offline'}`;
  text('connection', connected ? '本地服务已连接' : '本地服务离线');
  if (!connected) {
    el('page-message').hidden = false;
    text('page-message', `${lastRead ? `连接中断，保留上次读取的记录（${dateTime(lastRead)}）。` : '暂时无法连接本地服务。请运行 pilotmeter start。'}${error ? ` ${error}` : ''}`);
    text('updated-at', lastRead ? `离线 · 上次读取 ${dateTime(lastRead)}` : '离线 · 尚未获取数据');
  } else {
    el('page-message').hidden = true;
  }
}

function renderSummary(value: Summary): void {
  const { local, display, account } = value;
  el('demo-banner').hidden = !value.demo;
  text('mode', display.label);
  text('mode-badge', display.mode === 'official' ? '官方账户' : display.mode === 'custom' ? '自定义预算' : '本机记录');
  const percentage = display.percentage;
  const unit = ({ 'ai-credits': 'AI Credits', 'credits': 'AI Credits', 'nano-aiu': 'nano AIU', 'premium-requests': 'Premium Requests' } as Record<string, string>)[display.unit] ?? display.unit;
  text('primary-value', percentage === null ? formatDecimal(display.used) : formatDecimal(percentage));
  text('primary-unit', percentage === null ? unit : '%');
  const hasLimit = display.limit !== null;
  const usageText = display.used === null ? '尚无已确认的用量' : `已知用量 ${formatDecimal(display.used)}${hasLimit ? ` / ${formatDecimal(display.limit)}` : ''} ${unit}`;
  text('usage-detail', `${usageText}${local.unknownCalls > 0 ? ` · ${local.unknownCalls} 次调用用量未知` : ''}`);
  text('scope', display.scope);
  text('period-caption', `${value.period} · UTC`);
  text('mode-reason', display.reason ?? (display.mode === 'official' ? '官方账户快照与本机记录独立保存，二者可能存在更新时间差异。' : '本机记录不代表整个账户的消费。官方比例仅在单位、额度池、周期和覆盖范围核实后显示。'));
  const progress = percentage === null ? null : Number(percentage);
  el('progress-wrap').hidden = progress === null || !Number.isFinite(progress);
  if (progress !== null && Number.isFinite(progress)) {
    el('progress-fill').style.width = `${Math.max(0, Math.min(progress, 100))}%`;
    el('progress').setAttribute('aria-valuenow', String(Math.max(0, Math.min(progress, 100))));
    el('progress').setAttribute('aria-valuetext', `实际已用 ${percentage}%`);
    el('overage').hidden = progress <= 100;
    text('overage', `已超出${display.mode === 'custom' ? '自定义预算' : '额度'} · 实际已用 ${percentage}%`);
  }
  text('official-state', display.mode === 'official' ? (account?.limitKind === 'unlimited' ? '无固定上限' : '已验证') : '未确认');
  text('unit-state', local.unitVerified ? 'AI Credits · 已验证' : 'nano AIU · 换算待确认');
  el('account-usage').hidden = !account;
  if (account) {
    const accountUnit = ({ 'ai-credits': 'AI Credits', 'premium-requests': 'Premium Requests', 'nano-aiu': 'nano AIU' } as Record<string, string>)[account.unit] ?? account.unit;
    const coverage = ({ complete: '已核实完整覆盖', partial: '部分产品覆盖', unknown: '覆盖范围未知' })[account.coverage];
    text('account-usage', `${account.billingEntity} · ${coverage} · ${account.used === null ? '用量未知' : `${formatDecimal(account.used)} ${accountUnit}`}。${account.products.length ? `账单产品：${account.products.join('、')}。` : ''} ${display.mode !== 'official' ? '尚不能推导官方月度百分比。' : ''}`);
  }
  text('session-count', local.sessionCount);
  text('known-count', local.knownCalls);
  text('unknown-count', local.unknownCalls);
  text('pending-count', local.pendingCalls);
  text('session-total', local.sessionCount);
  const timeParts = [`本地快照 ${dateTime(value.updatedAt)}`];
  if (account) {
    timeParts.push(`账单${account.stale ? '已陈旧 · ' : ''}抓取 ${dateTime(account.fetchedAt)}`);
    timeParts.push(account.providerUpdatedAt ? `官方截止 ${dateTime(account.providerUpdatedAt)}` : '官方数据截止时间未知');
  }
  text('updated-at', timeParts.join(' · '));
  renderRetention(value.retention);
  if (account?.stale || account?.lastError) {
    el('page-message').hidden = false;
    text('page-message', `${account.stale ? '账户快照已陈旧，保留上次已知值。' : `账户同步失败，${account.used === null ? '尚未取得有效账单快照' : '显示当前已有值'}。`}${account.lastError ? ` ${account.lastError.code}：${account.lastError.message}` : ''} 本机记录仍可持续更新。`);
  }
}

function retentionNotice(): string | null {
  const retention = summary?.retention;
  return retention && retention.prunedSpans > 0
    ? `历史已清理，当前用量和生命周期明细仅包含保留记录。累计清理 ${retention.prunedSpans} 条计量记录。${retention.days === null ? '自动清理现已关闭；' : ''}关闭清理也无法恢复已删除记录。`
    : null;
}

function renderRetention(retention: Summary['retention'] | undefined): void {
  if (!retention) {
    text('retention-policy', '保留策略暂不可用');
    text('retention-history', '等待服务提供历史保留状态。');
    el('retention-notice').hidden = true;
    return;
  }
  text('retention-policy', retention.days === null ? '自动清理已关闭' : `明细清理阈值 ${retention.days} 天`);
  const notice = retentionNotice();
  el('retention-notice').hidden = !notice;
  text('retention-notice', notice ?? '');
  text('retention-history', `${notice ?? '尚无历史清理记录。'}${retention.lastRunAt ? ` 最近检查 ${dateTime(retention.lastRunAt)}。` : ''}${retention.cutoff ? ` 最近清理阈值 ${dateTime(retention.cutoff)}。` : ''}`);
}

function renderSettings(value: Settings): void {
  if (!budgetDirty) budgetInput.value = value.monthlyBudget ?? '';
  if (!value.account) text('account-status', '尚未连接 · 官方额度未确认');
  else {
    const account = value.account as { kind: string; login?: string; entity?: string; directBilling?: boolean };
    const kinds: Record<string, string> = { user: '个人', organization: '组织', org: '组织', enterprise: '企业' };
    text('account-status', `${kinds[account.kind] ?? '计费主体'} · ${account.login ?? account.entity ?? '已绑定'}${account.directBilling === false && account.kind === 'user' ? ' · 非个人直付' : ''}`);
  }
}

function renderSessions(): void {
  const verified = summary?.local.unitVerified ?? false;
  const signature = JSON.stringify([sessionItems, verified]);
  el('empty-state').hidden = sessionItems.length > 0;
  el<HTMLButtonElement>('load-more').hidden = !nextCursor;
  if (signature === sessionSignature) return;
  sessionSignature = signature;
  const activeId = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.session : undefined;
  const fragment = document.createDocumentFragment();
  for (const session of sessionItems) {
    const button = node('button', 'session-row');
    button.type = 'button';
    button.dataset.session = session.id;
    const name = `会话 ${session.sessionId.slice(0, 14)}`;
    button.setAttribute('aria-label', `查看${name}详情`);
    const main = node('span', 'session-main');
    main.append(node('span', 'session-name', name), node('span', 'session-meta', `${dateTime(session.lastSeen, true)} · ${session.knownCalls + session.unknownCalls} 次顶层调用`));
    const models = node('span', 'model-tags');
    for (const model of session.models.slice(0, 3)) models.append(node('span', 'model-tag', model));
    if (session.models.length > 3) models.append(node('span', 'model-tag', `+${session.models.length - 3} 个模型`));
    main.append(models);
    const usage = node('span', 'session-usage');
    const amount = node('span', 'session-amount', measured(session.nanoAiu, verified));
    amount.title = session.nanoAiu === null ? '用量未知' : `${session.nanoAiu} nano AIU`;
    usage.append(amount, node('span', 'session-unit', `${verified ? 'AI Credits' : 'nano AIU'} · 已知小计`));
    usage.append(node('span', 'session-quality', session.unknownCalls || session.pendingCalls ? `${session.unknownCalls} 未知 · ${session.pendingCalls} 待分类` : '部分历史 · 从启用时记录'));
    button.append(main, usage);
    button.addEventListener('click', () => { void openDetail(session); });
    fragment.append(button);
  }
  el('sessions').replaceChildren(fragment);
  if (activeId) {
    const focused = Array.from(el('sessions').querySelectorAll<HTMLButtonElement>('button')).find(button => button.dataset.session === activeId);
    focused?.focus({ preventScroll: true });
  }
}

function renderDiagnostics(items: Diagnostic[]): void {
  text('diagnostic-count', items.length);
  const fragment = document.createDocumentFragment();
  if (!items.length) fragment.append(node('p', 'small muted', '暂无诊断记录。没有报错不代表历史覆盖完整。'));
  for (const item of items) {
    const entry = node('div', 'diagnostic');
    entry.append(node('p', 'diagnostic-code', item.code), node('p', 'diagnostic-message', item.message), node('p', 'diagnostic-time', `${dateTime(item.createdAt)} · 出现 ${item.count} 次`));
    fragment.append(entry);
  }
  el('diagnostics').replaceChildren(fragment);
}

async function loadDashboard(): Promise<void> {
  const generation = ++requestGeneration;
  const period = periodInput.value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return;
  refreshing = true;
  try {
    const results = await Promise.allSettled([
      api<Summary>(`/api/summary?period=${encodeURIComponent(period)}`),
      api<SessionPage>(`/api/sessions?period=${encodeURIComponent(period)}&sort=usage`),
      api<Settings>('/api/settings'),
      api<{ items: Diagnostic[] }>('/api/diagnostics'),
    ]);
    if (generation !== requestGeneration) return;
    const [summaryResult, sessionsResult, settingsResult, diagnosticsResult] = results;
    if (summaryResult.status === 'rejected') throw summaryResult.reason;
    if (sessionsResult.status === 'rejected') throw sessionsResult.reason;
    summary = summaryResult.value;
    let refreshedItems = sessionsResult.value.items;
    let refreshedCursor = sessionsResult.value.nextCursor;
    for (let pageIndex = 1; pageIndex < visiblePages && refreshedCursor; pageIndex++) {
      const page = await api<SessionPage>(`/api/sessions?period=${encodeURIComponent(period)}&sort=usage&cursor=${encodeURIComponent(refreshedCursor)}`);
      if (generation !== requestGeneration) return;
      const existing = new Set(refreshedItems.map(item => item.id));
      refreshedItems = [...refreshedItems, ...page.items.filter(item => !existing.has(item.id))];
      refreshedCursor = page.nextCursor;
    }
    sessionItems = refreshedItems;
    nextCursor = refreshedCursor;
    lastRead = new Date().toISOString();
    connection(true);
    renderSummary(summary);
    renderSessions();
    if (settingsResult.status === 'fulfilled') { settings = settingsResult.value; renderSettings(settings); }
    else text('account-status', '设置读取失败 · 将自动重试');
    if (diagnosticsResult.status === 'fulfilled') renderDiagnostics(diagnosticsResult.value.items);
    else text('diagnostics', '诊断暂时不可用 · 将自动重试');
    if (dialog.open) { renderDetail(); await refreshDetail(); }
  } catch (error) {
    if (generation !== requestGeneration) return;
    connection(false, errorMessage(error));
    if (dialog.open) detailStatus(errorMessage(error));
    if (!summary) text('sessions', '尚未读取会话。服务连接后自动重试。');
  } finally {
    if (generation === requestGeneration) refreshing = false;
  }
}

async function openDetail(session: SessionSummary): Promise<void> {
  detailRequest++;
  selectedSession = session.id;
  detail = null;
  detailLastRead = null;
  detailRefreshing = false;
  detailRange = 'month';
  text('detail-title', `会话 ${session.sessionId.slice(0, 14)}`);
  text('detail-id', `${session.sessionId} · 来源 ${session.sourceContext}`);
  text('detail-body', '正在读取会话明细…');
  text('detail-status', '正在读取会话明细…');
  el('detail-month').setAttribute('aria-pressed', 'true');
  el('detail-lifetime').setAttribute('aria-pressed', 'false');
  if (!dialog.open) dialog.showModal();
  await refreshDetail();
}

function detailStatus(error?: string): void {
  text('detail-status', error
    ? `${detailLastRead ? `详情更新失败，保留 ${dateTime(detailLastRead)} 读取的记录。` : '尚未取得会话详情。'} ${error}`
    : `详情读取 ${dateTime(detailLastRead)} · 每 5 秒更新`);
}

async function refreshDetail(): Promise<void> {
  if (!selectedSession || !dialog.open || detailRefreshing) return;
  const sessionId = selectedSession;
  const generation = ++detailRequest;
  detailRefreshing = true;
  try {
    const result = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}?period=${encodeURIComponent(periodInput.value)}`);
    if (generation !== detailRequest || !dialog.open) return;
    detail = result;
    detailLastRead = new Date().toISOString();
    detailStatus();
    renderDetail();
  } catch (error) {
    if (generation !== detailRequest || !dialog.open) return;
    detailStatus(errorMessage(error));
    if (!detail) text('detail-body', `无法读取明细：${errorMessage(error)}`);
  } finally { if (generation === detailRequest) detailRefreshing = false; }
}

function monthTotals(value: SessionDetail): Totals | undefined {
  return value.monthly[periodInput.value] ?? sessionItems.find(item => item.id === selectedSession);
}

function renderDetail(): void {
  if (!detail) return;
  const verified = summary?.local.unitVerified ?? false;
  const unit = verified ? 'AI Credits' : 'nano AIU';
  const totals = detailRange === 'lifetime' ? detail.lifetime : monthTotals(detail);
  const fragment = document.createDocumentFragment();
  const total = node('p', 'detail-total', measured(totals?.nanoAiu ?? null, verified));
  total.append(node('span', 'detail-unit', `${unit} · 已知小计`));
  fragment.append(total);
  const notes = node('p', 'detail-notes', `${detailRange === 'lifetime' ? '生命周期内已观测' : `${periodInput.value} · UTC 月份`} · ${totals?.knownCalls ?? 0} 次已知调用 · ${totals?.unknownCalls ?? 0} 次用量未知 · ${totals?.pendingCalls ?? 0} 次待分类。仅包含已采集记录。`);
  fragment.append(notes);
  const retention = retentionNotice();
  if (retention) fragment.append(node('p', 'notice', retention));
  const models = node('section', 'detail-section');
  models.append(node('h3', '', '已观测模型（生命周期）'));
  const tags = node('div', 'model-tags');
  for (const model of detail.models) tags.append(node('span', 'model-tag', model));
  if (!tags.childElementCount) tags.append(node('span', 'small muted', '模型信息未知'));
  models.append(tags, node('p', 'small muted', '模型名称来自观测元数据；主代理模型不代表全部子代理消耗。'));
  if (detailRange === 'lifetime' && detail.modelBreakdown?.length) {
    const breakdown = node('ul', 'call-list');
    for (const item of detail.modelBreakdown) {
      const entry = node('li');
      entry.append(node('span', '', `${item.model} · ${item.calls} 次 chat 观测 · ${item.unknownCalls} 次用量未知`), node('span', 'call-amount', `${measured(item.nanoAiu, item.unitVerified)} ${item.unitVerified ? 'AI Credits' : 'nano AIU'}`));
      breakdown.append(entry);
    }
    models.append(breakdown, node('p', 'small muted', '以上为生命周期内的 chat 明细，可能覆盖不完整；不再加到顶层总额中，也不代表经过对账的完整模型费用分摊。'));
  }
  fragment.append(models);
  const calls = node('section', 'detail-section');
  calls.append(node('h3', '', '顶层调用与待确认记录'));
  const events = (detail.events ?? []).filter(event => event.classification !== 'child' && (detailRange === 'lifetime' || event.endTime?.slice(0, 7) === periodInput.value));
  const list = node('ol', 'call-list');
  const classification: Record<string, string> = { root: '顶层调用', pending: '待分类 · 未计入', invalid: '异常 · 未计入', conflict: '冲突 · 未计入' };
  for (const [index, event] of events.entries()) {
    const item = node('li');
    const description = node('div');
    description.append(node('span', '', `${String(index + 1).padStart(2, '0')} · ${classification[event.classification ?? 'pending'] ?? '待确认'}`), node('time', '', dateTime(event.endTime)));
    const amount = node('div', 'call-amount', event.classification === 'root' ? `${measured(event.nanoAiu, verified)} ${unit}` : '未计入');
    if (event.nanoAiu === null) amount.textContent = '用量未知';
    item.append(description, amount);
    list.append(item);
  }
  calls.append(events.length ? list : node('p', 'small muted', '此范围暂无可展示的调用明细。'));
  fragment.append(calls);
  el('detail-body').replaceChildren(fragment);
  el('detail-month').setAttribute('aria-pressed', String(detailRange === 'month'));
  el('detail-lifetime').setAttribute('aria-pressed', String(detailRange === 'lifetime'));
}

periodInput.addEventListener('change', () => {
  if (!periodInput.validity.valid || !periodInput.value) return;
  summary = null;
  lastRead = null;
  sessionItems = [];
  sessionSignature = '';
  nextCursor = null;
  visiblePages = 1;
  text('primary-value', '—');
  text('primary-unit', '');
  text('mode', '正在读取所选月份');
  text('mode-badge', '读取中');
  text('usage-detail', '等待当前月份快照');
  text('scope', '等待所选月份数据');
  text('session-total', '');
  text('official-state', '等待所选月份数据');
  text('unit-state', '等待数据');
  text('updated-at', '正在读取所选月份');
  el('account-usage').hidden = true;
  text('period-caption', `${periodInput.value} · UTC`);
  for (const id of ['session-count', 'known-count', 'unknown-count', 'pending-count']) text(id, '—');
  el('progress-wrap').hidden = true;
  el('empty-state').hidden = true;
  el('load-more').hidden = true;
  text('sessions', '正在读取所选月份…');
  if (dialog.open) dialog.close();
  void loadDashboard();
});

el<HTMLButtonElement>('refresh').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('refresh');
  button.disabled = true;
  let refreshError: string | null = null;
  try { await mutate('/api/refresh', 'POST'); }
  catch (error) { refreshError = errorMessage(error); }
  await loadDashboard();
  if (refreshError) { el('page-message').hidden = false; text('page-message', `账户同步未完成：${refreshError}。已尝试重新读取本地快照。`); }
  button.disabled = false;
});

budgetInput.addEventListener('input', () => { budgetDirty = true; });
el<HTMLFormElement>('budget-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = budgetInput.value.trim();
  if (input && !/^\d{1,18}(?:\.\d{1,9})?$/.test(input)) {
    text('budget-feedback', '请输入非负数，整数最多 18 位，小数最多 9 位。');
    el('budget-feedback').classList.add('error');
    budgetInput.focus();
    return;
  }
  const button = el<HTMLButtonElement>('save-budget');
  button.disabled = true;
  el('budget-feedback').classList.remove('error');
  text('budget-feedback', '正在保存…');
  try {
    await mutate('/api/settings', 'PATCH', { monthlyBudget: input || null });
    budgetDirty = false;
    text('budget-feedback', input ? (BigInt(input.split('.')[0] ?? '0') === 0n && !/[1-9]/.test(input) ? '已保存 · 预算为 0，不计算百分比。' : '预算已保存。') : '已清除自定义预算。');
    await loadDashboard();
  } catch (error) {
    text('budget-feedback', `保存失败：${errorMessage(error)}`);
    el('budget-feedback').classList.add('error');
  } finally { button.disabled = false; }
});

el<HTMLButtonElement>('load-more').addEventListener('click', async () => {
  if (!nextCursor) return;
  const button = el<HTMLButtonElement>('load-more');
  const period = periodInput.value;
  const cursor = nextCursor;
  const generation = ++requestGeneration;
  refreshing = true;
  button.disabled = true;
  try {
    const page = await api<SessionPage>(`/api/sessions?period=${encodeURIComponent(period)}&sort=usage&cursor=${encodeURIComponent(cursor)}`);
    if (period !== periodInput.value || generation !== requestGeneration) return;
    const existing = new Set(sessionItems.map(item => item.id));
    sessionItems = [...sessionItems, ...page.items.filter(item => !existing.has(item.id))];
    nextCursor = page.nextCursor;
    visiblePages++;
    renderSessions();
  } catch (error) { el('page-message').hidden = false; text('page-message', `加载会话失败：${errorMessage(error)}`); }
  finally { button.disabled = false; if (generation === requestGeneration) refreshing = false; }
});

el('close-detail').addEventListener('click', () => { dialog.close(); });
dialog.addEventListener('close', () => { detailRequest++; selectedSession = null; });
el('detail-month').addEventListener('click', () => { detailRange = 'month'; renderDetail(); });
el('detail-lifetime').addEventListener('click', () => { detailRange = 'lifetime'; renderDetail(); });
void loadDashboard();
window.setInterval(() => { if (!document.hidden && !refreshing) void loadDashboard(); }, 5_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !refreshing) void loadDashboard(); });
