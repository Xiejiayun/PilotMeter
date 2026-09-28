import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { telemetryEnvironment } from '../../dist/cli/run.js';
import { instanceAt, request } from '../../dist/daemon/client.js';
const exec = promisify(execFile);
const bin = resolve('bin/pilotmeter.js');

test('telemetry overrides signal-specific endpoints only after explicit replacement', () => {
  const original = { PATH: 'unchanged', PILOTMETER_GITHUB_TOKEN: 'fake-billing-secret', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://existing.invalid', OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf', COPILOT_OTEL_FILE_EXPORTER_PATH: 'private.jsonl', OTEL_SDK_DISABLED: 'true', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true' };
  const instance = { url: 'http://127.0.0.1:1000', collectorToken: 'fake-local-token' };
  assert.throws(() => telemetryEnvironment(original, instance), /Existing telemetry/);
  const result = telemetryEnvironment(original, instance, true);
  assert.equal(result.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, undefined);
  assert.equal(result.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, undefined);
  assert.equal(result.COPILOT_OTEL_FILE_EXPORTER_PATH, undefined);
  assert.equal(result.OTEL_SDK_DISABLED, 'false');
  assert.equal(result.PILOTMETER_GITHUB_TOKEN, undefined);
  assert.equal(result.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT, 'false');
  assert.equal(original.OTEL_SDK_DISABLED, 'true');
});

test('run forwards original arguments and exit code via Windows npm shim without corrupting TUI stdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilotmeter-run-'));
  const dir = join(root, '数据 (test) & space'); await mkdir(dir);
  const capture = join(root, 'capture.json');
  await writeFile(join(dir, 'stub.cjs'), `require('node:fs').writeFileSync(process.env.PILOTMETER_TEST_CAPTURE,JSON.stringify({args:process.argv.slice(2),endpoint:process.env.OTEL_EXPORTER_OTLP_ENDPOINT,content:process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT}));process.stdout.write('original-cli-output');process.exitCode=7;`);
  const shim = join(dir, process.platform === 'win32' ? 'copilot.cmd' : 'copilot');
  await writeFile(shim, process.platform === 'win32' ? `@"${process.execPath}" "%~dp0stub.cjs" %*\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'stub.cjs')}' "$@"\n`, { mode: 0o755 });
  const dataDir = join(root, 'state');
  const args = ['-p', '中文 prompt "quoted" (round) & echo injected | pipe', '--name', 'name with spaces', '--model=value', '%PILOTMETER_TEST_SENTINEL%', 'a!b^c'];
  try {
    await assert.rejects(exec(process.execPath, [bin, '--data-dir', dataDir, 'run', '--', ...args], { env: { ...process.env, PILOTMETER_COPILOT_BIN: shim, PILOTMETER_TEST_CAPTURE: capture, PILOTMETER_TEST_SENTINEL: 'must-stay-literal' }, timeout: 15000, windowsHide: true }), error => { assert.equal(error.code, 7); assert.equal(error.stdout, 'original-cli-output'); return true; });
    const output = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(output.args, args); assert.match(output.endpoint, /^http:\/\/127\.0\.0\.1:/); assert.equal(output.content, 'false');
    const statusline = await exec(process.execPath, [bin, '--data-dir', dataDir, 'statusline'], { timeout: 2000, windowsHide: true });
    assert.equal(statusline.stderr, ''); assert.equal(statusline.stdout.trim().split('\n').length, 1);
    const watch = await exec(process.execPath, [bin, '--data-dir', dataDir, 'watch'], { timeout: 3000, windowsHide: true });
    assert.match(watch.stdout, /PilotMeter/); assert.ok(!watch.stdout.includes('\u001b'));
  } finally {
    const instance = await instanceAt(dataDir); if (instance) await request(instance, '/api/shutdown', 'POST');
    await new Promise(r => setTimeout(r, 200)); await rm(root, { recursive: true, force: true });
  }
});

test('profile runs remove inherited account credentials, pin the selected home and require exporter replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilotmeter-profile-run-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const profileHome = join(root, '独立账号 & profile home');
  const capture = join(root, 'child-environment.json');
  const stub = join(root, 'synthetic-copilot.cjs');
  const runner = join(root, 'run-profile.mjs');
  const instance = { url: 'http://127.0.0.1:54321', collectorToken: 'synthetic-profile-collector-token' };
  const observedKeys = ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'PILOTMETER_GITHUB_TOKEN', 'GH_HOST', 'COPILOT_HOME',
    'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'COPILOT_OTEL_ENABLED', 'COPILOT_OTEL_EXPORTER_TYPE', 'COPILOT_OTEL_FILE_EXPORTER_PATH', 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
    'OTEL_TRACES_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER', 'PM_SYNTHETIC_PRESERVED'];
  await writeFile(stub, `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(${JSON.stringify(observedKeys)}.map(key => [key, process.env[key] ?? null])))); process.stdout.write('synthetic-profile-child'); process.exitCode = 7;`);
  await writeFile(runner, `import { runCopilot } from ${JSON.stringify(new URL('../../dist/cli/run.js', import.meta.url).href)};
    try { process.exitCode = await runCopilot(${JSON.stringify(instance)}, ${JSON.stringify([stub, capture])}, process.argv[2] === 'replace', process.execPath, ${JSON.stringify(profileHome)}); }
    catch (error) { process.stderr.write(error.message); process.exitCode = 42; }
  `);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:COPILOT_|PILOTMETER_|GITHUB_|GH_|OTEL_|NODE_OPTIONS$|NODE_DEBUG$|BASH_ENV$|ENV$)/i.test(key)) delete environment[key];
  }
  Object.assign(environment, { GH_TOKEN: 'synthetic-gh-secret', GITHUB_TOKEN: 'synthetic-github-secret',
    COPILOT_GITHUB_TOKEN: 'synthetic-copilot-secret', PILOTMETER_GITHUB_TOKEN: 'synthetic-billing-secret', GH_HOST: 'other.ghe.com',
    COPILOT_HOME: join(root, 'unselected-account-home'), PM_SYNTHETIC_PRESERVED: 'ordinary-environment-kept' });
  const run = (env, replace = false) => exec(process.execPath, [runner, ...(replace ? ['replace'] : [])], { env, timeout: 10000, windowsHide: true });
  const childExit = error => { assert.equal(error.code, 7); assert.equal(error.stdout, 'synthetic-profile-child'); assert.equal(error.stderr, ''); return true; };
  await assert.rejects(run(environment), childExit);
  const expected = { GH_TOKEN: null, GITHUB_TOKEN: null, COPILOT_GITHUB_TOKEN: null, PILOTMETER_GITHUB_TOKEN: null, GH_HOST: null, COPILOT_HOME: profileHome,
    OTEL_EXPORTER_OTLP_ENDPOINT: instance.url, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_HEADERS: `x-pilotmeter-token=${instance.collectorToken}`,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: null, COPILOT_OTEL_ENABLED: 'true', COPILOT_OTEL_EXPORTER_TYPE: 'otlp-http', COPILOT_OTEL_FILE_EXPORTER_PATH: null,
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false', OTEL_TRACES_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none',
    PM_SYNTHETIC_PRESERVED: 'ordinary-environment-kept' };
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), expected);
  await rm(capture);
  const conflicting = { ...environment, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://existing-exporter.invalid/traces',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=synthetic-old-exporter-secret', COPILOT_OTEL_FILE_EXPORTER_PATH: 'synthetic-previous.jsonl' };
  await assert.rejects(run(conflicting), error => {
    assert.equal(error.code, 42); assert.equal(error.stdout, ''); assert.match(error.stderr, /Existing telemetry settings/);
    assert.match(error.stderr, /--replace-telemetry/); assert.ok(!error.stderr.includes('synthetic-old-exporter-secret')); return true;
  });
  await assert.rejects(access(capture), { code: 'ENOENT' });
  await assert.rejects(run(conflicting, true), childExit);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), expected);
});
