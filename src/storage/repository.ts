import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identifier, integer, metadata, serverAddress } from '../collectors/otlp.js';
import { timestamp } from '../domain/period.js';
import type { ReconciliationBasis } from '../domain/reconciliation-evidence.js';
import type { Classification, Diagnostic, ImportResult, LocalUsage, RetentionStatus, SessionSummary, Settings, SpanRecord, UsageSnapshot } from '../shared/types.js';
import type { DesktopRecord } from '../shared/desktop.js';

export interface ImportCursor {
  fileKey: string; fileIdentity: string; generation: number; offset: number; prefixHash: string;
}
export interface UsageScope { sourceContextPrefix: string }
type StoredSpan = SpanRecord & { classification: Classification; conflicted: boolean; reason: string | null };
interface Totals { nanoAiu: string | null; knownCalls: number; unknownCalls: number; pendingCalls: number }
const SCHEMA_VERSION = 2;
const ROOT_CLI_VERSIONS = new Set(['1.0.88']);
export const PENDING_CLASSIFICATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PENDING_TIMEOUT_PREFIX = 'pending-timeout:';
const now = (): string => new Date().toISOString();
const key = (span: Pick<SpanRecord, 'traceId' | 'spanId'>): string => `${span.traceId}/${span.spanId}`;
const sessionKey = (source: string, session: string): string => createHash('sha256').update(`${source}\0${session}`).digest('hex');

function scopePrefix(scope: UsageScope | undefined): string | null {
  if (scope === undefined) return null;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)
    || typeof scope.sourceContextPrefix !== 'string'
    || !/^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:$/.test(scope.sourceContextPrefix)) {
    throw new Error('Invalid usage scope; expected profile:<lowercase UUID>: source context prefix');
  }
  return scope.sourceContextPrefix;
}

function periodBounds(period: string): [string, string] {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period) || period < '1970-01' || period > '9998-12') throw new Error('Invalid UTC month; expected YYYY-MM');
  const start = `${period}-01T00:00:00.000Z`;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return [start, end.toISOString()];
}

function validTime(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
}

/** Reapply the allowlist at the persistence boundary, including for direct callers. */
function normalize(input: SpanRecord): SpanRecord {
  const errors = new Set<string>();
  for (const reason of (input.invalidReason ?? '').split(',')) {
    if (['invalid-identity', 'invalid-parent', 'invalid-metering', 'invalid-time', 'invalid-tokens'].includes(reason)) errors.add(reason);
  }
  const traceId = identifier(input.traceId, 32) ?? '';
  const spanId = identifier(input.spanId, 16) ?? '';
  const parentSpanId = input.parentSpanId === null || input.parentSpanId === undefined || input.parentSpanId === ''
    || input.parentSpanId === '0000000000000000' ? null : identifier(input.parentSpanId, 16);
  if (!traceId || !spanId) errors.add('invalid-identity');
  if (input.parentSpanId && input.parentSpanId !== '0000000000000000' && !parentSpanId) errors.add('invalid-parent');
  const nanoAiu = integer(input.nanoAiu);
  if (input.nanoAiu !== null && input.nanoAiu !== undefined && nanoAiu === null) errors.add('invalid-metering');
  const startTime = validTime(input.startTime);
  const endTime = validTime(input.endTime);
  if (!startTime || !endTime || startTime > endTime) errors.add('invalid-time');
  const port = integer(input.serverPort);
  return {
    traceId, spanId, parentSpanId,
    sessionId: metadata(input.sessionId), operation: metadata(input.operation, 64), nanoAiu,
    startTime, endTime, model: metadata(input.model),
    inputTokens: integer(input.inputTokens), outputTokens: integer(input.outputTokens),
    serverAddress: serverAddress(input.serverAddress),
    serverPort: port !== null && BigInt(port) >= 1n && BigInt(port) <= 65535n ? Number(port) : null,
    serviceVersion: metadata(input.serviceVersion, 64), sourceContext: metadata(input.sourceContext, 512) ?? 'unknown',
    invalidReason: errors.size ? [...errors].sort().join(',') : null,
  };
}

function fingerprint(span: SpanRecord): string {
  const { sourceContext: _source, ...content } = span;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function totals(spans: StoredSpan[]): Totals {
  let sum = 0n;
  let knownCalls = 0;
  let unknownCalls = 0;
  let pendingCalls = 0;
  for (const span of spans) {
    if (span.operation !== 'invoke_agent') continue;
    if (span.classification === 'root') {
      if (span.nanoAiu !== null) { sum += BigInt(span.nanoAiu); knownCalls++; }
      else unknownCalls++;
    } else if (span.classification === 'pending') pendingCalls++;
    else if (span.classification === 'invalid' || span.classification === 'conflict') unknownCalls++;
  }
  return { nanoAiu: knownCalls ? sum.toString() : null, knownCalls, unknownCalls, pendingCalls };
}

function credits(nano: string): string {
  const value = BigInt(nano);
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ''}`;
}

export class Repository {
  readonly #db: DatabaseSync;
  #inTransaction = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    const hadData = dbPath !== ':memory:' && existsSync(dbPath) && statSync(dbPath).size > 0;
    this.#db = new DatabaseSync(dbPath);
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      const version = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version > SCHEMA_VERSION) throw new Error('Database schema is newer than this PilotMeter version');
      if (version < SCHEMA_VERSION) {
        if (hadData) {
          // Checkpoint before a byte-for-byte migration backup, preserving the original on failure.
          const checkpoint = this.#db.prepare('PRAGMA wal_checkpoint(FULL)').get();
          if (Number(checkpoint?.busy ?? 0) !== 0) throw new Error('Database is busy; migration backup could not be completed');
          copyFileSync(dbPath, `${dbPath}.before-v${SCHEMA_VERSION}-${Date.now()}.bak`);
        }
        this.#migrate(version);
      }
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(version: number): void {
    this.#transaction(() => {
      if (version < 1) {
        this.#db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS source_contexts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_events (
          trace_id TEXT NOT NULL, span_id TEXT NOT NULL, source_context TEXT NOT NULL,
          session_id TEXT, end_at TEXT, nano_aiu TEXT, payload TEXT NOT NULL,
          fingerprint TEXT NOT NULL, conflicted INTEGER NOT NULL DEFAULT 0,
          observed_at TEXT NOT NULL, PRIMARY KEY (trace_id, span_id)
        );
        CREATE INDEX IF NOT EXISTS events_month ON usage_events(end_at);
        CREATE INDEX IF NOT EXISTS events_session ON usage_events(source_context, session_id);
        CREATE TABLE IF NOT EXISTS span_classification (
          trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT,
          classification TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL,
          PRIMARY KEY (trace_id, span_id),
          FOREIGN KEY (trace_id, span_id) REFERENCES usage_events(trace_id, span_id)
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, source_context TEXT NOT NULL, session_id TEXT NOT NULL,
          first_seen TEXT, last_seen TEXT, alias TEXT,
          UNIQUE (source_context, session_id)
        );
        CREATE TABLE IF NOT EXISTS quarantine_events (
          trace_id TEXT NOT NULL, span_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
          payload TEXT NOT NULL, observed_at TEXT NOT NULL,
          PRIMARY KEY (trace_id, span_id, fingerprint)
        );
        CREATE TABLE IF NOT EXISTS usage_checkpoints (
          source_context TEXT NOT NULL, session_id TEXT NOT NULL, generation TEXT NOT NULL,
          nano_aiu TEXT, boundary_at TEXT, PRIMARY KEY (source_context, session_id, generation)
        );
        CREATE TABLE IF NOT EXISTS account_snapshots (
          billing_entity TEXT NOT NULL, pool_id TEXT NOT NULL, period TEXT NOT NULL,
          source TEXT NOT NULL, payload TEXT NOT NULL, fetched_at TEXT NOT NULL,
          PRIMARY KEY (billing_entity, pool_id, period, source)
        );
        CREATE TABLE IF NOT EXISTS budget_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS import_cursors (
          file_key TEXT PRIMARY KEY, file_identity TEXT NOT NULL, generation INTEGER NOT NULL,
          byte_offset INTEGER NOT NULL, prefix_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS diagnostics (
          code TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (code, message)
        );
        `);
        this.#db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, now());
      }
      if (version < 2) {
        this.#db.exec(`
          CREATE TABLE retired_traces (
            trace_id TEXT PRIMARY KEY, retired_at TEXT NOT NULL, cutoff_at TEXT NOT NULL,
            span_count INTEGER NOT NULL CHECK (span_count > 0)
          );
          CREATE TABLE retention_status (
            id INTEGER PRIMARY KEY CHECK (id = 1), last_run_at TEXT, cutoff_at TEXT,
            pruned_traces INTEGER NOT NULL DEFAULT 0, pruned_spans INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO retention_status (id) VALUES (1);
        `);
        this.#db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(2, now());
      }
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  #transaction<T>(work: () => T): T {
    if (this.#inTransaction) return work();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally { this.#inTransaction = false; }
  }

  close(): void { this.#db.close(); }
  hasUsageEvents(): boolean {
    return !!this.#db.prepare('SELECT 1 FROM usage_events UNION ALL SELECT 1 FROM retired_traces LIMIT 1').get();
  }

  getRetentionStatus(): RetentionStatus {
    const row = this.#db.prepare('SELECT last_run_at, cutoff_at, pruned_traces, pruned_spans FROM retention_status WHERE id = 1').get()!;
    return { lastRunAt: row.last_run_at === null ? null : String(row.last_run_at), cutoff: row.cutoff_at === null ? null : String(row.cutoff_at),
      prunedTraces: Number(row.pruned_traces), prunedSpans: Number(row.pruned_spans) };
  }

  /** Persist the policy only when its first cleanup also commits successfully. */
  saveSettingsWithRetention(settings: Settings, at?: Date): RetentionStatus {
    return this.#transaction(() => {
      this.setSetting('settings', settings);
      return this.applyRetention(settings.retentionDays, at);
    });
  }

  /** Retire whole traces, retaining their identities permanently so backfill cannot revive their costs. */
  applyRetention(days: number | null, at = new Date()): RetentionStatus {
    if (days === null) return this.getRetentionStatus();
    if (!Number.isInteger(days) || days < 1 || days > 36500) throw new Error('Retention days must be an integer between 1 and 36500, or null');
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || !validTime(at.toISOString())) throw new Error('Invalid retention run time');
    const cutoffDate = new Date(at.getTime() - days * 86_400_000);
    if (!Number.isFinite(cutoffDate.getTime()) || !validTime(cutoffDate.toISOString())) throw new Error('Invalid retention cutoff time');
    const runAt = at.toISOString();
    const cutoff = cutoffDate.toISOString();
    return this.#transaction(() => {
      const traces = new Map<string, { eligible: boolean; spanCount: number }>();
      for (const row of this.#db.prepare('SELECT trace_id, payload, conflicted FROM usage_events').all()) {
        const traceId = String(row.trace_id);
        const trace = traces.get(traceId) ?? { eligible: true, spanCount: 0 };
        const span = JSON.parse(String(row.payload)) as SpanRecord;
        const start = validTime(span.startTime);
        const end = validTime(span.endTime);
        // A conflicting copy may have a later timestamp than the retained original.
        trace.eligible &&= row.conflicted === 0 && start !== null && end !== null && start <= end && end < cutoff;
        trace.spanCount++;
        traces.set(traceId, trace);
      }
      for (const row of this.#db.prepare('SELECT DISTINCT trace_id FROM quarantine_events').all()) {
        const trace = traces.get(String(row.trace_id));
        if (trace) trace.eligible = false;
      }
      let prunedTraces = 0;
      let prunedSpans = 0;
      for (const [traceId, trace] of traces) {
        if (!trace.eligible) continue;
        this.#db.prepare('INSERT INTO retired_traces (trace_id, retired_at, cutoff_at, span_count) VALUES (?, ?, ?, ?)')
          .run(traceId, runAt, cutoff, trace.spanCount);
        this.#db.prepare('DELETE FROM span_classification WHERE trace_id = ?').run(traceId);
        this.#db.prepare('DELETE FROM quarantine_events WHERE trace_id = ?').run(traceId);
        this.#db.prepare('DELETE FROM usage_events WHERE trace_id = ?').run(traceId);
        prunedTraces++;
        prunedSpans += trace.spanCount;
      }
      this.#db.exec(`DELETE FROM sessions WHERE NOT EXISTS (
        SELECT 1 FROM usage_events WHERE usage_events.source_context = sessions.source_context AND usage_events.session_id = sessions.session_id
      )`);
      this.#db.prepare(`UPDATE retention_status SET last_run_at = ?, cutoff_at = ?,
        pruned_traces = pruned_traces + ?, pruned_spans = pruned_spans + ? WHERE id = 1`)
        .run(runAt, cutoff, prunedTraces, prunedSpans);
      return this.getRetentionStatus();
    });
  }

  #diagnose(code: string, message: string): void {
    this.#db.prepare(`INSERT INTO diagnostics (code, message, created_at) VALUES (?, ?, ?)
      ON CONFLICT(code, message) DO UPDATE SET count = count + 1, created_at = excluded.created_at`).run(code, message, now());
  }

  ingest(spans: SpanRecord[]): ImportResult {
    return this.#transaction(() => {
      const result: ImportResult = { accepted: 0, duplicates: 0, conflicts: 0, rejected: 0 };
      for (const raw of spans) {
        const span = normalize(raw);
        if (!span.traceId || !span.spanId) {
          result.rejected++;
          this.#diagnose('invalid-identity', 'A span with an invalid trace or span identifier was rejected.');
          continue;
        }
        if (this.#db.prepare('SELECT 1 FROM retired_traces WHERE trace_id = ?').get(span.traceId)) {
          result.rejected++;
          this.#diagnose('retired-trace', 'A span from a trace already removed by retention was skipped; cleared usage cannot be restored by replay.');
          continue;
        }
        const digest = fingerprint(span);
        const existing = this.#db.prepare('SELECT fingerprint, conflicted FROM usage_events WHERE trace_id = ? AND span_id = ?').get(span.traceId, span.spanId);
        if (existing) {
          if (existing.fingerprint === digest) result.duplicates++;
          else {
            result.conflicts++;
            this.#db.prepare('UPDATE usage_events SET conflicted = 1 WHERE trace_id = ? AND span_id = ?').run(span.traceId, span.spanId);
            this.#db.prepare('INSERT OR IGNORE INTO quarantine_events VALUES (?, ?, ?, ?, ?)').run(span.traceId, span.spanId, digest, JSON.stringify(span), now());
            this.#diagnose('event-conflict', 'Conflicting copies of a trace/span identifier were quarantined; their usage is excluded.');
          }
          continue;
        }
        this.#db.prepare('INSERT OR IGNORE INTO source_contexts VALUES (?, ?)').run(span.sourceContext, now());
        this.#db.prepare(`INSERT INTO usage_events
          (trace_id, span_id, source_context, session_id, end_at, nano_aiu, payload, fingerprint, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(span.traceId, span.spanId, span.sourceContext, span.sessionId, span.endTime, span.nanoAiu, JSON.stringify(span), digest, now());
        this.#db.prepare('INSERT INTO span_classification VALUES (?, ?, ?, ?, ?, ?)').run(span.traceId, span.spanId, span.parentSpanId, 'pending', 'unclassified', now());
        if (span.sessionId) {
          this.#db.prepare(`INSERT INTO sessions (id, source_context, session_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_context, session_id) DO UPDATE SET
              first_seen = CASE WHEN first_seen IS NULL THEN excluded.first_seen WHEN excluded.first_seen IS NULL THEN first_seen ELSE MIN(first_seen, excluded.first_seen) END,
              last_seen = CASE WHEN last_seen IS NULL THEN excluded.last_seen WHEN excluded.last_seen IS NULL THEN last_seen ELSE MAX(last_seen, excluded.last_seen) END`)
            .run(sessionKey(span.sourceContext, span.sessionId), span.sourceContext, span.sessionId, span.startTime, span.endTime);
        }
        if (span.invalidReason) this.#diagnose('invalid-metadata', 'A span contains invalid metering, timing, or ancestry metadata; invalid values are never treated as zero.');
        result.accepted++;
      }
      this.#classify();
      return result;
    });
  }

  #spans(where = '', params: string[] = []): StoredSpan[] {
    return this.#db.prepare(`SELECT e.payload, e.conflicted, c.classification, c.reason
      FROM usage_events e JOIN span_classification c USING (trace_id, span_id) ${where}`).all(...params).map(row => ({
      ...JSON.parse(String(row.payload)) as SpanRecord,
      conflicted: row.conflicted === 1, classification: String(row.classification) as Classification,
      reason: row.reason === null ? null : String(row.reason),
    }));
  }

  /** Mark unresolved calls after their first observation without treating them as billable roots. */
  refreshPendingClassifications(at = new Date()): number {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || !validTime(at.toISOString())) throw new Error('Invalid classification refresh time');
    return this.#transaction(() => this.#classify(at));
  }

  #classify(at = new Date()): number {
    const spans = this.#spans();
    const byId = new Map(spans.map(span => [key(span), span]));
    const observedAt = new Map(this.#db.prepare('SELECT trace_id, span_id, observed_at FROM usage_events').all()
      .map(row => [`${row.trace_id}/${row.span_id}`, Date.parse(String(row.observed_at))]));
    let newlyTimedOut = 0;
    for (const span of spans) {
      let classification: Classification;
      let reason: string | null = null;
      if (span.conflicted) { classification = 'conflict'; reason = 'conflicting-event'; }
      else if (span.invalidReason?.split(',').some(item => ['invalid-parent', 'invalid-time'].includes(item))) {
        classification = 'invalid'; reason = 'invalid-ancestry-or-time';
      } else if (span.operation !== 'invoke_agent') classification = 'child';
      else {
        classification = 'root';
        const seen = new Set<string>([key(span)]);
        let parentId = span.parentSpanId;
        while (parentId) {
          const parentKey = `${span.traceId}/${parentId}`;
          if (seen.has(parentKey)) { classification = 'invalid'; reason = 'ancestry-cycle'; break; }
          seen.add(parentKey);
          const parent = byId.get(parentKey);
          if (!parent) { classification = 'pending'; reason = 'unresolved-ancestor'; break; }
          if (parent.conflicted || parent.invalidReason?.includes('invalid-parent')) {
            classification = 'conflict'; reason = 'ambiguous-ancestor'; break;
          }
          if (!parent.operation) { classification = 'pending'; reason = 'unresolved-ancestor-operation'; break; }
          if (parent.operation === 'invoke_agent') { classification = 'child'; break; }
          parentId = parent.parentSpanId;
        }
        if (classification === 'root') {
          if (!ROOT_CLI_VERSIONS.has(span.serviceVersion ?? '')) { classification = 'pending'; reason = 'unsupported-cli-version'; }
          else if (!span.serverAddress || !span.serverPort) { classification = 'pending'; reason = 'missing-root-markers'; }
          else if (!span.sessionId) { classification = 'invalid'; reason = 'missing-session-id'; }
        }
      }
      const wasTimedOut = span.classification === 'pending' && Boolean(span.reason?.startsWith(PENDING_TIMEOUT_PREFIX));
      const timedOut = classification === 'pending' && (wasTimedOut
        || at.getTime() - (observedAt.get(key(span)) ?? NaN) >= PENDING_CLASSIFICATION_TIMEOUT_MS);
      // Keep the timeout through reason changes and clock rollback; late evidence can still resolve it.
      if (timedOut) reason = `${PENDING_TIMEOUT_PREFIX}${reason ?? 'pending-classification'}`;
      if (classification !== span.classification || reason !== span.reason) {
        if (span.classification === 'root' && classification !== 'root') this.#diagnose('classification-corrected', 'Previously counted usage was removed after conflicting span or ancestor evidence arrived.');
        if (timedOut && !wasTimedOut) {
          this.#diagnose('pending-classification-timeout', 'An agent call is still awaiting verified root evidence 24 hours after first observation; its usage remains excluded until sufficient evidence arrives.');
          newlyTimedOut++;
        } else if (classification === 'pending' && !timedOut) this.#diagnose(reason ?? 'pending-classification', 'A possible agent call is awaiting verified root evidence and is excluded from known usage.');
        if (classification === 'invalid') this.#diagnose(reason ?? 'invalid-classification', 'An agent call cannot be safely classified and is excluded from known usage.');
        if (classification === 'root' && span.nanoAiu === null) this.#diagnose('unknown-metering', 'A verified root call has no valid nano AIU amount; its usage remains unknown.');
        this.#db.prepare('UPDATE span_classification SET classification = ?, reason = ?, updated_at = ? WHERE trace_id = ? AND span_id = ?').run(classification, reason, now(), span.traceId, span.spanId);
      }
    }
    return newlyTimedOut;
  }

  #month(period: string, scope?: UsageScope): StoredSpan[] {
    const [start, end] = periodBounds(period);
    const prefix = scopePrefix(scope);
    return prefix === null ? this.#spans('WHERE e.end_at >= ? AND e.end_at < ?', [start, end])
      : this.#spans('WHERE e.end_at >= ? AND e.end_at < ? AND substr(e.source_context, 1, length(?)) = ?', [start, end, prefix, prefix]);
  }

  summary(period: string, unitVerification: Settings['unitVerification'] = null, scope?: UsageScope): LocalUsage {
    const spans = this.#month(period, scope);
    const aggregate = totals(spans);
    const known = spans.filter(span => span.classification === 'root' && span.nanoAiu !== null);
    const unitVerified = Boolean(unitVerification && metadata(unitVerification.evidence, 4096)
      && Number.isFinite(Date.parse(unitVerification.verifiedAt)) && known.length
      && known.every(span => span.serviceVersion === unitVerification.cliVersion));
    return {
      period, ...aggregate, sessionCount: new Set(spans.filter(span => span.sessionId).map(span => sessionKey(span.sourceContext, span.sessionId!))).size,
      coverage: spans.length ? 'partial' : 'empty', unitVerified,
      credits: unitVerified && aggregate.nanoAiu !== null ? credits(aggregate.nanoAiu) : null,
    };
  }

  /** A finite local basis; neither its known subtotal nor its source IDs establish account identity or complete collection. */
  reconciliationBasis(period: string, cutoff: string | null, unitVerification: Settings['unitVerification'] = null, scope?: UsageScope): ReconciliationBasis {
    const [start, monthEnd] = periodBounds(period);
    const prefix = scopePrefix(scope);
    const matchesScope = (source: string): boolean => prefix === null || source.startsWith(prefix);
    const cutoffTime = timestamp(cutoff);
    const normalizedCutoff = cutoffTime === null ? null : new Date(cutoffTime).toISOString();
    const validCutoff = normalizedCutoff !== null && normalizedCutoff > start && normalizedCutoff <= monthEnd;
    return this.#transaction(() => {
      const blockers = new Set<string>();
      if (cutoff === null) blockers.add('cutoff-missing');
      else if (!validCutoff) blockers.add('cutoff-invalid');
      const eventRows = this.#db.prepare(`SELECT e.trace_id, e.span_id, e.source_context, e.payload, e.fingerprint, e.conflicted,
        c.parent_span_id, c.classification, c.reason FROM usage_events e LEFT JOIN span_classification c USING (trace_id, span_id)
        ORDER BY e.trace_id, e.span_id`).all();
      const quarantineRows = this.#db.prepare('SELECT trace_id, span_id, fingerprint, payload FROM quarantine_events ORDER BY trace_id, span_id, fingerprint').all();
      const sourceRows = this.#db.prepare('SELECT id FROM source_contexts ORDER BY id').all();
      const retiredRows = this.#db.prepare('SELECT trace_id, retired_at, cutoff_at, span_count FROM retired_traces ORDER BY trace_id').all();
      // Rejected rows have no retained event time. Their absence cannot be declared harmless to a selected month.
      const rejectionRows = this.#db.prepare(`SELECT code, message, count FROM diagnostics
        WHERE code IN ('invalid-identity', 'invalid-import-line', 'retired-trace') ORDER BY code, message`).all();
      const spans: StoredSpan[] = eventRows.map(row => ({
        ...JSON.parse(String(row.payload)) as SpanRecord,
        conflicted: row.conflicted === 1,
        classification: row.classification === null ? 'pending' : String(row.classification) as Classification,
        reason: row.reason === null ? null : String(row.reason),
      }));
      const quarantined = quarantineRows.map(row => JSON.parse(String(row.payload)) as SpanRecord);
      const sourceContexts = [...new Set([
        ...sourceRows.map(row => String(row.id)), ...spans.map(span => span.sourceContext), ...quarantined.map(span => span.sourceContext),
      ])].filter(matchesScope).sort();
      const within = (span: SpanRecord): boolean => Boolean(validCutoff && span.endTime && span.endTime >= start && span.endTime < normalizedCutoff!);
      const scoped = spans.filter(span => matchesScope(span.sourceContext) && within(span));
      const aggregate = totals(scoped);
      const known = scoped.filter(span => span.classification === 'root' && span.nanoAiu !== null);
      const unitVerified = Boolean(unitVerification && metadata(unitVerification.evidence, 4096)
        && timestamp(unitVerification.verifiedAt) !== null && known.length
        && known.every(span => span.serviceVersion === unitVerification.cliVersion));
      if (validCutoff && known.length === 0) blockers.add('no-known-root-usage');
      if (scoped.some(span => span.classification === 'root' && span.nanoAiu === null)) blockers.add('unknown-root-metering');
      if (!unitVerified) blockers.add('unit-unverified');
      // Unlocated events, source-less rejection diagnostics and retention tombstones cannot establish scoped coverage.
      if (spans.some(span => validTime(span.endTime) === null) || quarantined.some(span => validTime(span.endTime) === null)) blockers.add('unlocated-events');
      if (rejectionRows.length) blockers.add('unlocated-rejections');
      if (retiredRows.some(row => String(row.cutoff_at) > start)) blockers.add('retention-overlap');

      const byId = new Map(spans.map(span => [key(span), span]));
      const involved = new Set(scoped.map(key));
      // A conflicting copy may move an originally out-of-window event into this interval.
      for (const span of quarantined) {
        if (!matchesScope(span.sourceContext) && !matchesScope(byId.get(key(span))?.sourceContext ?? '')) continue;
        if (!within(span) && validTime(span.endTime) !== null) continue;
        blockers.add('conflicting-events');
        if (byId.has(key(span))) involved.add(key(span));
      }
      for (const spanKey of [...involved]) {
        let current = byId.get(spanKey)!;
        const seen = new Set<string>([spanKey]);
        while (current.parentSpanId) {
          const parentKey = `${current.traceId}/${current.parentSpanId}`;
          if (seen.has(parentKey)) { blockers.add('unresolved-ancestry'); break; }
          seen.add(parentKey);
          const parent = byId.get(parentKey);
          if (!parent) { blockers.add('unresolved-ancestry'); break; }
          if (!matchesScope(parent.sourceContext)) blockers.add('unresolved-ancestry');
          involved.add(parentKey);
          current = parent;
        }
      }
      for (const spanKey of involved) {
        const span = byId.get(spanKey)!;
        if (span.conflicted || span.classification === 'conflict') blockers.add('conflicting-events');
        if (span.classification === 'pending') blockers.add('pending-classification');
        if (span.classification === 'invalid') blockers.add('invalid-classification');
        if (!span.operation) blockers.add('missing-operation');
      }

      const hash = createHash('sha256');
      if (prefix !== null) hash.update(JSON.stringify(['usage-scope-v1', prefix]));
      // Include the entire ledger, including other months and ancestry. Ignore maintenance/observation timestamps and import cursors.
      for (const part of [
        ['basis-v1', period, normalizedCutoff, [...ROOT_CLI_VERSIONS].sort()],
        ['unit-verification', unitVerification === null ? null : [unitVerification.cliVersion, unitVerification.verifiedAt, unitVerification.evidence]],
        ['events', eventRows], ['quarantine', quarantineRows], ['sources', sourceRows], ['retired', retiredRows], ['rejections', rejectionRows],
      ]) hash.update(JSON.stringify(part));
      return { period, cutoff: normalizedCutoff, sourceContexts, knownNanoAiu: aggregate.nanoAiu, knownCalls: aggregate.knownCalls,
        unknownCalls: aggregate.unknownCalls, pendingCalls: aggregate.pendingCalls, unitVerified, blockers: [...blockers].sort(), ledgerHash: hash.digest('hex') };
    });
  }

  #sessionSummary(spans: StoredSpan[]): SessionSummary {
    const first = spans[0]!;
    const times = spans.flatMap(span => [span.startTime, span.endTime]).filter((time): time is string => time !== null).sort();
    return {
      id: sessionKey(first.sourceContext, first.sessionId!), sessionId: first.sessionId!, sourceContext: first.sourceContext,
      firstSeen: times[0] ?? null, lastSeen: times.at(-1) ?? null, ...totals(spans),
      models: [...new Set(spans.map(span => span.model).filter((model): model is string => model !== null))].sort(), coverage: 'partial',
    };
  }

  sessions(period: string, options: { cursor?: string; limit?: number; sort?: string; scope?: UsageScope } = {}): { items: SessionSummary[]; nextCursor: string | null } {
    const prefix = scopePrefix(options.scope);
    const limit = options.limit ?? 50;
    const sort = options.sort ?? 'recent';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Session page limit must be between 1 and 200');
    if (!['usage', 'recent', 'time'].includes(sort)) throw new Error('Unsupported session sort');
    const groups = new Map<string, StoredSpan[]>();
    for (const span of this.#month(period, options.scope)) {
      if (!span.sessionId) continue;
      const id = sessionKey(span.sourceContext, span.sessionId);
      const group = groups.get(id) ?? [];
      group.push(span); groups.set(id, group);
    }
    const all = [...groups.values()].map(spans => this.#sessionSummary(spans));
    all.sort((left, right) => {
      if (sort === 'usage') {
        if (left.nanoAiu === null && right.nanoAiu !== null) return 1;
        if (right.nanoAiu === null && left.nanoAiu !== null) return -1;
        const a = BigInt(left.nanoAiu ?? 0); const b = BigInt(right.nanoAiu ?? 0);
        if (a !== b) return a > b ? -1 : 1;
      }
      return (right.lastSeen ?? '').localeCompare(left.lastSeen ?? '') || left.id.localeCompare(right.id);
    });
    let offset = 0;
    if (options.cursor) {
      let cursor: { period?: string; sort?: string; after?: string; scope?: string };
      try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')); }
      catch { throw new Error('Invalid session cursor'); }
      if (!cursor || cursor.period !== period || cursor.sort !== sort || typeof cursor.after !== 'string'
        || cursor.scope !== (prefix ?? undefined)) throw new Error('Session cursor does not match this query');
      const previous = all.findIndex(item => item.id === cursor.after);
      if (previous < 0) throw new Error('Session cursor is no longer available');
      offset = previous + 1;
    }
    const items = all.slice(offset, offset + limit);
    return { items, nextCursor: offset + limit < all.length ? Buffer.from(JSON.stringify({ period, sort, after: items.at(-1)!.id,
      ...(prefix === null ? {} : { scope: prefix }) })).toString('base64url') : null };
  }

  /** A bounded, content-free monthly page; each row verifies its own contributing root versions. */
  desktopRecords(period: string, options: { cursor?: string; sort?: string; scope?: UsageScope } = {},
    unitVerification: Settings['unitVerification'] = null): { items: DesktopRecord[]; nextCursor: string | null } {
    const page = this.sessions(period, { ...options, limit: 50 });
    const known = new Map<string, StoredSpan[]>();
    for (const span of this.#month(period, options.scope)) {
      if (!span.sessionId || span.classification !== 'root' || span.nanoAiu === null) continue;
      const id = sessionKey(span.sourceContext, span.sessionId);
      const group = known.get(id) ?? []; group.push(span); known.set(id, group);
    }
    const items = page.items.map(({ id, sessionId, firstSeen, lastSeen, nanoAiu, knownCalls, unknownCalls, pendingCalls, models }) => {
      const contributing = known.get(id) ?? [];
      const unitVerified = Boolean(unitVerification && metadata(unitVerification.evidence, 4096)
        && Number.isFinite(Date.parse(unitVerification.verifiedAt)) && contributing.length
        && contributing.every(span => span.serviceVersion === unitVerification.cliVersion));
      return { id, sessionId, firstSeen, lastSeen, nanoAiu, knownCalls, unknownCalls, pendingCalls, models,
        unitVerified, credits: unitVerified && nanoAiu !== null ? credits(nanoAiu) : null };
    });
    return { items, nextCursor: page.nextCursor };
  }

  session(id: string, unitVerification: Settings['unitVerification'] = null, scope?: UsageScope): (SessionSummary & { lifetime: Totals; monthly: Record<string, Totals>; events: StoredSpan[]; modelBreakdown: { model: string; nanoAiu: string | null; calls: number; unknownCalls: number; unitVerified: boolean; source: string }[] }) | null {
    const prefix = scopePrefix(scope);
    const row = this.#db.prepare('SELECT source_context, session_id FROM sessions WHERE id = ?').get(id);
    if (!row || (prefix !== null && !String(row.source_context).startsWith(prefix))) return null;
    const spans = this.#spans('WHERE e.source_context = ? AND e.session_id = ?', [String(row.source_context), String(row.session_id)]);
    if (!spans.length) return null;
    const grouped = new Map<string, StoredSpan[]>();
    for (const span of spans) {
      if (!span.endTime) continue;
      const period = span.endTime.slice(0, 7);
      const group = grouped.get(period) ?? [];
      group.push(span); grouped.set(period, group);
    }
    const chatModels = new Map<string, StoredSpan[]>();
    for (const span of spans.filter(item => item.operation === 'chat')) {
      const model = span.model ?? 'unknown';
      const group = chatModels.get(model) ?? [];
      group.push(span); chatModels.set(model, group);
    }
    const modelBreakdown = [...chatModels].map(([model, chats]) => {
      const metered = chats.filter(chat => chat.nanoAiu !== null && !['invalid', 'conflict', 'pending'].includes(chat.classification));
      const unitVerified = Boolean(unitVerification && metadata(unitVerification.evidence, 4096)
        && Number.isFinite(Date.parse(unitVerification.verifiedAt)) && metered.length
        && metered.every(chat => chat.serviceVersion === unitVerification.cliVersion));
      return { model, nanoAiu: metered.length ? metered.reduce((sum, chat) => sum + BigInt(chat.nanoAiu!), 0n).toString() : null,
        calls: chats.length, unknownCalls: chats.length - metered.length, unitVerified, source: 'chat-spans-detail-not-added-to-root-total' };
    });
    return { ...this.#sessionSummary(spans), lifetime: totals(spans), monthly: Object.fromEntries([...grouped].sort().map(([period, items]) => [period, totals(items)])),
      events: spans.sort((a, b) => (a.endTime ?? '').localeCompare(b.endTime ?? '') || key(a).localeCompare(key(b))), modelBreakdown };
  }

  diagnostics(): Diagnostic[] {
    return this.#db.prepare('SELECT code, message, created_at, count FROM diagnostics ORDER BY created_at DESC, code LIMIT 100').all().map(row => ({
      code: String(row.code), message: String(row.message), createdAt: String(row.created_at), count: Number(row.count),
    }));
  }

  getSetting<T>(setting: string): T | null {
    const row = this.#db.prepare('SELECT value FROM budget_settings WHERE key = ?').get(setting);
    return row ? JSON.parse(String(row.value)) as T : null;
  }

  setSetting(setting: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Setting must be JSON serializable');
    this.#db.prepare('INSERT INTO budget_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(setting, serialized);
  }

  getSnapshot(period: string, options: { entity?: string; source?: string } = {}): UsageSnapshot | null {
    periodBounds(period);
    const where = ['period = ?']; const params = [period];
    if (options.entity) { where.push('billing_entity = ?'); params.push(options.entity); }
    if (options.source) { where.push('source = ?'); params.push(options.source); }
    const row = this.#db.prepare(`SELECT payload FROM account_snapshots WHERE ${where.join(' AND ')} ORDER BY fetched_at DESC LIMIT 1`).get(...params);
    return row ? JSON.parse(String(row.payload)) as UsageSnapshot : null;
  }

  saveSnapshot(snapshot: UsageSnapshot): void {
    const period = snapshot.periodStart.slice(0, 7);
    periodBounds(period);
    this.#db.prepare(`INSERT INTO account_snapshots VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(billing_entity, pool_id, period, source) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`)
      .run(snapshot.billingEntity, snapshot.poolId ?? '', period, snapshot.source, JSON.stringify(snapshot), snapshot.fetchedAt);
  }

  getImportCursor(fileKey: string): ImportCursor | null {
    const row = this.#db.prepare('SELECT * FROM import_cursors WHERE file_key = ?').get(fileKey);
    return row ? { fileKey, fileIdentity: String(row.file_identity), generation: Number(row.generation), offset: Number(row.byte_offset), prefixHash: String(row.prefix_hash) } : null;
  }

  /** Event writes, skipped-line diagnostics and byte cursor commit or roll back together. */
  ingestImport(spans: SpanRecord[], cursor: ImportCursor, rejectedLines = 0): ImportResult {
    return this.#transaction(() => {
      const result = this.ingest(spans);
      if (rejectedLines) {
        result.rejected += rejectedLines;
        this.#diagnose('invalid-import-line', 'Malformed or unsupported complete JSONL lines were skipped; no content was retained.');
      }
      this.#db.prepare(`INSERT INTO import_cursors VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(file_key) DO UPDATE SET file_identity = excluded.file_identity, generation = excluded.generation,
          byte_offset = excluded.byte_offset, prefix_hash = excluded.prefix_hash`)
        .run(cursor.fileKey, cursor.fileIdentity, cursor.generation, cursor.offset, cursor.prefixHash);
      return { ...result, offset: cursor.offset };
    });
  }
}
