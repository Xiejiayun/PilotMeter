import { projectPersonalQuota } from '../../dist/domain/personal-quota.js';
import { VERSION } from '../../dist/shared/runtime.js';

// Synthetic account data. The presentation is produced by the same projection
// as /api/desktop, keeping browser tests on the actual daemon DTO contract.
export const aliceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const bobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const desktopIdentity = { app: 'pilotmeter', version: VERSION, instanceId: '11111111-1111-4111-8111-111111111111' };
export const desktopCsrf = 'synthetic-desktop-csrf';

export function pendingDesktopLogin(data, overrides = {}) {
  data.loginStarts++;
  const id = `cccccccc-cccc-4ccc-8ccc-${String(data.loginStarts).padStart(12, '0')}`;
  data.login = { id, status: 'pending', host: 'https://github.com', verificationUri: 'https://github.com/login/device',
    userCode: data.loginStarts === 1 ? 'ABCD-1234' : 'WXYZ-9876', targetAccountId: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), accountId: null, error: null, ...overrides };
  data.logins.set(id, data.login);
  return data.login;
}

export function desktopFixture({ accounts = true, unit = 'ai-credits' } = {}) {
  const now = new Date().toISOString();
  const profile = (id, login) => ({ id, login, host: 'https://github.com', status: 'connected', createdAt: now, checkedAt: now });
  const quota = (accountId, used, limit) => ({
    accountId, state: 'available', scope: 'signed-in-user', fetchedAt: now, stale: false, error: null,
    buckets: [{ key: 'premium_interactions', label: 'Premium interactions', unit, used, limit,
      usedPercentage: accountId === aliceId ? '12.5' : '44', remainingPercentage: accountId === aliceId ? '87.5' : '56', unlimited: false,
      resetAt: new Date(Date.now() + 86_400_000).toISOString(), providerUpdatedAt: now }],
  });
  const model = (id, name, status, values = {}) => ({
    id, name, status, reason: status === 'disabled' ? '组织策略停用' : status === 'unknown' ? '尚未确认可用性' : '账号可用',
    policyState: status === 'disabled' ? 'disabled' : status === 'unknown' ? null : 'enabled',
    vision: false, reasoningEffort: false, contextWindowTokens: 128000, multiplier: '1', ...values,
  });
  const models = accountId => ({
    accountId, state: 'available', source: 'copilot-cli-models.list', fetchedAt: now, stale: false, refreshing: false, error: null,
    items: accountId === aliceId ? [
      model('alpha-vision', 'Alpha Vision', 'available', { vision: true, reasoningEffort: true }),
      model('beta-reasoner', 'Beta Reasoner', 'disabled', { reasoningEffort: true, multiplier: '2' }),
      model('gamma-unknown', 'Gamma Unknown', 'unknown', { multiplier: null }),
    ] : [model('bob-model', 'Bob Private Model', 'available')],
  });
  return {
    identity: { ...desktopIdentity },
    accounts: accounts ? [profile(aliceId, 'alice-work'), profile(bobId, 'bob-personal')] : [],
    activeAccountId: accounts ? aliceId : null,
    quotas: { [aliceId]: quota(aliceId, '123.456789012345678901', '987.654312098765431208'), [bobId]: quota(bobId, '44', '100') },
    modelSets: { [aliceId]: models(aliceId), [bobId]: models(bobId) },
    enabled: true, refreshing: false, login: null, logins: new Map(), loginStarts: 0,
    requests: [], replies: new Map(), nextLogin: null, overrideDesktop: null,
  };
}

export function desktopSnapshot(data, quotaKey = null) {
  const id = data.activeAccountId;
  const account = data.accounts.find(item => item.id === id);
  const quota = account && account.status !== 'reauth-required' && data.quotas[id]?.accountId === id ? data.quotas[id] : null;
  const models = account && account.status !== 'reauth-required' && data.modelSets[id]?.accountId === id ? data.modelSets[id] : null;
  const now = new Date().toISOString();
  return {
    ...data.identity, accounts: data.accounts, activeAccountId: id, login: data.login, enabled: data.enabled, refreshing: data.refreshing,
    quota: quota && { accountId: id, state: quota.state, fetchedAt: quota.fetchedAt, stale: quota.stale, error: quota.error },
    presentation: projectPersonalQuota(quota, Date.now(), quotaKey), models,
    local: { accountId: id, source: 'local-otel', scope: id ? '当前账号的本机记录' : '未分账号的本机记录',
      period: now.slice(0, 7), nanoAiu: id === aliceId ? '123000000000' : id === bobId ? '44000000000' : null,
      credits: id === aliceId ? '123' : id === bobId ? '44' : null, unitVerified: Boolean(id),
      knownCalls: id ? 2 : 0, unknownCalls: 0, pendingCalls: 0, sessionCount: id ? 1 : 0,
      coverage: id ? 'partial' : 'empty', retained: false, updatedAt: now },
  };
}

function accountOverview(data) {
  return { accounts: data.accounts, activeAccountId: data.activeAccountId, quota: data.quotas[data.activeAccountId] ?? null,
    models: data.modelSets[data.activeAccountId] ?? null, login: data.login, enabled: data.enabled, refreshing: data.refreshing,
    runCommand: 'pilotmeter run --' };
}

export function queueDesktopReply(data, path, { method = 'GET', json, status = 200, hold = false, abort } = {}) {
  let release; let notify;
  const gate = hold ? new Promise(resolve => { release = resolve; }) : null;
  const arrived = new Promise(resolve => { notify = resolve; });
  const key = `${method} ${path}`;
  const replies = data.replies.get(key) ?? [];
  replies.push({ gate, notify, json, status, abort }); data.replies.set(key, replies);
  return { arrived, release: () => release?.() };
}

export async function mockDesktop(page, data, { bridge = false } = {}) {
  if (bridge) await page.addInitScript(() => {
    const listeners = new Set();
    window.__desktopBridgeMessages = [];
    window.__desktopAutoAcknowledge = true;
    window.__desktopBridgeReceive = message => { for (const listener of listeners) listener({ data: message }); };
    window.chrome ??= {};
    window.chrome.webview = {
      addEventListener: (name, listener) => { if (name === 'message') listeners.add(listener); },
      removeEventListener: (name, listener) => { if (name === 'message') listeners.delete(listener); },
      postMessage: message => {
        window.__desktopBridgeMessages.push(message);
        if (message.type === 'account-mutation' && window.__desktopAutoAcknowledge) queueMicrotask(() => {
          window.__desktopBridgeReceive({ type: 'account-mutation-state', pending: message.pending,
            operationId: message.operationId, epoch: message.epoch });
        });
      },
    };
  });
  await page.route('**/health', route => route.fulfill({ json: data.identity }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON();
    data.requests.push({ path, query: url.searchParams.toString(), method, body, headers: request.headers() });
    const queued = data.replies.get(`${method} ${path}`)?.shift();
    let json; let status = queued?.status ?? 200;
    if (queued?.json !== undefined) json = queued.json;
    else if (path === '/api/session') json = { csrfToken: desktopCsrf };
    else if (path === '/api/desktop') json = data.overrideDesktop ?? desktopSnapshot(data, url.searchParams.get('quotaKey'));
    else if (path === '/api/auth/accounts') json = accountOverview(data);
    else if (path === '/api/auth/select') {
      data.activeAccountId = body.accountId; json = accountOverview(data);
    } else if (path === '/api/auth/refresh') json = accountOverview(data);
    else if (path === '/api/auth/login' && method === 'POST') {
      json = pendingDesktopLogin(data, { host: body.host ?? 'https://github.com',
        verificationUri: `${body.host ?? 'https://github.com'}/login/device`, targetAccountId: body.accountId ?? null, ...data.nextLogin });
      data.nextLogin = null;
    } else if (/^\/api\/auth\/login\/[a-f0-9-]+(?:\/cancel)?$/.test(path)) {
      const id = path.split('/')[4];
      const login = data.logins.get(id);
      if (!login) { status = 404; json = { error: '登录不存在。' }; }
      else {
        if (path.endsWith('/cancel') && ['starting', 'pending', 'verifying'].includes(login.status)) {
          login.status = 'cancelled'; login.userCode = login.verificationUri = null;
        }
        json = login;
      }
    } else if (path.startsWith('/api/auth/accounts/') && method === 'DELETE') {
      const id = path.split('/').at(-1); data.accounts = data.accounts.filter(item => item.id !== id);
      if (data.activeAccountId === id) data.activeAccountId = null;
      json = accountOverview(data);
    } else if (path === '/api/desktop/records') {
      const snapshot = desktopSnapshot(data);
      json = { ...data.identity, accountId: data.activeAccountId, period: url.searchParams.get('period') ?? snapshot.local.period,
        source: 'local-otel', scope: snapshot.local.scope, coverage: 'partial', retained: false, updatedAt: snapshot.local.updatedAt,
        items: data.activeAccountId ? [{ id: `${data.activeAccountId}/session`, sessionId: data.activeAccountId === aliceId ? 'alice-session' : 'bob-session',
          firstSeen: snapshot.local.updatedAt, lastSeen: snapshot.local.updatedAt,
          nanoAiu: snapshot.local.nanoAiu, credits: snapshot.local.credits, unitVerified: true,
          knownCalls: 2, unknownCalls: 0, pendingCalls: 0, models: data.activeAccountId === aliceId ? ['alpha-vision'] : ['bob-model'] }] : [], nextCursor: null };
    } else { status = 404; json = { error: `Unexpected desktop test endpoint: ${method} ${path}` }; }
    // Capture before waiting: a late response must remain tied to the original
    // account/login even when the test changes the current state meanwhile.
    json = structuredClone(json);
    queued?.notify();
    if (queued?.gate) await queued.gate;
    if (queued?.abort) return route.abort(queued.abort);
    await route.fulfill({ status, json });
  });
}
