// Synthetic CLI process for account protocol and device-flow tests. Never contacts GitHub.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.MOCK_COPILOT_MODE ?? 'normal';
const isLogin = process.argv.includes('login');
const secret = 'synthetic-private-credential-do-not-forward';
// Replaced into the raw JSON body below so these values never pass through Number.
const exactPercentages = {
  'quota-percentage-nearly-full': '99.999999999999999999',
  'quota-percentage-tiny': '0.000000000000000001',
  'quota-percentage-zero': '0',
  'quota-percentage-full': '100',
  'quota-percentage-overfull': '100.000000000000000001',
  'quota-percentage-negative': '-0.000000000000000001',
  'quota-percentage-unbounded': '1e-256',
  'quota-percentage-missing': 'null',
};
const trace = value => appendFileSync(join(process.env.COPILOT_HOME, 'mock-requests.jsonl'), `${JSON.stringify(value)}\n`);
trace({ args: process.argv.slice(2), home: process.env.COPILOT_HOME,
  overrides: Object.keys(process.env).filter(key => /^(?:COPILOT_|PILOTMETER_|GITHUB_|GH_|OTEL_|NODE_OPTIONS$|NODE_DEBUG$)/i.test(key)).filter(key => key !== 'COPILOT_HOME') });

if (isLogin) {
  const hostIndex = process.argv.indexOf('--host');
  const host = process.argv[hostIndex + 1];
  const loginErrors = {
    // Exact public diagnostic shape observed with CLI 1.0.88 behind a rejecting local proxy.
    'login-network-error': 'Login failed: Error: request failed: error sending request for url (https://github.com/login/device/code)',
    'login-certificate-error': 'Login failed: unable to get local issuer certificate',
    'login-denied': 'Login failed: access_denied',
    'login-expired': 'Login failed: expired_token',
  };
  if (loginErrors[mode]) { process.stderr.write(`${loginErrors[mode]}\n${secret}`); setTimeout(() => process.exit(1), 25); }
  else if (mode === 'login-silent') { /* Simulate a stalled code request. */ }
  else if (mode === 'login-overlong') process.stdout.write('x'.repeat(70_000));
  else if (mode === 'login-no-code') { process.stdout.write('Login complete\n'); setTimeout(() => process.exit(0), 25); }
  else {
    const target = mode === 'login-bad-url' ? 'https://github.com.attacker.invalid' : host;
    process.stdout.write(`Open ${target}/login/`);
    setTimeout(() => process.stderr.write('\u001b[32mFirst copy your one-time code: '), 10);
    setTimeout(() => process.stdout.write('device\n'), 20);
    setTimeout(() => process.stderr.write('ABCD-'), 30);
    setTimeout(() => process.stderr.write('EFGH\u001b[0m\n'), 40);
    if (mode === 'login-conflicting') setTimeout(() => process.stderr.write('Second code: IJKL-MNOP\n'), 50);
    if (mode === 'login-complete') setTimeout(() => { writeFileSync(join(process.env.COPILOT_HOME, 'mock-authenticated'), 'yes'); process.exit(0); }, 150);
    if (mode === 'login-error') setTimeout(() => { process.stderr.write(secret); process.exit(1); }, 150);
  }
  setInterval(() => {}, 1000);
} else {
  // Authentication itself may initialize quota before the first quota RPC.
  let cachedQuota;
  const selection = id => mode === 'cached-quota' ? `${id}-${process.pid}` : id;
  const send = (id, value, error = false) => {
    let body = JSON.stringify({ jsonrpc: '2.0', id, [error ? 'error' : 'result']: value });
    body = body.replace('"exact-large"', '9007199254740993.123456789').replace('"exact-fraction"', '0.123456789123456789');
    body = body.replace('"exact-percentage"', exactPercentages[mode] ?? '42.5');
    const bytes = Buffer.from(body);
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`), bytes]);
    if (mode === 'fragmented') {
      process.stdout.write(frame.subarray(0, 8));
      setTimeout(() => process.stdout.write(frame.subarray(8, 51)), 5);
      setTimeout(() => process.stdout.write(frame.subarray(51)), 10);
    } else if (mode === 'slow-quota' && value?.quotaSnapshots) setTimeout(() => process.stdout.write(frame), 250);
    else if (mode === 'cached-quota' && value?.models || mode === 'held-quota' && value?.quotaSnapshots) {
      const timer = setInterval(() => {
        if (!existsSync(join(process.env.COPILOT_HOME, value?.models ? 'mock-release-models' : 'mock-release-quota'))) return;
        clearInterval(timer); process.stdout.write(frame);
      }, 10);
    }
    else process.stdout.write(frame);
  };
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const length = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/)[1]);
      if (buffer.length < end + 4 + length) return;
      const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      buffer = buffer.subarray(end + 4 + length);
      trace(request);
      if (mode === 'stall') continue;
      if (mode === 'bad-frame') { process.stdout.write('Content-Length: 999999999\r\n\r\n'); continue; }
      if (request.method === 'connect') send(request.id, { ok: true, protocolVersion: 3, version: mode === 'wrong-version' ? '9.0.0' : '1.0.88' });
      else if (request.method === 'auth.getStatus') {
        if (mode === 'cached-quota') cachedQuota ??= JSON.parse(readFileSync(join(process.env.COPILOT_HOME, 'mock-quota.json'), 'utf8'));
        send(request.id, { isAuthenticated: true, host: mode === 'bare-hosts' ? 'GITHUB.COM' : 'https://github.com', login: 'test-user', token: secret });
      }
      else if (request.method === 'account.getAllUsers') {
        if (mode === 'rpc-error' || mode === 'unsupported') send(request.id, { code: mode === 'unsupported' ? -32601 : -32603, message: secret, data: { token: secret } }, true);
        else { send(request.id, [
          { selectionId: selection('account-one'), token: secret, authInfo: { type: 'user', login: 'test-user', host: mode === 'bare-hosts' ? 'github.com' : 'https://github.com', token: secret, copilotUser: { sensitive: secret } } },
          { selectionId: selection('account-two'), authInfo: { type: 'user', login: 'another-user', host: mode === 'bare-hosts' ? 'company.ghe.com' : 'https://company.ghe.com' } },
          { authInfo: { type: 'user', login: 'missing-selection', host: 'https://github.com' } },
          { selectionId: 'wrong-host', authInfo: { type: 'user', login: 'bad-user', host: 'https://github.com.attacker.invalid' } },
        ]); if (mode === 'exit-after-list') setTimeout(() => process.exit(0), 30); }
      } else if (request.method === 'account.getQuota') {
        send(request.id, { quotaSnapshots: { premium_interactions: {
        isUnlimitedEntitlement: false, entitlementRequests: 100, usedRequests: 'exact-large', remainingPercentage: 'exact-percentage',
        overage: 'exact-fraction', usageAllowedWithExhaustedQuota: true, overageAllowedWithExhaustedQuota: false,
        resetDate: '2026-10-01T00:00:00Z', token: secret,
        ...(mode === 'quota-unit' ? { unit: 'ai-credits', billingMode: 'ai-credits' } : {}),
        ...(mode === 'quota-invalid' ? { usedRequests: -1 } : {}),
        ...(mode === 'quota-percentage-nearly-full' ? { usedRequests: '0.000000000000000001' } : {}),
        ...(cachedQuota ?? {}),
      } } });
      }
      else if (request.method === 'models.list') {
        const enabled = { id: 'synthetic-model', name: 'Synthetic Model', policy: { state: 'enabled', terms: secret },
          capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } },
          billing: { multiplier: 'exact-fraction', token: secret }, token: secret, metadata: secret };
        if (mode === 'models-unsupported' || mode === 'models-error') send(request.id,
          { code: mode === 'models-unsupported' ? -32601 : -32603, message: secret, data: { token: secret } }, true);
        else send(request.id, { models: mode === 'models-invalid' ? [{ ...enabled, id: 'unsafe\nmodel' }]
          : mode === 'models-duplicate' ? [enabled, enabled]
          : mode === 'models-many' ? Array.from({ length: 513 }, (_, index) => ({ ...enabled, id: `model-${index}` }))
          : [enabled, { id: 'disabled-model', name: 'Disabled Model', policy: { state: 'disabled', terms: secret } },
            { id: 'unconfigured-model', name: 'Unconfigured Model', policy: { state: 'unconfigured' } },
            { id: 'no-policy-model', name: 'No Policy Model', capabilities: { supports: { vision: 'true' }, limits: { max_context_window_tokens: -1 } }, billing: { multiplier: -2 } }] });
      } else send(request.id, { code: -32601, message: 'Unexpected method' }, true);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
