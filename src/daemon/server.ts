import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, rm } from 'node:fs/promises';
import { Repository } from '../storage/repository.js';
import { parseOtlp } from '../collectors/otlp.js';
import { importJsonl } from '../collectors/jsonl.js';
import { APP, VERSION, prepareDirectory, atomicJson, month, readJson } from '../shared/runtime.js';
import { acquireLock } from './lock.js';
import type { Instance } from './client.js';
import type { Settings, Summary } from '../shared/types.js';

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const defaultSettings: Settings = { monthlyBudget: null, unitVerification: null, account: null, demo: false };
function equal(a: string | undefined, b: string): boolean { return !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Only application/json is supported.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Compressed payloads are not supported.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Request exceeds 2 MiB.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function json(res: ServerResponse, status: number, data: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
export async function serve(dir: string, demo = false): Promise<void> {
  await prepareDirectory(dir);
  const release = await acquireLock(dir);
  let repo: Repository;
  try { repo = new Repository(join(dir, 'usage.db')); } catch (error) { await release(); throw error; }
  const instance: Instance = { app: APP, version: VERSION, pid: process.pid, instanceId: randomUUID(), url: '', managementToken: randomBytes(32).toString('hex'), collectorToken: randomBytes(32).toString('hex') };
  const csrf = randomBytes(32).toString('hex');
  let settings: Settings = { ...defaultSettings, ...repo.getSetting<Settings>('settings'), demo };
  const source = () => createHash('sha256').update(JSON.stringify([hostname(), process.env.COPILOT_HOME || join(homedir(), '.copilot'), settings.account])).digest('hex').slice(0, 24);
  function summary(period = month()): Summary {
    const local = repo.summary(period, settings.unitVerification);
    return { period, local, account: null, display: { mode: 'usage', label: '本机已记录', used: local.nanoAiu, limit: null, percentage: null, unit: 'nano AIU', scope: '启用采集后的本机记录', reason: '官方额度未确认' }, updatedAt: new Date().toISOString(), demo };
  }
  let cacheChain = Promise.resolve();
  function updateCache(): Promise<void> { const snapshot = summary(); cacheChain = cacheChain.then(() => atomicJson(join(dir, 'status.json'), snapshot)); return cacheChain; }
  let closing = false;
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) throw new HttpError(503, 'Service is stopping.');
      if (req.headers.host !== new URL(instance.url).host) throw new HttpError(403, 'Invalid Host.');
      if (req.headers.origin && req.headers.origin !== instance.url) throw new HttpError(403, 'Cross-origin access is forbidden.');
      const url = new URL(req.url || '/', instance.url);
      const route = url.pathname;
      const management = equal(req.headers.authorization, `Bearer ${instance.managementToken}`);
      const collector = equal(req.headers['x-pilotmeter-token'] as string | undefined, instance.collectorToken) || equal(req.headers.authorization, `Bearer ${instance.collectorToken}`);
      if (route.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site API access is forbidden.');
      if (route.startsWith('/v1/')) {
        if (req.method !== 'POST') throw new HttpError(405, 'POST required.');
        if (!collector) throw new HttpError(401, 'Collector authentication required.');
        const payload = await body(req);
        if (route === '/v1/traces') {
          let spans;
          try { spans = parseOtlp(payload, source()); } catch { throw new HttpError(400, 'Invalid OTLP trace structure.'); }
          const result = repo.ingest(spans);
          await updateCache();
          json(res, 200, result.rejected || result.conflicts ? { partialSuccess: { rejectedSpans: String(result.rejected + result.conflicts), errorMessage: 'Some spans were invalid or conflicted; see local diagnostics.' } } : {});
          return;
        }
        const field = route === '/v1/metrics' ? 'resourceMetrics' : route === '/v1/logs' ? 'resourceLogs' : null;
        if (!field) throw new HttpError(404, 'Unknown signal.');
        if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>)[field])) throw new HttpError(400, 'Invalid OTLP signal.');
        json(res, 200, {}); return; // Accepted and discarded: only traces feed the usage ledger.
      }
      if (req.method === 'GET' && route === '/health') { json(res, 200, { app: APP, version: VERSION, instanceId: instance.instanceId }); return; }
      if (req.method === 'GET' && route === '/api/session') { json(res, 200, { csrfToken: csrf }); return; }
      if (route.startsWith('/api/') && req.method !== 'GET' && !management && !(req.headers.origin === instance.url && equal(req.headers['x-pilotmeter-csrf'] as string | undefined, csrf))) throw new HttpError(403, 'Mutation requires local authorization.');
      if (req.method === 'GET' && route === '/api/summary') { json(res, 200, summary(month(url.searchParams.get('period') || undefined))); return; }
      if (req.method === 'GET' && route === '/api/sessions') { json(res, 200, repo.sessions(month(url.searchParams.get('period') || undefined), { cursor: url.searchParams.get('cursor') || undefined, sort: url.searchParams.get('sort') || 'usage', limit: 50 })); return; }
      if (req.method === 'GET' && route.startsWith('/api/sessions/')) { const result = repo.session(decodeURIComponent(route.slice(14))); if (!result) throw new HttpError(404, 'Session not found.'); json(res, 200, result); return; }
      if (req.method === 'GET' && route === '/api/settings') { json(res, 200, settings); return; }
      if (req.method === 'PATCH' && route === '/api/settings') {
        const patch = await body(req) as Record<string, unknown>;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Expected settings object.');
        if (Object.keys(patch).some(key => !['monthlyBudget'].includes(key))) throw new HttpError(400, 'Unknown settings field.');
        if ('monthlyBudget' in patch && patch.monthlyBudget !== null && (typeof patch.monthlyBudget !== 'string' || !/^\d{1,18}(\.\d{1,9})?$/.test(patch.monthlyBudget))) throw new HttpError(400, 'Budget must be a nonnegative decimal string.');
        settings = { ...settings, ...patch } as Settings;
        repo.setSetting('settings', settings); await updateCache(); json(res, 200, settings); return;
      }
      if (req.method === 'GET' && route === '/api/diagnostics') { json(res, 200, { items: repo.diagnostics(), collection: 'Traces only; metrics and logs are acknowledged without storage.' }); return; }
      if (req.method === 'POST' && route === '/api/import') {
        if (!management) throw new HttpError(403, 'Import requires CLI authentication.');
        const input = await body(req) as { path?: unknown };
        if (typeof input?.path !== 'string') throw new HttpError(400, 'File path required.');
        const result = await importJsonl(repo, input.path, source()); await updateCache(); json(res, 200, result); return;
      }
      if (req.method === 'POST' && route === '/api/shutdown') {
        if (!management) throw new HttpError(403, 'Shutdown requires CLI authentication.');
        json(res, 200, { stopping: true }); setImmediate(() => { void shutdown(); }); return;
      }
      if (req.method === 'GET' && !route.startsWith('/api/')) {
        if (route !== '/' && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(route)) throw new HttpError(404, 'Not found.');
        const path = fileURLToPath(new URL(`../../public${route === '/' ? '/index.html' : route}`, import.meta.url));
        try {
          const bytes = await readFile(path);
          res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(path)] || 'application/octet-stream' }); res.end(bytes);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (route !== '/') throw new HttpError(404, 'Not found.');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PilotMeter</title><h1>PilotMeter</h1><p>本地采集服务已运行。使用 pilotmeter status 查看用量。</p></html>');
        }
        return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof RangeError || /period must|cursor|YYYY-MM/i.test((error as Error).message) ? 400 : 500;
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Local operation failed; data was not cleared.' : (error as Error).message }); else res.end();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  async function shutdown(): Promise<void> {
    if (closing) return; closing = true;
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
      server.close(() => { clearTimeout(deadline); resolve(); }); server.closeIdleConnections();
    });
    await cacheChain.catch(() => {}); repo.close();
    if ((await readJson<Instance>(join(dir, 'instance.json')))?.instanceId === instance.instanceId) await rm(join(dir, 'instance.json'), { force: true });
    await release();
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    instance.url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    await updateCache(); await atomicJson(join(dir, 'instance.json'), instance);
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) { server.close(); repo.close(); await release(); throw error; }
}
