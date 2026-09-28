import type { UsageSnapshot } from '../shared/types.js';
import { compareDecimals, nonNegativeDecimal, subtractDecimals } from './decimal.js';
import { isMonthlyInterval, timestamp } from './period.js';

export interface ReconciliationEvidence {
  identityVerified: boolean; poolVerified: boolean; productsVerified: boolean; timeCoverageVerified: boolean;
}
export interface Reconciliation {
  state: 'comparable' | 'unknown'; difference: string | null; label: string; reason: string; timeLimited: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validSnapshot(value: unknown): value is UsageSnapshot {
  if (!object(value)) return false;
  const identity = (item: unknown) => text(item, 128) && /^(user|organization|enterprise):[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i.test(item);
  return identity(value.billingEntity) && identity(value.usageSubject) && text(value.poolId)
    && Array.isArray(value.products) && value.products.length > 0 && value.products.length <= 64 && value.products.every(item => text(item))
    && typeof value.stale === 'boolean' && typeof value.periodStart === 'string' && typeof value.periodEnd === 'string'
    && (value.billingMode === 'ai-credits' && value.unit === 'ai-credits' || value.billingMode === 'premium-requests' && value.unit === 'premium-requests');
}

/** Comparison does not modify the ledger or assign the residual to other devices. */
export function reconcileUsage(local: UsageSnapshot, account: UsageSnapshot, evidence: ReconciliationEvidence, now = new Date()): Reconciliation {
  const unavailable = (reason: string): Reconciliation => ({ state: 'unknown', difference: null, label: '无法对账', reason, timeLimited: true });
  if (!object(evidence) || ['identityVerified', 'poolVerified', 'productsVerified', 'timeCoverageVerified'].some(key => evidence[key] !== true)) return unavailable('身份、额度池、产品或时间覆盖尚未验证');
  if (!validSnapshot(local) || !validSnapshot(account)) return unavailable('账户、额度池、产品或单位结构无效');
  if (local.source !== 'local-otel' || !['billing-rest', 'sdk-quota'].includes(account.source)) return unavailable('本地与官方用量来源无效');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return unavailable('核对时间无效');
  if (local.billingEntity !== account.billingEntity || local.usageSubject !== account.usageSubject || !local.poolId || local.poolId !== account.poolId) return unavailable('账户或额度池不同');
  if (local.unit !== account.unit || local.billingMode === 'unknown' || local.billingMode !== account.billingMode) return unavailable('单位或计费模式不同');
  if (local.periodStart !== account.periodStart || local.periodEnd !== account.periodEnd || !isMonthlyInterval(local.periodStart, local.periodEnd, local.periodStart.slice(0, 7))) return unavailable('月度周期不同或无效');
  if (local.state !== 'known' || account.state !== 'known' || local.coverage !== 'complete' || account.coverage !== 'complete') return unavailable('用量或范围不完整');
  if (JSON.stringify([...new Set(local.products)].sort()) !== JSON.stringify([...new Set(account.products)].sort()) || local.products.length === 0) return unavailable('产品范围不同');
  const localWatermark = timestamp(local.providerUpdatedAt); const accountWatermark = timestamp(account.providerUpdatedAt);
  if (local.providerUpdatedAt !== null && localWatermark === null || account.providerUpdatedAt !== null && accountWatermark === null) return unavailable('更新时间无效');
  const periodStart = timestamp(local.periodStart)!; const periodEnd = timestamp(local.periodEnd)!;
  const localFetched = timestamp(local.fetchedAt); const accountFetched = timestamp(account.fetchedAt);
  if (localFetched === null || accountFetched === null || localFetched < periodStart || accountFetched < periodStart || localFetched > now.getTime() || accountFetched > now.getTime()) return unavailable('抓取时间无效');
  if (localWatermark !== null && (localWatermark < periodStart || localWatermark > periodEnd || localWatermark > localFetched) || accountWatermark !== null && (accountWatermark < periodStart || accountWatermark > periodEnd || accountWatermark > accountFetched)) return unavailable('数据截止时间不属于共同月份或晚于抓取时间');
  if (localWatermark !== null && accountWatermark !== null && localWatermark !== accountWatermark) return unavailable('数据截止时间尚未对齐');
  let difference: string; let sign: -1 | 0 | 1;
  try {
    nonNegativeDecimal(local.used); nonNegativeDecimal(account.used);
    // Compare the validated operands; a valid exact difference can have more digits than either input.
    sign = compareDecimals(account.used!, local.used!);
    difference = subtractDecimals(account.used!, local.used!);
  } catch { return unavailable('用量值无效'); }
  const timeLimited = localWatermark === null || accountWatermark === null || local.stale || account.stale;
  return {
    state: 'comparable', difference, label: sign > 0 ? '暂未归属' : sign < 0 ? '尚未对齐' : '已对齐', timeLimited,
    reason: timeLimited ? '缺少共同的官方数据截止时间或数据已陈旧；差额仅供参考' : '仅比较已验证的共同范围；差额不会自动记入会话',
  };
}
