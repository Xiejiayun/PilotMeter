import { createHash } from 'node:crypto';
import type { Settings, SpanRecord } from '../shared/types.js';
import type { Repository } from '../storage/repository.js';
import { month } from '../shared/runtime.js';
export function seedDemo(repo: Repository, settings: Settings): Settings {
  const period = month();
  if (repo.getSetting('demo-period') !== period) {
    const events: SpanRecord[] = [];
    for (let i = 0; i < 8; i++) {
      const time = `${period}-${String(Math.min(i + 1, new Date().getUTCDate())).padStart(2, '0')}T08:30:00.000Z`;
      events.push({ traceId: createHash('sha256').update(`pilotmeter-demo-${period}-${i}`).digest('hex').slice(0, 32), spanId: (i + 1).toString(16).padStart(16, '0'), parentSpanId: null,
        sessionId: `demo-session-${Math.floor(i / 2) + 1}`, operation: 'invoke_agent', nanoAiu: i === 7 ? null : String(BigInt((i + 1) * 7) * 1_000_000_000n),
        startTime: time, endTime: time, model: i % 2 ? 'demo-model-b' : 'demo-model-a', inputTokens: '1200', outputTokens: '340', serverAddress: '127.0.0.1', serverPort: 443, serviceVersion: '1.0.88', sourceContext: 'synthetic-demo-only' });
    }
    repo.ingest(events); repo.setSetting('demo-period', period);
  }
  const result: Settings = { ...settings, demo: true, account: null, monthlyBudget: settings.monthlyBudget ?? '150', unitVerification: { cliVersion: '1.0.88', verifiedAt: new Date().toISOString(), evidence: '虚构演示，非真实单位验证或账单' } };
  repo.setSetting('settings', result); return result;
}
