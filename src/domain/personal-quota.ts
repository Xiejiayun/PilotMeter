import type { AccountQuotaBucket, PersonalQuota } from '../shared/accounts.js';
import { compareDecimals, nonNegativeDecimal, subtractDecimals } from './decimal.js';
import { timestamp } from './period.js';

// Fixed SDK v1.0.14 generated rpc.ts distinguishes Chat, Completions and
// Premium-interactions quota. Its account.getQuota snapshot does not promise a
// unit; even premium_interactions can use token/AI-credit billing upstream.
const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  chat: '聊天', completions: '代码补全', premium_interactions: '高级请求',
});
const KEY = /^[a-z][a-z\d_-]{0,63}$/i;

/** These are quota categories, not assertions about the unit used to bill them. */
export function quotaBucketLabel(key: string): string {
  if (Object.hasOwn(CATEGORY_LABELS, key)) return CATEGORY_LABELS[key]!;
  return typeof key === 'string' && KEY.test(key) ? `其他额度 · ${key}` : '未识别额度';
}

export interface PersonalQuotaBucketView {
  key: string;
  label: string;
  unit: AccountQuotaBucket['unit'];
  unitLabel: string;
  value: string;
  detail: string;
  /** Floating-point value for decorative progress only; never format it as quantity text. */
  percentage: number | null;
  /** Exact source percentage for visible text, with no display rounding. */
  usedPercentage: string | null;
  /** Confirmed-unit quantities; unspecified-unit values remain available in raw. */
  used: string | null;
  usageSource: 'remaining' | 'quota-rpc';
  limit: string | null;
  remaining: string | null;
  remainingSource: 'calculated' | null;
  remainingPercentage: string | null;
  /** Amount above the fixed allowance, not a claim about billed overage charges. */
  overage: string | null;
  /** Quantities without unit conversion; used may be calculated from remaining quota. */
  raw: { used: string | null; limit: string | null; remainingPercentage: string | null };
  unlimited: boolean;
  nextResetAt: string | null;
}

export interface PersonalQuotaProjection {
  selection: 'premium' | 'single-finite' | 'explicit' | 'required' | 'none';
  primary: PersonalQuotaBucketView | null;
  buckets: PersonalQuotaBucketView[];
  fetchedAt: string | null;
  stale: boolean;
}

function quantity(value: unknown): string | null {
  // Recheck the expanded representation too: exponent notation must not evade the bound.
  try { return nonNegativeDecimal(nonNegativeDecimal(value)); } catch { return null; }
}

function ratio(value: unknown): { exact: string; percentage: number | null; text: string } | null {
  const exact = quantity(value);
  if (exact === null || compareDecimals(exact, '100') > 0) return null;
  const number = Number(exact);
  // A floating-point progress control must not imply exactly full or empty when it is not.
  const percentage = number === 100 && exact !== '100' || number === 0 && exact !== '0' ? null : number;
  return { exact, percentage, text: `${exact}%` };
}

function projectBucket(bucket: AccountQuotaBucket, fetchedAt: number, now: number): PersonalQuotaBucketView {
  const unit = bucket.unit === 'ai-credits' || bucket.unit === 'premium-requests' ? bucket.unit : 'unspecified';
  const unitLabel = unit === 'ai-credits' ? 'AI Credits' : unit === 'premium-requests' ? 'Premium Requests' : '单位未确认';
  const rawUsed = quantity(bucket.used); const rawLimit = quantity(bucket.limit);
  const usageSource = bucket.usageSource === 'remaining' ? 'remaining' : 'quota-rpc';
  const unlimited = bucket.unlimited === true;
  const used = unit === 'unspecified' ? null : rawUsed;
  const limit = unit === 'unspecified' || unlimited ? null : rawLimit;
  const overage = !unlimited && rawUsed !== null && rawLimit !== null && compareDecimals(rawUsed, rawLimit) > 0;
  const remaining = used !== null && limit !== null ? overage ? '0' : subtractDecimals(limit, used) : null;
  const exceeded = used !== null && limit !== null && overage ? subtractDecimals(used, limit) : null;
  const rawRemainingPercentage = ratio(bucket.remainingPercentage) ? quantity(bucket.remainingPercentage) : null;
  const remainingPercentage = unlimited || rawLimit === '0' || overage ? null : rawRemainingPercentage;
  const percent = unlimited || rawLimit === '0' || overage ? null : ratio(bucket.usedPercentage);
  const numeric = used === null ? '已用未知' : `${used}${limit === null ? '' : ` / ${limit}`}`;
  const value = unlimited ? '无固定上限' : percent?.text ?? numeric;
  const quantityDetail = unit === 'unspecified' ? '数量单位未确认；数值未换算计量单位'
    : used === null ? `已用数量未知${limit === null ? '' : `；固定额度 ${limit} ${unitLabel}`}`
      : `已用 ${used}${limit === null ? ` ${unitLabel}` : ` / ${limit} ${unitLabel}`}`;
  const detail = `${unlimited ? '无固定上限；' : ''}${quantityDetail}${usageSource === 'remaining' ? '；已用按总额减剩余量计算' : ''}${overage ? '；已超出固定额度' : !unlimited && rawLimit === '0' ? unit === 'unspecified' ? '；比例不可用' : '；固定额度为 0，比例不可用' : ''}。`;
  const reset = timestamp(bucket.resetAt);
  return {
    key: bucket.key, label: quotaBucketLabel(bucket.key), unit, unitLabel, value, detail,
    percentage: percent?.percentage ?? null, usedPercentage: percent?.exact ?? null, used, usageSource, limit, remaining, remainingSource: remaining === null ? null : 'calculated',
    remainingPercentage, overage: exceeded, raw: { used: rawUsed, limit: unlimited ? null : rawLimit, remainingPercentage: rawRemainingPercentage }, unlimited,
    nextResetAt: reset !== null && reset > now && reset > fetchedAt ? new Date(reset).toISOString() : null,
  };
}

/**
 * Shared native/web/widget display policy. Callers must first match quota.accountId to
 * the active profile and suppress snapshots whose account requires reauthentication.
 * No buckets, percentages or quantities are merged. Passing a selected key is an
 * explicit user choice; otherwise only the known premium category or a sole finite
 * category becomes the primary summary.
 */
export function projectPersonalQuota(quota: PersonalQuota | null, now: string | number, selectedKey?: string | null): PersonalQuotaProjection {
  const current = typeof now === 'number' ? Number.isFinite(now) && Math.abs(now) <= 8.64e15 ? now : null : timestamp(now);
  const fetched = timestamp(quota?.fetchedAt);
  const empty: PersonalQuotaProjection = { selection: 'none', primary: null, buckets: [], fetchedAt: null, stale: true };
  if (!quota || quota.scope !== 'signed-in-user' || !['available', 'error'].includes(quota.state)
    || current === null || fetched === null || fetched > current || !Array.isArray(quota.buckets)
    || quota.buckets.length === 0 || quota.buckets.length > 64
    || quota.buckets.some(bucket => !bucket || typeof bucket.key !== 'string' || !KEY.test(bucket.key))) return empty;
  const buckets = quota.buckets.map(bucket => projectBucket(bucket, fetched, current));
  const result: PersonalQuotaProjection = {
    selection: 'none', primary: null, buckets, fetchedAt: new Date(fetched).toISOString(),
    stale: quota.stale || quota.state === 'error' || quota.error !== null || current - fetched > 5 * 60_000,
  };
  function choose(candidates: PersonalQuotaBucketView[], selection: PersonalQuotaProjection['selection']): boolean {
    if (candidates.length !== 1) return false;
    result.primary = candidates[0]!; result.selection = selection; return true;
  }
  if (selectedKey && choose(buckets.filter(bucket => bucket.key === selectedKey), 'explicit')) return result;
  const premium = buckets.filter(bucket => bucket.key === 'premium_interactions');
  if (choose(premium, 'premium')) return result;
  // Duplicate keys cannot come from the validated provider map; fail closed if a caller supplies them.
  if (new Set(buckets.map(bucket => bucket.key)).size !== buckets.length) { result.selection = 'required'; return result; }
  const finite = buckets.filter(bucket => !bucket.unlimited);
  if (choose(finite, 'single-finite')) return result;
  if (finite.length > 1 || premium.length > 1) result.selection = 'required';
  return result;
}
