import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { instanceAt, request } from '../../dist/daemon/client.js';

const execute = promisify(execFile);
const bin = resolve('bin/pilotmeter.js');

// The bundled CLI performs a real local BYOK call and emits its own telemetry.
// The answer and token counts are synthetic; this does not verify GitHub billing.
test('bundled Copilot run delivers content-free session records through its real OTLP exporter', { timeout: 60_000 }, async t => {
  const prefix = resolve(tmpdir(), 'pilotmeter-bundled-telemetry-');
  const root = await mkdtemp(prefix);
  const state = join(root, 'meter');
  const home = join(root, 'copilot');
  const profile = join(root, 'profile');
  const workspace = join(root, 'workspace');
  await Promise.all([home, profile, workspace].map(path => mkdir(path)));
  const prompt = 'PILOTMETER_SYNTHETIC_PRIVATE_PROMPT: reply briefly without using tools.';
  const answer = 'PILOTMETER_SYNTHETIC_PRIVATE_RESPONSE';
  const requests = [];
  const failures = [];
  const server = createServer(async (incoming, response) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      requests.push(incoming.url);
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
        response.writeHead(502); response.end('Only the synthetic local model is available.'); return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'gpt-4');
      assert.ok(JSON.stringify(body.messages).includes(prompt));
      const common = { id: 'chatcmpl-pilotmeter-synthetic', created: 1790600000, model: 'gpt-4' };
      const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...common, object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage }));
      }
    } catch (error) { failures.push(error); response.writeHead(500); response.end('Synthetic model failure'); }
  });
  server.on('connect', (_incoming, socket) => { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  t.after(async () => {
    const running = await instanceAt(state);
    if (running) await request(running, '/api/shutdown', 'POST');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(join(state, 'writer.lock')); await new Promise(done => setTimeout(done, 50)); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    assert.ok(resolve(root).startsWith(prefix) && resolve(root) !== resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const provider = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:COPILOT_|PILOTMETER_|GITHUB_|GH_|OTEL_|OPENAI_|ANTHROPIC_|NODE_OPTIONS$|NODE_DEBUG$|BASH_ENV$|ENV$|(?:HTTPS?|ALL|NO)_PROXY$)/i.test(key)) delete env[key];
  }
  Object.assign(env, { COPILOT_HOME: home, HOME: profile, USERPROFILE: profile,
    APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile,
    COPILOT_PROVIDER_BASE_URL: `${provider}/v1`, COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'gpt-4',
    HTTP_PROXY: provider, HTTPS_PROXY: provider, ALL_PROXY: provider, NO_PROXY: '127.0.0.1,localhost',
    http_proxy: provider, https_proxy: provider, all_proxy: provider, no_proxy: '127.0.0.1,localhost',
    NO_COLOR: '1' });
  const cli = args => execute(process.execPath, [bin, '--data-dir', state, ...args], {
    cwd: workspace, env, timeout: 40_000, maxBuffer: 256 * 1024, windowsHide: true,
  });
  await cli(['start', '--background']);
  const instance = await instanceAt(state);
  assert.ok(instance);
  assert.deepEqual((await request(instance, '/api/desktop/records')).items, []);
  const sessionId = randomUUID();
  const result = await cli(['run', '--', '--session-id', sessionId, '--no-color', '--no-custom-instructions',
    '--disable-builtin-mcps', '--no-remote', '--no-remote-export', '--log-level', 'error', '-p', prompt]);
  assert.ok(result.stdout.includes(answer));
  assert.deepEqual(failures, []);
  assert.deepEqual(requests, ['/v1/chat/completions']);

  const records = await request(instance, '/api/desktop/records');
  assert.equal(records.items.length, 1, 'root and chat must belong to one visible session');
  const row = records.items[0];
  assert.equal(row.sessionId, sessionId);
  assert.deepEqual(row.models, ['gpt-4']);
  assert.equal(row.knownCalls, 0);
  assert.equal(row.unknownCalls, 1, 'BYOK returns no Copilot amount; missing cost is unknown');
  assert.equal(row.pendingCalls, 0);
  assert.equal(row.nanoAiu, null);
  assert.equal(row.credits, null);
  assert.equal(row.unitVerified, false);
  const details = await request(instance, `/api/sessions/${encodeURIComponent(row.id)}`);
  const rootSpan = details.events.find(span => span.operation === 'invoke_agent');
  const chat = details.events.find(span => span.operation === 'chat');
  assert.ok(rootSpan && chat);
  assert.equal(rootSpan.classification, 'root');
  assert.equal(chat.classification, 'child');
  assert.equal(rootSpan.serviceVersion, '1.0.88');
  assert.equal(chat.parentSpanId, rootSpan.spanId);
  assert.equal(chat.inputTokens, '11');
  assert.equal(chat.outputTokens, '7');
  assert.equal((await request(instance, '/api/desktop')).local.sessionCount, 1);
  const ledgerView = JSON.stringify([records, details]);
  assert.ok(!ledgerView.includes(prompt));
  assert.ok(!ledgerView.includes(answer));
  assert.ok(!ledgerView.includes('chatcmpl-pilotmeter-synthetic'));
});
