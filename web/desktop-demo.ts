import type { DesktopResponse, DesktopRecordsResponse } from '../src/shared/desktop';
import { projectPersonalQuota } from '../src/domain/personal-quota';

/** Opt-in, visibly labelled design fixture. Never a fallback for a failed live request. */
export function designDemo(): { desktop: DesktopResponse; records: DesktopRecordsResponse } {
  const now = new Date().toISOString();
  const accountId = 'design-preview';
  const presentation = projectPersonalQuota({ accountId, scope: 'signed-in-user', state: 'available', fetchedAt: now, stale: false, error: null,
    buckets: [{ key: 'premium_interactions', label: '高级请求', unit: 'unspecified', used: '66000', limit: '2000000', remainingPercentage: '96.7', usedPercentage: '3.3', unlimited: false, resetAt: null, providerUpdatedAt: now }] }, Date.now());
  const desktop: DesktopResponse = { app: 'pilotmeter', version: 'design', instanceId: 'design', enabled: false, refreshing: false, activeAccountId: accountId, login: null,
    accounts: [{ id: accountId, login: 'octocat', host: 'https://github.com', status: 'connected', createdAt: now, checkedAt: now }],
    quota: { accountId, state: 'available', fetchedAt: now, stale: false, error: null }, presentation,
    models: { accountId, source: 'copilot-cli-models.list', state: 'available', fetchedAt: now, stale: false, refreshing: false, error: null,
      items: [
        { id: 'example-sonnet', name: 'Claude Sonnet · 示例', status: 'available', reason: '设计示例，不代表你的账号权限', policyState: 'enabled', vision: true, reasoningEffort: true, contextWindowTokens: 200000, multiplier: '1' },
        { id: 'example-gpt', name: 'GPT · 示例', status: 'available', reason: '设计示例，不代表你的账号权限', policyState: 'enabled', vision: true, reasoningEffort: true, contextWindowTokens: null, multiplier: null },
        { id: 'example-gemini', name: 'Gemini · 示例', status: 'available', reason: '设计示例，不代表你的账号权限', policyState: 'enabled', vision: true, reasoningEffort: null, contextWindowTokens: null, multiplier: '1' },
        { id: 'example-disabled', name: '组织受限模型 · 示例', status: 'disabled', reason: '此项用于演示组织策略限制的显示方式。', policyState: 'disabled', vision: null, reasoningEffort: null, contextWindowTokens: null, multiplier: null },
      ] },
    local: { accountId, source: 'local-otel', scope: '当前账号的本机采集记录', retained: false, updatedAt: now, period: now.slice(0, 7), nanoAiu: null, knownCalls: 38, unknownCalls: 2, pendingCalls: 0, sessionCount: 6, coverage: 'partial', unitVerified: false, credits: null },
  };
  const records: DesktopRecordsResponse = { app: 'pilotmeter', version: 'design', instanceId: 'design', accountId, period: now.slice(0, 7), source: 'local-otel', scope: '当前账号的本机采集记录', coverage: 'partial', retained: false, updatedAt: now, nextCursor: null,
    items: [
      { id: 'example-session-1', sessionId: 'demo-8b3e2c', firstSeen: now, lastSeen: now, nanoAiu: null, knownCalls: 18, unknownCalls: 0, pendingCalls: 0, models: ['example-sonnet'], credits: null, unitVerified: false },
      { id: 'example-session-2', sessionId: 'demo-4a1f9d', firstSeen: now, lastSeen: now, nanoAiu: null, knownCalls: 12, unknownCalls: 2, pendingCalls: 0, models: ['example-gpt'], credits: null, unitVerified: false },
      { id: 'example-session-3', sessionId: 'demo-2e7a4c', firstSeen: now, lastSeen: now, nanoAiu: null, knownCalls: 8, unknownCalls: 0, pendingCalls: 0, models: ['example-gemini'], credits: null, unitVerified: false },
    ],
  };
  return { desktop, records };
}
