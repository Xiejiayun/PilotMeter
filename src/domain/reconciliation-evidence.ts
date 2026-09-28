import { createHash } from 'node:crypto';
import type { UsageSnapshot } from '../shared/types.js';
import { nanoToCredits } from './decimal.js';
import { officialSnapshotEligible } from './display.js';
import { monthlyPeriod, timestamp } from './period.js';
import { reconcileUsage, type Reconciliation } from './reconciliation.js';

/** Produced by the repository, never accepted as a client-supplied amount. */
export interface ReconciliationBasis {
  period: string; cutoff: string | null; sourceContexts: string[];
  knownNanoAiu: string | null; knownCalls: number; unknownCalls: number; pendingCalls: number;
  unitVerified: boolean; blockers: string[]; ledgerHash: string;
}

/** An explicit attestation about a finite snapshot, not a reusable account binding. */
export interface ReconciliationEvidenceFile {
  version: 1; period: string; sourceContexts: string[];
  billingEntity: string; usageSubject: string; poolId: string; products: string[];
  billingMode: 'ai-credits'; unit: 'ai-credits'; coverageStart: string; coverageEnd: string;
  ledgerHash: string; accountHash: string; verifiedAt: string;
  identityVerified: boolean; poolVerified: boolean; productsVerified: boolean; timeCoverageVerified: boolean;
  evidence: string;
}

export interface ReconciliationReport extends Reconciliation {
  period: string; cutoff: string | null; sourceContexts: string[];
  localUsed: string | null; accountUsed: string | null; unit: 'ai-credits' | null;
  ledgerHash: string | null; accountHash: string | null;
  evidencePresent: boolean; verifiedAt: string | null; expiresAt: string | null; blockers: string[];
}

export interface ReconciliationInspection {
  report: ReconciliationReport; template: ReconciliationEvidenceFile | null;
}

export interface ReconciliationVerification {
  accepted: boolean; evidence: ReconciliationEvidenceFile | null; report: ReconciliationReport;
}

export const RECONCILIATION_EVIDENCE_MAX_AGE_MS = 15 * 60_000;

const FLAGS = ['identityVerified', 'poolVerified', 'productsVerified', 'timeCoverageVerified'] as const;
const EVIDENCE_KEYS = new Set(['version', 'period', 'sourceContexts', 'billingEntity', 'usageSubject', 'poolId', 'products',
  'billingMode', 'unit', 'coverageStart', 'coverageEnd', 'ledgerHash', 'accountHash', 'verifiedAt', ...FLAGS, 'evidence']);
const HASH = /^[a-f0-9]{64}$/;
const BLOCKERS: Record<string, string> = {
  'cutoff-missing': '官方数据截止时间未知', 'cutoff-invalid': '官方数据截止时间无效',
  'no-known-root-usage': '尚无已知的顶层调用用量', 'unknown-root-metering': '存在消耗未知的顶层调用',
  'pending-classification': '存在尚未完成分类的调用', 'invalid-classification': '存在无法安全分类的调用',
  'conflicting-events': '存在冲突事件', 'unlocated-events': '存在无法归属月份或时间范围的事件',
  'missing-operation': '存在操作类型未知的事件', 'unresolved-ancestry': '调用祖先链尚未确认',
  'unit-unverified': '本地计量单位与 CLI 版本尚未验证', 'retention-overlap': '历史清理可能影响所核对范围',
  'unlocated-rejections': '存在无法定位范围的已拒绝采集记录',
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function strings(value: unknown, maximum: number, length: number): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every(item => text(item, length))
    && new Set(value).size === value.length;
}

function sameSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** Include every JSON field, including error/stale/allowance metadata; object-key order is immaterial. */
export function hashAccountSnapshot(account: UsageSnapshot): string {
  let nodes = 0;
  const canonical = (value: unknown, depth = 0): string => {
    if (++nodes > 4096 || depth > 16) throw new RangeError('Account snapshot is too complex');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
    if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
    throw new RangeError('Account snapshot must contain JSON values');
  };
  return createHash('sha256').update(canonical(account)).digest('hex');
}

function unavailable(report: ReconciliationReport, blockers: string[]): ReconciliationReport {
  const unique = [...new Set(blockers)];
  return { ...report, state: 'unknown', difference: null, label: '无法对账', reason: unique.join('；'), timeLimited: true, blockers: unique };
}

function inspectFacts(basis: ReconciliationBasis, account: UsageSnapshot | null, now: Date): ReconciliationInspection {
  const report: ReconciliationReport = { state: 'unknown', difference: null, label: '无法对账', reason: '', timeLimited: true,
    period: typeof basis?.period === 'string' ? basis.period : '', cutoff: null, sourceContexts: [], localUsed: null, accountUsed: null,
    unit: null, ledgerHash: null, accountHash: null, evidencePresent: false, verifiedAt: null, expiresAt: null, blockers: [] };
  const invalid = (message: string): ReconciliationInspection => ({ report: unavailable(report, [message]), template: null });
  if (!object(basis) || !text(basis.period, 7) || typeof basis.ledgerHash !== 'string' || !HASH.test(basis.ledgerHash)
    || !Array.isArray(basis.sourceContexts) || basis.sourceContexts.length > 1024
    || basis.sourceContexts.some(value => !text(value, 512)) || new Set(basis.sourceContexts).size !== basis.sourceContexts.length
    || !Array.isArray(basis.blockers) || basis.blockers.length > 128 || basis.blockers.some(value => !text(value, 128))
    || typeof basis.unitVerified !== 'boolean' || [basis.knownCalls, basis.unknownCalls, basis.pendingCalls].some(value => !Number.isSafeInteger(value) || value < 0)
    || basis.knownNanoAiu !== null && (typeof basis.knownNanoAiu !== 'string' || !/^\d{1,256}$/.test(basis.knownNanoAiu))) return invalid('本地核对基线结构无效');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return invalid('核对时间无效');
  let range;
  try { range = monthlyPeriod(basis.period); } catch { return invalid('核对月份无效'); }
  report.sourceContexts = [...basis.sourceContexts].sort(); report.ledgerHash = basis.ledgerHash;
  const blockers = basis.blockers.map(code => BLOCKERS[code] ?? `账本范围存在未解决问题：${code}`);
  const cutoff = timestamp(basis.cutoff);
  if (cutoff === null) blockers.push('官方数据截止时间未知或无效');
  else if (cutoff <= Date.parse(range.start) || cutoff > Date.parse(range.end) || cutoff > now.getTime()) blockers.push('官方数据截止时间不属于已发生的所选月份范围');
  else report.cutoff = new Date(cutoff).toISOString();
  if (!basis.sourceContexts.length) blockers.push('尚无可明确归属的采集来源');
  if (!basis.knownCalls || basis.knownNanoAiu === null) blockers.push('尚无已知的顶层调用用量');
  if (basis.unknownCalls) blockers.push('存在用量未知的调用');
  if (basis.pendingCalls) blockers.push('存在尚未完成分类的调用');
  if (!basis.unitVerified) blockers.push('本地计量单位尚未验证');
  if (basis.unitVerified && basis.knownCalls > 0 && basis.knownNanoAiu !== null) report.localUsed = nanoToCredits(basis.knownNanoAiu);
  if (!account || !officialSnapshotEligible(account, basis.period, undefined, now) || account.unit !== 'ai-credits') blockers.push('尚无同月、完整且已验证的官方 AI Credits 账户快照');
  else {
    const fetched = timestamp(account.fetchedAt);
    if (fetched === null || fetched < Date.parse(range.start) || fetched > now.getTime()) blockers.push('账户快照抓取时间无效');
    if (timestamp(account.providerUpdatedAt) === null || timestamp(account.providerUpdatedAt) !== cutoff) blockers.push('官方快照与本地基线的截止时间不同或未知');
    report.accountUsed = account.used; report.unit = 'ai-credits';
    try { report.accountHash = hashAccountSnapshot(account); } catch { blockers.push('账户快照无法形成有效核对指纹'); }
  }
  if (blockers.length || !account || !report.accountHash || !report.cutoff) return { report: unavailable(report, blockers), template: null };
  const template: ReconciliationEvidenceFile = {
    version: 1, period: basis.period, sourceContexts: [...report.sourceContexts], billingEntity: account.billingEntity,
    usageSubject: account.usageSubject, poolId: account.poolId!, products: [...account.products].sort(), billingMode: 'ai-credits', unit: 'ai-credits',
    coverageStart: range.start, coverageEnd: report.cutoff, ledgerHash: basis.ledgerHash, accountHash: report.accountHash,
    verifiedAt: '', identityVerified: false, poolVerified: false, productsVerified: false, timeCoverageVerified: false, evidence: '',
  };
  return { report, template };
}

/** A template never asserts identity, full collection coverage, or a verification time on the user's behalf. */
export function inspectReconciliation(basis: ReconciliationBasis, account: UsageSnapshot | null, now = new Date()): ReconciliationInspection {
  const inspected = inspectFacts(basis, account, now);
  return { ...inspected, report: unavailable(inspected.report, [...inspected.report.blockers, '尚未导入当前有限时点的对账证据']) };
}

/** Re-evaluate persisted evidence on every read; new collection, correction, quota data, or expiry invalidates it. */
export function reconciliationReport(basis: ReconciliationBasis, account: UsageSnapshot | null, evidence?: unknown, now = new Date()): ReconciliationReport {
  const inspected = inspectFacts(basis, account, now); const report = { ...inspected.report, evidencePresent: evidence !== undefined && evidence !== null };
  const blockers = [...report.blockers]; const template = inspected.template;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return report;
  if (!report.evidencePresent) return unavailable(report, [...blockers, '尚未导入当前有限时点的对账证据']);
  if (!object(evidence) || Object.keys(evidence).some(key => !EVIDENCE_KEYS.has(key)) || Object.keys(evidence).length !== EVIDENCE_KEYS.size
    || evidence.version !== 1 || !strings(evidence.sourceContexts, 1024, 512) || !strings(evidence.products, 64, 256)
    || !text(evidence.evidence, 4096) || FLAGS.some(flag => typeof evidence[flag] !== 'boolean')
    || !['period', 'billingEntity', 'usageSubject', 'poolId', 'billingMode', 'unit', 'coverageStart', 'coverageEnd', 'ledgerHash', 'accountHash', 'verifiedAt']
      .every(key => text(evidence[key], key === 'poolId' ? 256 : 128))) return unavailable(report, [...blockers, '对账证据结构无效；不能提供金额、额度或未知字段']);
  const proof = evidence as unknown as ReconciliationEvidenceFile;
  const verified = timestamp(proof.verifiedAt);
  if (verified === null || verified > now.getTime()) blockers.push('证据核实时间无效或晚于当前时间');
  else {
    report.verifiedAt = new Date(verified).toISOString(); report.expiresAt = new Date(verified + RECONCILIATION_EVIDENCE_MAX_AGE_MS).toISOString();
    if (now.getTime() - verified >= RECONCILIATION_EVIDENCE_MAX_AGE_MS) blockers.push('对账证据已超过 15 分钟有效期，需要重新核对');
    const fetched = timestamp(account?.fetchedAt);
    if (fetched !== null && verified < fetched) blockers.push('证据核实时间早于所用账户快照');
  }
  if (FLAGS.some(flag => proof[flag] !== true)) blockers.push('来源身份、额度池、产品和完整时间覆盖尚未逐项核实');
  if (proof.ledgerHash !== report.ledgerHash) blockers.push('账本、分类、单位或历史清理状态已改变，需要重新核对');
  if (proof.accountHash !== report.accountHash) blockers.push('账户快照已改变，需要重新核对');
  if (!sameSet(proof.sourceContexts, report.sourceContexts)) blockers.push('采集来源集合与当前基线不一致');
  if (template) {
    if (['period', 'billingEntity', 'usageSubject', 'poolId', 'billingMode', 'unit', 'coverageStart', 'coverageEnd']
      .some(key => proof[key as keyof ReconciliationEvidenceFile] !== template[key as keyof ReconciliationEvidenceFile])
      || !sameSet(proof.products, template.products)) blockers.push('证据中的账户、额度池、产品、单位或半开时间范围不一致');
  }
  if (blockers.length || !template || !account || verified === null || report.localUsed === null) return unavailable(report, blockers);
  const local: UsageSnapshot = { ...account, source: 'local-otel', used: report.localUsed, limit: null, limitKind: 'unknown',
    fetchedAt: proof.verifiedAt, providerUpdatedAt: template.coverageEnd, stale: false, lastError: null };
  const result = reconcileUsage(local, account, proof, now);
  return { ...report, ...result, blockers: result.state === 'unknown' ? [result.reason] : [] };
}

/** Invalid verification never supplies replacement usage values or a persistable attestation. */
export function verifyReconciliationEvidence(input: unknown, basis: ReconciliationBasis, account: UsageSnapshot | null, now = new Date()): ReconciliationVerification {
  const report = reconciliationReport(basis, account, input, now);
  const accepted = report.state === 'comparable';
  return { accepted, evidence: accepted ? structuredClone(input) as ReconciliationEvidenceFile : null, report };
}
