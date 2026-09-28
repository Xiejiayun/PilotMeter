import type { DisplayMode, LocalUsage, Settings, UsageSnapshot } from '../shared/types.js';
import { nonNegativeDecimal, percentageOf } from './decimal.js';
import { isMonthlyInterval, timestamp } from './period.js';

function quantity(value: unknown): string | null {
  try { return nonNegativeDecimal(value); } catch { return null; }
}

/** A snapshot is a statement about one verified monthly account pool, never a local sum. */
export function officialSnapshotEligible(snapshot: UsageSnapshot | null, period: string, entity?: string): boolean {
  if (!snapshot || !['billing-rest', 'sdk-quota'].includes(snapshot.source) || snapshot.state !== 'known' || snapshot.coverage !== 'complete') return false;
  if (!snapshot.poolId || !snapshot.billingEntity || snapshot.usageSubject !== snapshot.billingEntity || !snapshot.products.length) return false;
  if (entity && snapshot.billingEntity.toLowerCase() !== entity.toLowerCase()) return false;
  if (!isMonthlyInterval(snapshot.periodStart, snapshot.periodEnd, period)) return false;
  const verified = timestamp(snapshot.verifiedAt); const fetched = timestamp(snapshot.fetchedAt);
  const start = timestamp(snapshot.periodStart); const end = timestamp(snapshot.periodEnd);
  if (verified === null || fetched === null || start === null || end === null || verified < start || verified >= end || verified > fetched) return false;
  if (snapshot.billingMode === 'ai-credits' ? snapshot.unit !== 'ai-credits' : snapshot.billingMode === 'premium-requests' ? snapshot.unit !== 'premium-requests' : true) return false;
  if (quantity(snapshot.used) === null) return false;
  if (snapshot.limitKind === 'unlimited') return snapshot.limit === null;
  return (snapshot.limitKind === 'official' || snapshot.limitKind === 'manual-official') && quantity(snapshot.limit) !== null;
}

export function buildDisplay(local: LocalUsage, account: UsageSnapshot | null, settings: Settings): DisplayMode {
  const configured = settings.account;
  const entity = configured ? `${configured.kind}:${configured.login}` : null;
  if (entity && (configured?.kind !== 'user' || configured.directBilling === true) && officialSnapshotEligible(account, local.period, entity) && account) {
    const unlimited = account.limitKind === 'unlimited';
    const percentage = unlimited ? null : percentageOf(account.used!, account.limit!);
    return {
      mode: 'official', label: unlimited ? '官方额度（无固定上限）' : '本月官方额度已用',
      used: account.used, limit: account.limit, percentage, unit: account.unit,
      scope: `官方账户额度池 · ${account.billingEntity}`,
      reason: unlimited ? '无固定上限' : percentage === null ? '额度为 0' : account.stale ? '数据已陈旧；显示上次成功同步值' : null,
    };
  }

  const credits = local.unitVerified && local.knownCalls > 0 ? quantity(local.credits) : null;
  const budget = quantity(settings.monthlyBudget);
  const incomplete = local.unknownCalls + local.pendingCalls > 0;
  if (credits !== null && budget !== null) {
    const percentage = percentageOf(credits, budget);
    return {
      mode: 'custom', label: '自定义预算已用', used: credits, limit: budget, percentage,
      unit: 'ai-credits', scope: '本机已记录会话',
      reason: percentage === null ? '预算为 0' : incomplete ? '已知用量小计；包含尚未确定消耗的调用' : '从启用采集起记录；不代表全账户消费',
    };
  }

  const raw = local.knownCalls > 0 && typeof local.nanoAiu === 'string' && /^\d+$/.test(local.nanoAiu) ? local.nanoAiu : null;
  return {
    mode: 'usage', label: local.unitVerified ? '本机已记录' : '计量单位待确认',
    used: local.unitVerified ? credits : raw, limit: null, percentage: null,
    unit: local.unitVerified ? 'ai-credits' : 'nano-aiu', scope: '本机已记录会话',
    reason: local.knownCalls === 0 ? '尚无已知用量；官方额度未确认' : !local.unitVerified ? 'nano AIU 与 AI Credits 的换算尚未验证；官方额度未确认' : incomplete ? '已知用量小计；官方额度未确认' : '官方额度未确认',
  };
}
