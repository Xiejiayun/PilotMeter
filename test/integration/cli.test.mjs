import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
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
