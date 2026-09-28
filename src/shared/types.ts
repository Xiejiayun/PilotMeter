export type Classification = 'root' | 'child' | 'pending' | 'conflict' | 'invalid';
export interface SpanRecord {
  traceId: string; spanId: string; parentSpanId: string | null;
  sessionId: string | null; operation: string | null; nanoAiu: string | null;
  startTime: string | null; endTime: string | null; model: string | null;
  inputTokens: string | null; outputTokens: string | null;
  serverAddress: string | null; serverPort: number | null; serviceVersion: string | null;
  sourceContext: string; classification?: Classification; invalidReason?: string | null;
}
export interface LocalUsage {
  period: string; nanoAiu: string | null; knownCalls: number; unknownCalls: number;
  pendingCalls: number; sessionCount: number; coverage: 'partial' | 'empty';
  unitVerified: boolean; credits: string | null;
}
export interface SessionSummary {
  id: string; sessionId: string; sourceContext: string; firstSeen: string | null; lastSeen: string | null;
  nanoAiu: string | null; knownCalls: number; unknownCalls: number; pendingCalls: number;
  models: string[]; coverage: 'partial';
}
export interface Diagnostic { code: string; message: string; createdAt: string; count: number }
export interface ImportResult { accepted: number; duplicates: number; conflicts: number; rejected: number; offset?: number; pendingBytes?: number }
export interface Settings {
  monthlyBudget: string | null; unitVerification: { cliVersion: string; verifiedAt: string; evidence: string } | null;
  account: { kind: 'user' | 'organization' | 'enterprise'; login: string; directBilling?: boolean } | null;
  retentionDays: number | null;
  demo: boolean;
}
export interface RetentionStatus {
  lastRunAt: string | null; cutoff: string | null; prunedTraces: number; prunedSpans: number;
}
export interface UsageSnapshot {
  source: 'billing-rest' | 'sdk-quota' | 'local-otel'; billingEntity: string; usageSubject: string;
  poolId: string | null; products: string[]; periodStart: string; periodEnd: string;
  billingMode: 'ai-credits' | 'premium-requests' | 'unknown'; unit: string;
  used: string | null; coverage: 'complete' | 'partial' | 'unknown';
  state: 'known' | 'empty' | 'unknown' | 'unsupported'; limit: string | null;
  limitKind: 'official' | 'manual-official' | 'custom' | 'unlimited' | 'unknown';
  verifiedAt: string | null; fetchedAt: string; providerUpdatedAt: string | null;
  stale: boolean; lastError: { code: string; message: string } | null;
  retryAt?: string | null;
}
export interface DisplayMode {
  mode: 'official' | 'custom' | 'usage'; label: string; used: string | null;
  limit: string | null; percentage: string | null; unit: string; scope: string; reason: string | null;
}
export interface Summary {
  period: string; local: LocalUsage; account: UsageSnapshot | null; display: DisplayMode;
  updatedAt: string; demo: boolean;
  retention: RetentionStatus & { days: number | null };
}
