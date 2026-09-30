import type { AccountLogin, AccountsOverview, GitHubProfile } from '../src/shared/accounts';
import { element, errorMessage, timestamp } from './desktop-ui';

type LoginOptions = {
  api: <T>(path: string) => Promise<T>;
  mutate: <T>(path: string, method: string, body?: object) => Promise<T>;
  permitted: () => boolean;
  existing: () => AccountLogin | null;
  changed: () => Promise<void>;
  feedback: (message: string, error?: boolean) => void;
  notify: (reason: 'login-complete' | 'login-failed' | 'login-expired', eventId: string, epoch: number) => void;
  external: (url: string, loginId: string) => void;
  acquire: () => Promise<() => void>;
  epoch: () => number;
};

function validHost(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname === '/' && (url.hostname === 'github.com' || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(url.hostname)) ? url.origin : null;
  } catch { return null; }
}

export function initializeDesktopLogin(options: LoginOptions): { open: (profile?: GitHubProfile) => void; invalidate: () => void } {
  const dialog = element<HTMLDialogElement>('login-dialog');
  const host = element<HTMLInputElement>('login-host');
  const code = element('login-code');
  const status = element('login-status');
  const retry = element<HTMLButtonElement>('login-retry');
  const copy = element<HTMLButtonElement>('copy-login-code');
  const authorize = element<HTMLButtonElement>('open-github');
  let login: AccountLogin | null = null;
  let generation = 0;
  let timer: number | undefined;
  let expiryTimer: number | undefined;
  let profileId: string | undefined;
  let starting = false;
  let startSettled: Promise<void> | null = null;
  let cancelPending: Promise<unknown> | null = null;
  let heldRelease: (() => void) | null = null;
  let notice: { eventId: string; epoch: number; sent: boolean } | null = null;
  const notify = (reason: 'login-complete' | 'login-failed' | 'login-expired', event = notice) => {
    if (!event || event.sent || event.epoch !== options.epoch()) return;
    event.sent = true;
    options.notify(reason, event.eventId, event.epoch);
  };
  const active = (value: AccountLogin | null) => !!value && ['starting', 'pending', 'verifying'].includes(value.status);
  const current = (operation: number) => operation === generation && dialog.open;
  const setStatus = (text: string, state: string) => { status.textContent = text; status.dataset.state = state; };
  const resetCode = () => { code.textContent = '···· ····'; copy.disabled = true; authorize.disabled = true; element('login-copy-feedback').textContent = '验证码只用于本次登录。'; };
  const releaseOwner = () => { heldRelease?.(); heldRelease = null; };
  const clearTimers = () => { window.clearTimeout(timer); window.clearTimeout(expiryTimer); };
  const hasExpired = (value: AccountLogin) => !!value.expiresAt && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) <= Date.now();
  const matchesTarget = (value: AccountLogin, selectedHost: string, targetId: string | undefined) => value.host === selectedHost
    && (value.targetAccountId ?? null) === (targetId ?? null);

  function verifiedUrl(value: AccountLogin | null): string | null {
    if (!value || !active(value) || hasExpired(value) || !value.verificationUri || !value.userCode) return null;
    try {
      const url = new URL(value.verificationUri);
      const origin = validHost(value.host);
      return origin && url.origin === origin && url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/login/device' && !url.search && !url.hash ? url.href : null;
    } catch { return null; }
  }

  function render(value: AccountLogin): void {
    window.clearTimeout(expiryTimer);
    if (active(value) && value.status !== 'verifying' && hasExpired(value)) value = { ...value, status: 'expired', userCode: null, verificationUri: null };
    const oldCode = login?.userCode;
    login = value;
    if (oldCode !== value.userCode) element('login-copy-feedback').textContent = '验证码只用于本次登录。';
    const usable = active(value) && !!value.userCode;
    code.textContent = usable ? value.userCode! : '···· ····';
    copy.disabled = !usable;
    authorize.disabled = !verifiedUrl(value);
    retry.hidden = !['failed', 'expired', 'cancelled'].includes(value.status);
    retry.disabled = false;
    const messages: Record<AccountLogin['status'], string> = {
      starting: '正在向 GitHub 获取验证码…',
      pending: '等待你在 GitHub 授权，完成后会自动连接。',
      verifying: '已收到授权，正在确认账号…',
      complete: '登录成功，正在读取账号和额度…',
      failed: `登录未完成。${value.error?.message ?? '请重新获取验证码后再试。'}`,
      expired: '验证码已过期。请重新获取验证码，再到 GitHub 授权。',
      cancelled: '这次登录已取消，可以重新获取验证码。',
    };
    setStatus(usable && !verifiedUrl(value) ? '无法验证 GitHub 授权地址，请重新获取验证码。' : messages[value.status], usable && !verifiedUrl(value) ? 'failed' : value.status);
    if (value.status === 'failed' || value.status === 'expired') notify(value.status === 'expired' ? 'login-expired' : 'login-failed');
    if (usable && !verifiedUrl(value)) retry.hidden = false;
    element('login-expiry').textContent = active(value) && value.expiresAt ? `有效至 ${timestamp(value.expiresAt, true)}` : '';
    if (active(value) && value.expiresAt && value.status !== 'verifying' && Number.isFinite(Date.parse(value.expiresAt))) {
      const operation = generation;
      expiryTimer = window.setTimeout(() => {
        if (!current(operation) || !login || login.id !== value.id) return;
        window.clearTimeout(timer);
        render({ ...login, status: 'expired', userCode: null, verificationUri: null });
        releaseOwner();
      }, Math.max(0, Math.min(2147483647, Date.parse(value.expiresAt) - Date.now())));
    }
    if (!active(value)) releaseOwner();
  }

  async function complete(operation: number): Promise<void> {
    if (!current(operation)) return;
    notify('login-complete');
    clearTimers();
    generation++;
    dialog.close();
    login = null;
    releaseOwner();
    // Authorization is complete; the desktop loader owns any subsequent data
    // error. Do not overwrite its outcome with a stale progress message.
    options.feedback('账号已连接。');
    await options.changed();
  }

  async function poll(id: string, operation: number): Promise<void> {
    if (!current(operation) || !active(login)) return;
    try {
      const value = await options.api<AccountLogin>(`/api/auth/login/${encodeURIComponent(id)}`);
      if (!current(operation)) return;
      render(value);
      if (value.status === 'complete') { await complete(operation); return; }
      if (!active(login)) return;
    } catch (error) {
      if (!current(operation) || !active(login)) return;
      setStatus(`暂时无法确认授权：${errorMessage(error)}。连接恢复后会自动重试。`, 'interrupted');
    }
    if (current(operation)) timer = window.setTimeout(() => { void poll(id, operation); }, 1000);
  }

  async function start(): Promise<void> {
    if (starting || !dialog.open || !options.permitted()) return;
    const selectedHost = validHost(host.value.trim());
    if (!selectedHost) { setStatus('请输入 https://github.com 或 https://你的企业.ghe.com。', 'failed'); element<HTMLDetailsElement>('login-host-options').open = true; host.focus(); return; }
    const targetId = profileId;
    const operation = ++generation;
    const operationEpoch = options.epoch();
    notice = { eventId: crypto.randomUUID(), epoch: operationEpoch, sent: false };
    clearTimers();
    const previous = login?.status !== 'complete' ? login : null;
    login = null;
    starting = true;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    startSettled = settled;
    retry.hidden = true;
    resetCode();
    setStatus('正在向 GitHub 获取验证码…', 'starting');
    element('login-expiry').textContent = '';
    try {
      if (cancelPending) await cancelPending;
      if (!current(operation)) return;
      if (!heldRelease) {
        const release = await options.acquire();
        if (!current(operation) || operationEpoch !== options.epoch()) { release(); return; }
        heldRelease = release;
      }
      if (previous) {
        const cancelled = await options.mutate<AccountLogin>(`/api/auth/login/${encodeURIComponent(previous.id)}/cancel`, 'POST');
        if (!current(operation) || operationEpoch !== options.epoch()) return;
        if (cancelled.status === 'complete' && matchesTarget(cancelled, selectedHost, targetId)
          && (!targetId || cancelled.accountId === targetId)) { await complete(operation); return; }
      }
      if (!current(operation)) return;
      let result: AccountLogin | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await options.mutate<AccountLogin>('/api/auth/login', 'POST', { host: selectedHost, ...(targetId ? { accountId: targetId } : {}) });
          break;
        } catch (error) {
          // A lost response may still have created a device flow. Reauthentication
          // is recoverable only when the server confirms the exact target account.
          if (!current(operation) || operationEpoch !== options.epoch()) throw error;
          const recovered = await options.api<AccountsOverview>('/api/auth/accounts').catch(() => null);
          if (!current(operation) || operationEpoch !== options.epoch()) throw error;
          if (!recovered?.login || !active(recovered.login)) throw error;
          if (matchesTarget(recovered.login, selectedHost, targetId)) { result = recovered.login; break; }
          if (attempt !== 0) throw new Error('检测到其他账号的登录流程，请取消后重新连接。');
          // A different in-progress flow cannot authenticate this dialog's target.
          // Retire it once, then start the requested flow; never loop on HTTP 409.
          await options.mutate<AccountLogin>(`/api/auth/login/${encodeURIComponent(recovered.login.id)}/cancel`, 'POST');
          if (!current(operation) || operationEpoch !== options.epoch()) return;
        }
      }
      if (!result) throw new Error('未能取得本次登录状态，请重试。');
      if (!current(operation)) {
        if (active(result) && operationEpoch === options.epoch()) {
          await options.mutate(`/api/auth/login/${encodeURIComponent(result.id)}/cancel`, 'POST').catch(() => {});
        }
        return;
      }
      render(result);
      if (result.status === 'complete') await complete(operation);
      else if (active(result)) void poll(result.id, operation);
    } catch (error) {
      if (!current(operation)) return;
      setStatus(`暂时无法开始登录：${errorMessage(error)}。请重试。`, 'failed');
      notify('login-failed');
      retry.hidden = false;
      releaseOwner();
    } finally {
      if (current(operation)) starting = false;
      settle();
      if (startSettled === settled) startSettled = null;
    }
  }

  function open(profile?: GitHubProfile): void {
    if (!options.permitted()) { options.feedback('设计预览不连接真实账号，请在普通桌面应用中登录。'); return; }
    if (dialog.open) return;
    generation++;
    starting = false;
    clearTimers();
    login = null;
    notice = { eventId: crypto.randomUUID(), epoch: options.epoch(), sent: false };
    profileId = profile?.id;
    host.value = profile?.host ?? 'https://github.com';
    host.disabled = !!profile;
    element<HTMLDetailsElement>('login-host-options').open = false;
    element('login-title').textContent = profile ? `重新连接 @${profile.login}` : '连接你的 GitHub 账号';
    element('login-account-hint').textContent = profile ? `请在 GitHub 确认登录的是 @${profile.login}，再同意授权。` : '在 GitHub 完成安全授权，PilotMeter 会自动连接。';
    retry.hidden = true;
    resetCode();
    setStatus('正在准备登录…', 'starting');
    dialog.showModal();
    const pending = !cancelPending && options.existing();
    if (pending && active(pending) && matchesTarget(pending, host.value, profileId)) {
      host.value = pending.host;
      render(pending);
      const operation = generation;
      const operationEpoch = options.epoch();
      void options.acquire().then(release => {
        if (!current(operation) || operationEpoch !== options.epoch() || !active(login)) { release(); return; }
        heldRelease = release;
        void poll(pending.id, operation);
      }, error => { if (current(operation)) { setStatus(errorMessage(error), 'failed'); retry.hidden = false; } });
    } else { if (pending && active(pending)) login = pending; void start(); }
  }

  function close(): void {
    const pending = active(login) ? login : null;
    const pendingNotice = notice;
    const pendingStart = starting ? startSettled : null;
    const operation = ++generation;
    const operationEpoch = options.epoch();
    starting = false;
    clearTimers();
    login = null;
    dialog.close();
    const release = heldRelease;
    heldRelease = null;
    if (pending) {
      const request = (async () => {
        const cancelRelease = release ?? await options.acquire();
        try {
          if (operationEpoch !== options.epoch()) return;
          const result = await options.mutate<AccountLogin>(`/api/auth/login/${encodeURIComponent(pending.id)}/cancel`, 'POST');
          if (result.status === 'complete' && operationEpoch === options.epoch()) {
            cancelRelease();
            if (operation === generation) { options.feedback('GitHub 授权已完成，账号已连接。'); notify('login-complete', pendingNotice); }
            await options.changed();
          }
        } finally { cancelRelease(); }
      })().catch(error => { if (operation === generation) options.feedback(`未能确认取消：${errorMessage(error)}。请不要继续使用刚才的验证码。`, true); });
      cancelPending = request;
      void request.finally(() => { if (cancelPending === request) cancelPending = null; });
    } else if (pendingStart) {
      const request = pendingStart.finally(() => { release?.(); });
      cancelPending = request;
      void request.finally(() => { if (cancelPending === request) cancelPending = null; });
    } else { release?.(); }
  }

  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLElement>('[data-login-action]')?.dataset.loginAction;
    if (action === 'close') close();
    if (action === 'retry') void start();
    if (action === 'authorize') { const url = verifiedUrl(login); if (url && login) options.external(url, login.id); }
    if (action === 'copy' && login?.userCode && active(login) && !hasExpired(login)) {
      const operation = generation;
      void navigator.clipboard.writeText(login.userCode).then(() => { if (current(operation)) element('login-copy-feedback').textContent = '验证码已复制。现在前往 GitHub 授权。'; }, () => { if (current(operation)) element('login-copy-feedback').textContent = '无法访问剪贴板，请选中上方验证码手动复制。'; });
    }
  });
  element<HTMLFormElement>('login-host-form').addEventListener('submit', event => { event.preventDefault(); void start(); });
  return { open, invalidate: () => { generation++; starting = false; clearTimers(); login = null; releaseOwner(); if (dialog.open) { resetCode(); setStatus('本机服务已切换，请重新获取验证码。', 'interrupted'); retry.hidden = false; } } };
}
