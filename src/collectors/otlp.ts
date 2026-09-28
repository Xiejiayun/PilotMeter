import { isIP } from 'node:net';
import type { SpanRecord } from '../shared/types.js';

/** Only these metadata attributes ever cross the collector boundary. */
const ATTRIBUTES = new Set([
  'gen_ai.operation.name', 'gen_ai.conversation.id', 'github.copilot.nano_aiu',
  'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens', 'server.address', 'server.port', 'service.version',
]);
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;

export function integer(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^\d{1,100}$/.test(value)) return null;
  return BigInt(value).toString();
}

function scalar(value: unknown): unknown {
  const item = object(value);
  if (!item) return undefined;
  const keys = Object.keys(item);
  if (keys.length !== 1) return undefined;
  if (typeof item.stringValue === 'string') return item.stringValue;
  if ('intValue' in item) return integer(item.intValue) ?? undefined;
  if (typeof item.doubleValue === 'number') return item.doubleValue;
  if (typeof item.boolValue === 'boolean') return item.boolValue;
  return undefined;
}

function attributes(value: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (value === undefined) return result;
  if (!Array.isArray(value)) throw new Error('OTLP attributes must be an array');
  for (const entry of value) {
    const item = object(entry);
    if (!item || typeof item.key !== 'string') throw new Error('Malformed OTLP attribute');
    if (!ATTRIBUTES.has(item.key)) continue;
    // Repeated attribute keys are ambiguous, even when the values look identical.
    if (result.has(item.key)) result.set(item.key, undefined);
    else result.set(item.key, scalar(item.value));
  }
  return result;
}

export function metadata(value: unknown, maxLength = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

export function serverAddress(value: unknown): string | null {
  const host = metadata(value, 253);
  if (!host) return null;
  if (isIP(host) || (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)))) return host;
  return /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/.test(host)
    ? host : null;
}

export function identifier(value: unknown, length: 16 | 32): string | null {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
      || /^0+$/.test(value)) return null;
  return value.toLowerCase();
}

function timestamp(value: unknown): string | null {
  const number = integer(value);
  if (number === null) return null;
  const milliseconds = BigInt(number) / 1_000_000n;
  if (milliseconds > 253402300799999n) return null;
  return new Date(Number(milliseconds)).toISOString();
}

/** Decode OTLP/HTTP JSON; never retain span names, messages, events, links, or arbitrary attributes. */
export function parseOtlp(payload: unknown, sourceContext: string): SpanRecord[] {
  const envelope = object(payload);
  if (!envelope || !Array.isArray(envelope.resourceSpans)) throw new Error('Expected OTLP resourceSpans');
  if (!metadata(sourceContext, 512)) throw new Error('Invalid source context');
  const result: SpanRecord[] = [];
  for (const rawResource of envelope.resourceSpans) {
    const resource = object(rawResource);
    if (!resource || !Array.isArray(resource.scopeSpans)) throw new Error('Expected OTLP scopeSpans');
    const resourceAttributes = attributes(object(resource.resource)?.attributes);
    for (const rawScope of resource.scopeSpans) {
      const scope = object(rawScope);
      if (!scope || !Array.isArray(scope.spans)) throw new Error('Expected OTLP spans');
      const scopeAttributes = attributes(object(scope.scope)?.attributes);
      for (const rawSpan of scope.spans) {
        const span = object(rawSpan);
        if (!span) throw new Error('Malformed OTLP span');
        const values = new Map([...resourceAttributes, ...scopeAttributes, ...attributes(span.attributes)]);
        const cost = values.get('github.copilot.nano_aiu');
        const nanoAiu = integer(cost);
        const startTime = timestamp(span.startTimeUnixNano);
        const endTime = timestamp(span.endTimeUnixNano);
        const port = integer(values.get('server.port'));
        const reasons: string[] = [];
        const traceId = identifier(span.traceId, 32);
        const spanId = identifier(span.spanId, 16);
        const parentSpanId = span.parentSpanId === undefined || span.parentSpanId === ''
          || span.parentSpanId === '0000000000000000' ? null : identifier(span.parentSpanId, 16);
        if (!traceId || !spanId) reasons.push('invalid-identity');
        if (span.parentSpanId && span.parentSpanId !== '0000000000000000' && !parentSpanId) reasons.push('invalid-parent');
        if (values.has('github.copilot.nano_aiu') && nanoAiu === null) reasons.push('invalid-metering');
        if (['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'].some(name => values.has(name) && integer(values.get(name)) === null)) reasons.push('invalid-tokens');
        if (!startTime || !endTime || endTime < startTime) reasons.push('invalid-time');
        result.push({
          traceId: traceId ?? '', spanId: spanId ?? '', parentSpanId,
          sessionId: metadata(values.get('gen_ai.conversation.id')),
          operation: metadata(values.get('gen_ai.operation.name'), 64), nanoAiu,
          startTime, endTime,
          model: metadata(values.get('gen_ai.response.model')) ?? metadata(values.get('gen_ai.request.model')),
          inputTokens: integer(values.get('gen_ai.usage.input_tokens')),
          outputTokens: integer(values.get('gen_ai.usage.output_tokens')),
          serverAddress: serverAddress(values.get('server.address')),
          serverPort: port !== null && BigInt(port) >= 1n && BigInt(port) <= 65535n ? Number(port) : null,
          serviceVersion: metadata(values.get('service.version'), 64), sourceContext,
          invalidReason: reasons.length ? reasons.join(',') : null,
        });
      }
    }
  }
  return result;
}
