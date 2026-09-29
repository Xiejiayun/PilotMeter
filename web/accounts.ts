import type { AccountLogin, AccountsOverview, GitHubProfile } from '../src/shared/accounts';
import { projectPersonalQuota, type PersonalQuotaBucketView } from '../src/domain/personal-quota';

type AccountUI = {
  api: <T>(path: string) => Promise<T>;
  mutate: <T>(path: string, method: string, body?: object) => Promise<T>;
  changing: () => void;
  changed: () => Promise<void>;
};
const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const text = (id: string, value: string): void => { element(id).textContent = value; };
const message = (error: unknown): string => error instanceof Error ? error.message : '请求失败';
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (content !== undefined) result.textContent = content;
  return result;
}
function time(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
}
function exactAmount(value: string | null): string {
  if (value === null) return '未知';
  const [integer = '0', fraction] = value.split('.');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
}
function validHost(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
      && (url.pathname === '/' || !url.pathname) && (url.hostname === 'github.com' || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(url.hostname)) ? url.origin : null;
  } catch { return null; }
}

export function initializeAccounts(options: AccountUI): { load: () => Promise<AccountsOverview | null>; current: () => AccountsOverview | null } {
  let overview: AccountsOverview | null = null;
  let viewGeneration = 0;
  let busy = false;
  let loginGeneration = 0;
  let login: AccountLogin | null = null;
  let retryAccountId: string | undefined;
  let pollTimer: number | undefined;
  let removeAccount: GitHubProfile | null = null;
  const quotaChoices = new Map<string, string>();
  const expandedQuota = new Set<string>();
  const loginDialog = element<HTMLDialogElement>('github-login-dialog');
  const removeDialog = element<HTMLDialogElement>('github-remove-dialog');
  const select = element<HTMLSelectElement>('github-select');
  const hostInput = element<HTMLInputElement>('github-host');
  const activeProfile = (): GitHubProfile | undefined => overview?.accounts.find(item => item.id === overview?.activeAccountId);
  const active = (): boolean => !!login && ['starting', 'pending', 'verifying'].includes(login.status);

  function controls(): void {
    const enabled = !!overview?.enabled && !busy;
    element<HTMLButtonElement>('github-login').disabled = !enabled;
    select.disabled = !enabled;
    for (const id of ['github-refresh', 'github-reauth', 'github-remove']) element<HTMLButtonElement>(id).disabled = !enabled || !activeProfile();
    element('github-accounts').setAttribute('aria-busy', String(busy));
  }

  function quotaCard(bucket: PersonalQuotaBucketView, primary = false): HTMLElement {
    const card = node('article', `quota-bucket${primary ? ' quota-primary' : ''}`);
    card.dataset.quotaKey = bucket.key;
    const used = bucket.used ?? bucket.raw.used;
    const limit = bucket.limit ?? bucket.raw.limit;
    const hasAmounts = !bucket.unlimited && (used !== null || limit !== null);
    const value = hasAmounts ? `${exactAmount(used)}${limit === null ? '' : ` / ${exactAmount(limit)}`}` : bucket.value;
    card.append(node('h4', '', bucket.label), node('p', 'quota-value', value));
    if (hasAmounts) card.append(node('p', 'quota-caption', limit === null ? '已用' : '已用 / 总额'));
    if (bucket.usedPercentage !== null) card.append(node('p', 'quota-percentage', `当前周期已用 ${bucket.usedPercentage}%`));
    if (bucket.percentage !== null) {
      const progress = node('progress', 'quota-progress');
      progress.max = 100; progress.value = bucket.percentage;
      progress.setAttribute('aria-label', `${bucket.label}已用比例`);
      if (bucket.usedPercentage !== null) progress.setAttribute('aria-valuetext', `${bucket.usedPercentage}%`);
      card.append(progress);
    }
    if (bucket.unit === 'unspecified') {
      card.append(node('p', 'quota-amount', '原始数值 · 单位未确认'));
      if (bucket.unlimited && used !== null) card.append(node('p', 'quota-amount', `原始已用 (used)：${exactAmount(used)}`));
    }
    if (bucket.unit !== 'unspecified' || !hasAmounts && !bucket.unlimited || bucket.detail.includes('；已超出固定额度') || limit === '0') {
      card.append(node('p', 'quota-amount', bucket.detail));
    }
    if (bucket.nextResetAt) card.append(node('p', 'small muted', `下次重置 ${time(bucket.nextResetAt)}`));
    return card;
  }

  function renderQuota(profile: GitHubProfile | undefined): void {
    if (!overview) return;
    element('personal-quota').hidden = !profile;
    const container = element('quota-buckets');
    const restoreFocus = document.activeElement?.id === 'quota-category';
    const restoreOtherFocus = document.activeElement?.matches('.quota-other > summary');
    container.replaceChildren();
    if (!profile) return;
    const quota = profile.status !== 'reauth-required' && overview.quota?.accountId === profile.id
      && overview.quota.scope === 'signed-in-user' ? overview.quota : null;
    const personal = projectPersonalQuota(quota, Date.now(), quotaChoices.get(profile.id));
    const status = profile.status === 'reauth-required' ? '登录已失效，请重新登录后同步额度。'
      : quota?.state === 'error' || quota?.error || profile.status === 'error' ? '同步失败；请重试。'
        : overview.refreshing ? '正在同步…' : personal.stale && personal.buckets.length ? '待同步'
          : personal.buckets.length ? '已同步' : '尚未取得此账号的 Copilot 额度；用量未知，不代表零消耗。';
    text('quota-status', `${personal.stale && personal.buckets.length ? '旧快照 · ' : ''}${status}${personal.fetchedAt ? ` · ${time(personal.fetchedAt)}` : ''}`);
    if (personal.selection === 'required' || personal.selection === 'explicit') {
      const field = node('label', 'quota-choice', '查看额度类别');
      const choice = node('select', ''); choice.id = 'quota-category';
      const placeholder = node('option', '', '选择一个类别'); placeholder.value = '';
      choice.append(placeholder);
      for (const bucket of personal.buckets) {
        const option = node('option', '', bucket.label); option.value = bucket.key; choice.append(option);
      }
      choice.value = personal.selection === 'explicit' ? personal.primary!.key : '';
      choice.addEventListener('change', () => {
        if (choice.value) quotaChoices.set(profile.id, choice.value); else quotaChoices.delete(profile.id);
        renderQuota(profile);
      });
      field.append(choice); container.append(field);
      if (personal.selection === 'required') container.append(node('p', 'small muted', '这些额度类别独立计算，请选择查看；不合并数量或比例。'));
    }
    if (personal.primary) container.append(quotaCard(personal.primary, true));
    const others = personal.buckets.filter(bucket => bucket !== personal.primary);
    if (others.length) {
      const list = node('div', 'quota-secondary-list');
      for (const bucket of others) list.append(quotaCard(bucket));
      if (personal.primary || personal.selection === 'none') {
        const details = node('details', 'quota-other');
        details.open = expandedQuota.has(profile.id);
        details.append(node('summary', '', '其他额度'), list);
        details.addEventListener('toggle', () => {
          if (!details.isConnected) return;
          if (details.open) expandedQuota.add(profile.id); else expandedQuota.delete(profile.id);
        });
        if (!personal.primary) container.append(node('p', 'quota-unlimited-summary', '各类别无固定上限'));
        container.append(details);
      } else container.append(list);
    }
    if (restoreFocus) element<HTMLSelectElement>('quota-category')?.focus();
    else if (restoreOtherFocus) container.querySelector<HTMLElement>('.quota-other > summary')?.focus();
  }

  function render(): void {
    if (!overview) return;
    const profile = activeProfile();
    text('github-title', profile ? `@${profile.login}` : '连接你的 GitHub 账号');
    text('github-description', profile ? `${new URL(profile.host).hostname} · ${profile.status === 'connected' ? '已连接' : profile.status === 'reauth-required' ? '登录已失效，请重新登录' : '账号连接异常，请重试'}` : '登录后查看当前账号的 Copilot 额度。可添加个人、工作等多个账号。');
    const pendingLogin = overview.login && ['starting', 'pending', 'verifying'].includes(overview.login.status);
    text('github-login', pendingLogin ? '继续登录' : overview.accounts.length ? '添加账号' : '登录 GitHub');
    element('github-controls').hidden = !overview.accounts.length;
    const signature = JSON.stringify(overview.accounts.map(item => [item.id, item.login, item.host]));
    if (select.dataset.signature !== signature) {
      const all = node('option', '', '全部本机记录（所有账号）'); all.value = '';
      const choices = overview.accounts.map(item => { const option = node('option', '', `${item.login} · ${new URL(item.host).hostname}`); option.value = item.id; return option; });
      select.replaceChildren(...choices, all);
      select.dataset.signature = signature;
    }
    select.value = profile?.id ?? '';
    text('github-scope', profile ? `当前账号：${profile.login}。下方显示以此账号启动采集的本机记录；切换账号不会移动或重新归属历史记录。` : '当前显示全部本机记录，包含所有账号及未分账号的旧记录；不能将这些记录当作某个 GitHub 账号的消费。');
    text('github-run-command', overview.runCommand);
    element<HTMLButtonElement>('copy-run-command').disabled = !overview.enabled;
    if (!overview.enabled) text('github-feedback', '演示模式使用虚构数据，账号登录已停用。请在真实服务中连接账号。');
    else if (!busy) text('github-feedback', '');
    renderQuota(profile);
    controls();
  }

  async function load(): Promise<AccountsOverview | null> {
    const generation = ++viewGeneration;
    try {
      const result = await options.api<AccountsOverview>('/api/auth/accounts');
      if (generation !== viewGeneration) return null;
      overview = result;
      render();
      return result;
    } catch (error) {
      if (generation !== viewGeneration) return null;
      text('github-feedback', `账号连接读取失败：${message(error)}。下方本机记录仍可查看。`);
      if (overview?.activeAccountId) text('quota-status', '账号服务暂时无法读取，保留上次额度快照；请恢复连接后同步。');
      element('github-accounts').setAttribute('aria-busy', 'false');
      return null;
    }
  }

  async function changeScope(action: () => Promise<AccountsOverview>): Promise<void> {
    if (busy) return;
    busy = true;
    viewGeneration++;
    options.changing();
    element('personal-quota').hidden = true;
    element('quota-buckets').replaceChildren();
    controls();
    text('github-feedback', '正在切换账号…');
    let failure: string | null = null;
    try { overview = await action(); render(); }
    catch (error) { failure = message(error); }
    finally {
      busy = false;
      controls();
      await options.changed();
      if (failure) text('github-feedback', `账号操作未完成：${failure}`);
    }
  }

  function loginStatus(content: string, state = 'pending'): void {
    text('login-status', content);
    element('login-status').dataset.state = state;
  }

  function renderLogin(value: AccountLogin): void {
    const newCode = !!value.userCode && login?.userCode !== value.userCode;
    if (newCode) text('copy-code-feedback', '');
    login = value;
    const codeAvailable = !!value.userCode && !!value.verificationUri && active();
    const link = element<HTMLAnchorElement>('github-verification-link');
    let safeLink: URL | null = null;
    try {
      const candidate = new URL(value.verificationUri ?? '');
      if (validHost(value.host) && candidate.origin === value.host && candidate.protocol === 'https:' && !candidate.username && !candidate.password && candidate.pathname === '/login/device') safeLink = candidate;
    } catch { /* Do not expose untrusted verification URLs as navigation targets. */ }
    element('device-login').hidden = !codeAvailable;
    link.hidden = !safeLink;
    if (safeLink) link.href = safeLink.href; else link.removeAttribute('href');
    text('github-user-code', value.userCode ?? '');
    text('login-expiry', value.expiresAt ? `验证码有效至 ${time(value.expiresAt)}` : '请在 GitHub 提示的有效期内完成授权。');
    const statuses: Record<AccountLogin['status'], string> = {
      starting: '正在向 GitHub 请求验证码…',
      pending: '等待 GitHub 授权。请完成第 2 步，授权后这里会自动继续。',
      verifying: 'GitHub 授权已收到，正在确认账号，请稍候…',
      complete: '登录成功，正在读取账号…',
      cancelled: '登录已取消。点击“重新获取验证码”可再次登录。',
      failed: `登录未完成。${value.error?.message ? ` ${value.error.message}` : ''} 请按提示处理后，点击“重新获取验证码”再试一次。`,
      expired: '验证码已过期。请点击“重新获取验证码”，复制新码后再到 GitHub 授权。',
    };
    loginStatus(codeAvailable && !safeLink ? '授权地址无法验证。请取消此次登录，然后重新获取验证码。' : statuses[value.status], codeAvailable && !safeLink ? 'failed' : value.status);
    element('retry-github-login').hidden = !['failed', 'expired', 'cancelled'].includes(value.status);
    if (newCode && codeAvailable) element<HTMLButtonElement>('copy-github-code').focus();
  }

  async function pollLogin(id: string, generation: number): Promise<void> {
    if (generation !== loginGeneration || !loginDialog.open) return;
    try {
      const result = await options.api<AccountLogin>(`/api/auth/login/${encodeURIComponent(id)}`);
      if (generation !== loginGeneration || !loginDialog.open) return;
      renderLogin(result);
      if (result.status === 'complete') {
        loginDialog.close();
        await changeScope(() => options.api<AccountsOverview>('/api/auth/accounts'));
        text('github-feedback', '登录成功，已切换到此账号。');
        return;
      }
      if (!active()) return;
    } catch (error) {
      if (generation !== loginGeneration || !loginDialog.open) return;
      loginStatus(`暂时无法确认登录状态：${message(error)}。请检查 PilotMeter 本地服务是否运行；连接恢复后会自动重试。`, 'interrupted');
    }
    pollTimer = window.setTimeout(() => { void pollLogin(id, generation); }, 1_000);
  }

  async function startLogin(): Promise<void> {
    const host = validHost(hostInput.value.trim());
    if (!host) { loginStatus('请输入 https://github.com 或 https://你的企业.ghe.com。', 'failed'); hostInput.focus(); return; }
    const generation = ++loginGeneration;
    window.clearTimeout(pollTimer);
    login = null;
    element('github-host-form').hidden = true;
    element('device-login').hidden = true;
    element('retry-github-login').hidden = true;
    text('copy-code-feedback', '');
    loginStatus('正在向 GitHub 请求验证码…', 'starting');
    try {
      const result = await options.mutate<AccountLogin>('/api/auth/login', 'POST', { host, ...(retryAccountId ? { accountId: retryAccountId } : {}) });
      if (generation !== loginGeneration || !loginDialog.open) {
        if (['starting', 'pending', 'verifying'].includes(result.status)) await options.mutate(`/api/auth/login/${encodeURIComponent(result.id)}/cancel`, 'POST').catch(() => {});
        return;
      }
      renderLogin(result);
      await pollLogin(result.id, generation);
    } catch (error) {
      if (generation !== loginGeneration || !loginDialog.open) return;
      loginStatus(`无法开始登录：${message(error)}。请检查网络与 GitHub 地址，然后点击“获取登录验证码”重试。`, 'failed');
      element('github-host-form').hidden = false;
    }
  }

  function openLogin(profile?: GitHubProfile): void {
    if (!overview?.enabled || busy) return;
    retryAccountId = profile?.id;
    login = null;
    loginGeneration++;
    window.clearTimeout(pollTimer);
    hostInput.value = profile?.host ?? 'https://github.com';
    hostInput.disabled = !!profile;
    text('login-title', profile ? `重新登录 @${profile.login}` : overview.accounts.length ? '添加 GitHub 账号' : '登录 GitHub');
    text('login-account-hint', profile ? `在新标签页输入验证码，并确认登录的是 @${profile.login}，再同意授权。` : '在新标签页输入验证码，确认要连接的 GitHub 账号，再同意授权。');
    loginStatus(profile ? `即将重新连接 @${profile.login}。请先获取本次登录验证码。` : '点击“获取登录验证码”开始，随后按下面的步骤完成授权。', 'ready');
    text('copy-code-feedback', '');
    element('github-host-form').hidden = false;
    element('device-login').hidden = true;
    element('retry-github-login').hidden = true;
    loginDialog.showModal();
    if (overview.login && ['starting', 'pending', 'verifying'].includes(overview.login.status)) {
      hostInput.value = overview.login.host;
      element('github-host-form').hidden = true;
      renderLogin(overview.login);
      void pollLogin(overview.login.id, loginGeneration);
      return;
    }
    element<HTMLButtonElement>('start-github-login').focus();
  }

  async function cancelLogin(): Promise<void> {
    const pending = active() ? login : null;
    loginGeneration++;
    window.clearTimeout(pollTimer);
    login = null;
    if (loginDialog.open) loginDialog.close();
    if (pending) {
      try {
        const result = await options.mutate<AccountLogin>(`/api/auth/login/${encodeURIComponent(pending.id)}/cancel`, 'POST');
        if (result.status === 'complete') await changeScope(() => options.api<AccountsOverview>('/api/auth/accounts'));
        else if (overview) { overview.login = result; render(); }
      } catch (error) { text('github-feedback', `未能确认登录取消：${message(error)}。请勿继续使用刚才的验证码。`); }
    }
  }

  async function copy(value: string, feedback: string): Promise<void> {
    try { await navigator.clipboard.writeText(value); text(feedback, '已复制。'); }
    catch { text(feedback, '未能访问剪贴板，请选中文字后复制。'); }
  }
  element('github-login').addEventListener('click', () => { openLogin(); });
  element('github-reauth').addEventListener('click', () => { openLogin(activeProfile()); });
  element<HTMLFormElement>('github-host-form').addEventListener('submit', event => { event.preventDefault(); void startLogin(); });
  element('retry-github-login').addEventListener('click', () => { void startLogin(); });
  for (const id of ['close-github-login', 'cancel-github-login']) element(id).addEventListener('click', () => { void cancelLogin(); });
  loginDialog.addEventListener('cancel', event => { event.preventDefault(); void cancelLogin(); });
  element('copy-github-code').addEventListener('click', () => { if (login?.userCode) void copy(login.userCode, 'copy-code-feedback'); });
  element('copy-run-command').addEventListener('click', () => { if (overview) void copy(overview.runCommand, 'copy-command-feedback'); });
  select.addEventListener('change', () => { const accountId = select.value || null; void changeScope(() => options.mutate<AccountsOverview>('/api/auth/select', 'POST', { accountId })); });
  element('github-refresh').addEventListener('click', async () => {
    if (busy) return;
    const generation = ++viewGeneration;
    const expectedAccount = overview?.activeAccountId;
    element<HTMLButtonElement>('github-refresh').disabled = true;
    text('quota-status', '正在同步当前账号的 Copilot 额度…');
    try {
      const result = await options.mutate<AccountsOverview>('/api/auth/refresh', 'POST');
      if (generation !== viewGeneration || expectedAccount !== overview?.activeAccountId) return;
      overview = result; render();
    } catch (error) { if (generation === viewGeneration) text('quota-status', `同步未完成：${message(error)}`); }
    finally { if (generation === viewGeneration) controls(); }
  });
  element('github-remove').addEventListener('click', () => {
    removeAccount = activeProfile() ?? null;
    if (!removeAccount) return;
    text('remove-description', `移除 ${removeAccount.login}（${new URL(removeAccount.host).hostname}）的登录连接？`);
    text('remove-feedback', '');
    removeDialog.showModal();
    element<HTMLButtonElement>('cancel-github-remove').focus();
  });
  for (const id of ['close-github-remove', 'cancel-github-remove']) element(id).addEventListener('click', () => { removeDialog.close(); });
  element('confirm-github-remove').addEventListener('click', () => {
    if (!removeAccount) return;
    const id = removeAccount.id;
    removeDialog.close();
    void changeScope(() => options.mutate<AccountsOverview>(`/api/auth/accounts/${encodeURIComponent(id)}`, 'DELETE'));
  });
  return { load, current: () => overview };
}
