import type { UsageSnapshot } from '../shared/types.js';
import { compareDecimals, nonNegativeDecimal } from '../domain/decimal.js';
import { monthlyPeriod, timestamp } from '../domain/period.js';
import { billingEntity, unknownBillingSnapshot, type BillingAccount } from './billing.js';

/** An optional boundary for externally obtained, read-only quota data. No SDK or authentication files are loaded. */
export interface QuotaData {
  usedRequests?: unknown; entitlementRequests?: unknown; remainingPercentage?: unknown;
  resetDate?: unknown; isUnlimited?: unknown;
}

/** Evidence is explicit and specific to this identity, pool, period, and current allowance. */
export interface QuotaEvidence {
  billingEntity: string; usageSubject: string; poolId: string;
  period: string; poolKind: 'monthly-account' | 'session' | 'weekly' | 'user-budget' | 'unknown';
  billingMode: 'ai-credits' | 'premium-requests' | 'unknown'; unit: string; products: string[];
  identityVerified: boolean; unitVerified: boolean; allowanceVerified: boolean;
  coverageVerified: boolean; officialPageCompared: boolean;
  allowance: string | null; unlimited: boolean;
  verifiedAt: string; providerUpdatedAt: string; evidence: string;
}

export interface QuotaCapability { supported: boolean; reasons: string[] }
export interface QuotaResult { capability: QuotaCapability; snapshot: UsageSnapshot }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validEvidence(value: unknown): value is QuotaEvidence {
  if (!object(value)) return false;
  if (!text(value.billingEntity, 128) || !text(value.usageSubject, 128) || !text(value.poolId, 256)
    || !text(value.period, 7) || !text(value.poolKind, 32) || !text(value.billingMode, 32)
    || !text(value.unit, 32) || !text(value.verifiedAt, 32) || !text(value.providerUpdatedAt, 32)
    || !text(value.evidence, 4096)) return false;
  if (!Array.isArray(value.products) || value.products.length < 1 || value.products.length > 64
    || value.products.some(product => !text(product, 256))) return false;
  if (['identityVerified', 'unitVerified', 'allowanceVerified', 'coverageVerified', 'officialPageCompared', 'unlimited']
    .some(key => typeof value[key] !== 'boolean')) return false;
  return value.allowance === null || typeof value.allowance === 'string' && value.allowance.length <= 512;
}

function exactQuotaValue(value: unknown): string | null {
  // A number is admissible only when it is an exact, safe integer; fractions must arrive as decimal text.
  try { return nonNegativeDecimal(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value); }
  catch { return null; }
}

export function adaptQuota(raw: unknown, evidence: unknown, account: BillingAccount, period: string, now = new Date()): QuotaResult {
  if (typeof period !== 'string') throw new RangeError('Period must be YYYY-MM');
  const range = monthlyPeriod(period); const entity = billingEntity(account); const reasons: string[] = [];
  const base: UsageSnapshot = { ...unknownBillingSnapshot(account, period, now), source: 'sdk-quota', state: 'unsupported' };
  const fail = (): QuotaResult => ({
    capability: { supported: false, reasons },
    snapshot: { ...base, lastError: { code: 'QUOTA_UNVERIFIED', message: reasons.join('；') } },
  });
  if (!object(raw)) { reasons.push('quota 数据必须是对象'); return fail(); }
  if (!evidence) { reasons.push('没有当月额度验证证据'); return fail(); }
  if (!validEvidence(evidence)) {
    reasons.push('额度验证证据结构无法识别'); return fail();
  }
  if (account.kind === 'user' && account.directBilling !== true) reasons.push('未确认个人直接付费；公司额度不能视为个人套餐额度');
  if (evidence.billingEntity.toLowerCase() !== entity || evidence.usageSubject.toLowerCase() !== entity || evidence.identityVerified !== true) reasons.push('计费主体或用量主体未确认');
  if (!evidence.poolId || evidence.poolKind !== 'monthly-account' || evidence.period !== period) reasons.push('不是已验证的当月账户额度池');
  const credits = evidence.billingMode === 'ai-credits' && evidence.unit === 'ai-credits';
  const legacy = evidence.billingMode === 'premium-requests' && evidence.unit === 'premium-requests';
  if ((!credits && !legacy) || evidence.unitVerified !== true) reasons.push('计费模式或单位未验证');
  if (evidence.coverageVerified !== true || !evidence.products.length || evidence.products.some(product => typeof product !== 'string' || !product.trim())) reasons.push('同一额度池的产品覆盖未确认');
  if (evidence.allowanceVerified !== true || evidence.officialPageCompared !== true || !evidence.evidence.trim()) reasons.push('真实额度尚未与官方页面核对');

  const verified = timestamp(evidence.verifiedAt); const updated = timestamp(evidence.providerUpdatedAt);
  const start = Date.parse(range.start); const end = Date.parse(range.end);
  if (verified === null || updated === null || verified < start || verified >= end || verified > now.getTime() || updated < start || updated > verified || updated >= end) reasons.push('验证时间或数据截止时间不属于有效当月范围');
  if (timestamp(raw.resetDate) !== end) reasons.push('quota 重置时间未确认 UTC 月度边界');
  const used = exactQuotaValue(raw.usedRequests);
  if (used === null) reasons.push('缺少精确的已用量；remainingPercentage 不能单独证明月度用量');
  if (typeof raw.isUnlimited !== 'boolean') reasons.push('quota 无固定上限状态必须是明确的布尔值');
  const unlimited = raw.isUnlimited === true;
  if (unlimited !== evidence.unlimited) reasons.push('无固定上限状态与核对证据不一致');
  const allowance = exactQuotaValue(evidence.allowance); const rawLimit = exactQuotaValue(raw.entitlementRequests);
  if (!unlimited && (allowance === null || rawLimit === null || compareDecimals(allowance, rawLimit) !== 0)) reasons.push('当前额度与已核对额度不一致；套餐或 flex 调整后需要重新核对');
  if (unlimited && evidence.allowance !== null) reasons.push('无固定上限不能同时声明固定额度');
  if (reasons.length) return fail();
  return {
    capability: { supported: true, reasons: [] },
    snapshot: {
      ...base, poolId: evidence.poolId, products: [...new Set(evidence.products)],
      billingMode: evidence.billingMode, unit: evidence.unit, used, coverage: 'complete', state: 'known',
      limit: unlimited ? null : rawLimit, limitKind: unlimited ? 'unlimited' : 'official',
      verifiedAt: evidence.verifiedAt, providerUpdatedAt: evidence.providerUpdatedAt, lastError: null,
    },
  };
}
