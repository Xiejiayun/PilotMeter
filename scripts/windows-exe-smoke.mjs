import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run with an existing EXE. All application state and fake Copilot files belong
// to one temporary directory; application behavior comes from the EXE. A
// separate windowless contract check compiles the desktop boundary helpers.
// On any failure, retain that directory and never kill a service by its name.
const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
let executable = join(workspace, 'build', 'windows', `PilotMeter-${manifest.version}-win-x64.exe`);
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--help') {
    console.log('Usage: node scripts/windows-exe-smoke.mjs [--exe PATH]\nRequires Windows. Runs the bundled Copilot version command only; never signs in, sends a model request, or opens a browser. Failed runs retain their isolated directory.');
    process.exit(0);
  }
  if (argument !== '--exe' || !process.argv[index + 1]) throw new Error('Expected --exe PATH, or --help.');
  executable = resolve(process.argv[++index]);
}
assert.equal(process.platform, 'win32', 'The EXE smoke test must run on Windows.');
assert.ok((await stat(executable)).isFile(), `Build the Windows EXE first: ${executable}`);
const artifact = await readFile(executable);
assert.equal(artifact.subarray(0, 2).toString('ascii'), 'MZ', 'The artifact must be a Windows executable.');
const peHeader = artifact.readUInt32LE(0x3c);
assert.equal(artifact.readUInt16LE(peHeader + 24 + 68), 2, 'Double-click must use the Windows GUI subsystem, without allocating a console.');
const artifactHash = createHash('sha256').update(artifact).digest('hex');
const tempParent = await realpath(resolve(tmpdir()));
const ownedRoot = await mkdtemp(join(tempParent, 'pilotmeter-exe-'));
const exeDirectory = join(ownedRoot, "单文件 app 空格 & (%) %PATH% ! ' (x)");
const copiedExe = join(exeDirectory, "PilotMeter 中文 & (%) %PATH% ! ' (x).exe");
const localAppData = join(ownedRoot, 'local app data 中文 & (%) !');
const defaultData = join(localAppData, 'PilotMeter');
const dataDir = join(ownedRoot, "真实 ledger 数据 & %PILOTMETER_TEST_SENTINEL% ! ' (x)");
const demoDir = join(dataDir, 'demo');
const decoyData = join(ownedRoot, 'environment data must stay unused');
const profileDir = join(ownedRoot, 'isolated user');
const isolatedTemp = join(ownedRoot, 'temp');
const copilotHome = join(profileDir, '.copilot');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const system32 = join(systemRoot, 'System32');
const checks = [];
const services = new Map();
const directChildren = new Set();
const uncertainChildren = new Set();
let failure;
let cacheDirectory;
let cacheLine;
let cmdShimLimitation = { state: 'not-reached', scope: 'Existing cross-spawn / npm .cmd shim backslash-before-quote parsing' };

const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (/^(?:PATH|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|TEMP|TMP|COPILOT_.*|PILOTMETER_.*|GITHUB_.*|GH_.*|NODE_.*|NPM_.*|OTEL_.*|SSH_CONNECTION|WSL_DISTRO_NAME)$/i.test(key)) delete environment[key];
}
Object.assign(environment, {
  PATH: [system32, systemRoot, join(system32, 'WindowsPowerShell', 'v1.0')].join(';'),
  LOCALAPPDATA: localAppData,
  APPDATA: join(profileDir, 'AppData', 'Roaming'),
  USERPROFILE: profileDir,
  HOME: profileDir,
  HOMEDRIVE: profileDir.slice(0, 2),
  HOMEPATH: profileDir.slice(2),
  TEMP: isolatedTemp,
  TMP: isolatedTemp,
  COPILOT_HOME: copilotHome,
  NO_COLOR: '1',
});

function announce(message) { console.log(`[windows-exe-smoke] ${message}`); }
function record(message) { checks.push(message); announce(`PASS ${message}`); }
function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }
async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
function assertOwned(path) {
  const inside = relative(ownedRoot, resolve(path));
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), `Path escaped the owned fixture: ${path}`);
}
function processAlive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

function run(command, args, { env = environment, input = '', expectedExit = 0, timeout = 60_000, cwd = exeDirectory, detached = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, detached, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    directChildren.add(child);
    const stdout = [], stderr = [];
    let outputBytes = 0, settled = false;
    const output = () => ({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolveResult(result);
    };
    const abandon = reason => {
      if (settled) return;
      // Only this directly spawned child is eligible for termination. A daemon
      // is stopped separately through its verified authenticated endpoint.
      if (child.pid && child.exitCode === null) {
        uncertainChildren.add(child.pid);
        child.kill();
      }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      const captured = output();
      finish(new Error(`${reason}: ${basename(command)} ${JSON.stringify(args)}; direct child exit=${child.exitCode}, signal=${child.signalCode}\n${captured.stdout.slice(-16_384)}\n${captured.stderr.slice(-16_384)}`));
    };
    const timer = setTimeout(() => abandon(`Command exceeded ${timeout / 1000}s; its descendants are not assumed stopped`), timeout);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 4 * 1024 * 1024) { abandon('Command output exceeded the smoke-test limit'); return; }
        chunks.push(chunk);
      });
    }
    child.stdin.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'EOF') abandon(`Failed to deliver stdin (${error.code})`); });
    child.once('error', error => { directChildren.delete(child); finish(error); });
    child.once('close', (code, signal) => {
      directChildren.delete(child);
      const result = { code, signal, ...output() };
      if (code !== expectedExit) finish(new Error(`${basename(command)} exited ${code ?? signal}; expected ${expectedExit}: ${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`));
      else finish(null, result);
    });
    child.stdin.end(input, 'utf8');
  });
}
function cli(directory, args, options) { return run(copiedExe, [...(directory === null ? [] : ['--data-dir', directory]), ...args], options); }

async function http(url, path, options = {}) {
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(path.startsWith('/') && !path.startsWith('//'));
  return fetch(`${url}${path}`, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(10_000) });
}
async function jsonAt(instance, path) {
  const response = await http(instance.url, path);
  assert.equal(response.status, 200, `${path} must succeed`);
  return response.json();
}
function beginStart(directory) {
  assertOwned(directory);
  const previous = services.get(directory);
  if (!previous || previous.stopped) services.set(directory, { instance: null, stopped: false });
}
async function verifiedInstance(directory) {
  assertOwned(directory);
  assert.ok(services.has(directory), 'Only directories explicitly started by this test may be managed.');
  const instance = await readJson(join(directory, 'instance.json'));
  assert.equal(instance.app, 'pilotmeter');
  assert.equal(instance.version, manifest.version);
  assert.match(instance.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(Number.isSafeInteger(instance.pid) && instance.pid > 0);
  assert.equal(typeof instance.instanceId, 'string');
  assert.ok(instance.instanceId.length >= 16);
  assert.match(instance.managementToken, /^[a-f0-9]{64}$/);
  assert.match(instance.collectorToken, /^[a-f0-9]{64}$/);
  const known = services.get(directory).instance;
  if (known) assert.equal(instance.instanceId, known.instanceId, 'Refuse to manage an unexpected replacement instance.');
  const health = await jsonAt(instance, '/health');
  assert.equal(health.app, instance.app);
  assert.equal(health.instanceId, instance.instanceId, 'Refuse to manage a reused address.');
  assert.equal(health.version, manifest.version);
  assert.ok(processAlive(instance.pid), 'The registered daemon process must be alive.');
  const owner = await readJson(join(directory, 'writer.lock', 'owner.json'));
  assert.equal(owner.pid, instance.pid, 'Instance and writer lock must refer to the same owned process.');
  services.get(directory).instance = instance;
  return instance;
}
async function waitStopped(instance, directory) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await exists(join(directory, 'instance.json'))) && !(await exists(join(directory, 'writer.lock'))) && !processAlive(instance.pid)) {
      services.get(directory).stopped = true;
      return;
    }
    await delay(100);
  }
  throw new Error(`Owned daemon did not exit and release its state; retaining ${directory}`);
}
async function stopThroughExe(directory, useDefault = false) {
  const instance = await verifiedInstance(directory);
  await cli(useDefault ? null : directory, ['stop']);
  await waitStopped(instance, directory);
  assert.deepEqual(JSON.parse((await cli(useDefault ? null : directory, ['status', '--json'])).stdout), { state: 'stopped' });
}
async function cleanupService(directory) {
  const state = services.get(directory);
  if (state.stopped) {
    assert.equal(await exists(join(directory, 'instance.json')), false);
    assert.equal(await exists(join(directory, 'writer.lock')), false);
    assert.equal(processAlive(state.instance.pid), false);
    return;
  }
  if (!(await exists(join(directory, 'instance.json')))) {
    // Missing registration after a failed start is not proof that its child
    // exited. Preserve the directory, even if its writer lock is also absent.
    throw new Error(`Unconfirmed startup or shutdown; retaining ${directory}`);
  }
  const instance = await verifiedInstance(directory);
  const response = await http(instance.url, '/api/shutdown', { method: 'POST', headers: { authorization: `Bearer ${instance.managementToken}` } });
  assert.equal(response.status, 200, 'Only the owned, authenticated daemon may be stopped.');
  await response.arrayBuffer();
  await waitStopped(instance, directory);
}
async function assertSafeRemoval() {
  const target = resolve(ownedRoot);
  assert.equal(dirname(target), tempParent);
  assert.ok(basename(target).startsWith('pilotmeter-exe-'));
  assert.equal(await realpath(target), target, 'The temporary root must not have been redirected.');
  const info = await lstat(target);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(directChildren.size, 0, 'All direct test commands must have exited.');
  assert.equal(uncertainChildren.size, 0, 'A timed-out command prevents automatic removal.');
  for (const state of services.values()) assert.equal(state.stopped, true, 'Every owned daemon must be confirmed stopped.');
}
async function assertNoService(directory) {
  for (const name of ['instance.json', 'writer.lock', 'usage.db', 'status.json']) assert.equal(await exists(join(directory, name)), false, `Read-only commands unexpectedly created ${name}`);
}

try {
  announce(`Artifact ${basename(executable)} (${artifact.length} bytes, SHA-256 ${artifactHash})`);
  announce(`Isolated directory: ${ownedRoot}`);
  for (const directory of [exeDirectory, localAppData, environment.APPDATA, profileDir, isolatedTemp, copilotHome]) await mkdir(directory, { recursive: true });
  await copyFile(executable, copiedExe);
  assert.deepEqual(await readdir(exeDirectory), [basename(copiedExe)], 'Only one EXE may be copied beside the launch point.');
  for (const command of ['node', 'npm', 'copilot']) {
    await run(join(system32, 'where.exe'), [command], { expectedExit: 1 });
  }
  record('Single EXE in a hostile Unicode path; child PATH has no Node, npm, or Copilot');

  const firstLaunches = await Promise.all([cli(null, ['--version'], { timeout: 120_000 }), cli(null, ['--version'], { timeout: 120_000 })]);
  for (const result of firstLaunches) assert.equal(result.stdout.trim(), manifest.version);
  const help = (await cli(null, ['--help'], { timeout: 120_000 })).stdout;
  for (const command of ['doctor', 'start', 'status', 'run', 'demo', 'stop']) assert.ok(help.includes(command), `Missing packaged command: ${command}`);
  assert.equal((await cli(null, ['--version'])).stdout.trim(), manifest.version);
  const doctor = JSON.parse((await cli(null, ['doctor'])).stdout);
  assert.equal(doctor.node, 'v24.14.0');
  assert.equal(doctor.platform, 'win32');
    assert.match(doctor.copilot, /^GitHub Copilot CLI 1\.0\.88\./,
      `Doctor must resolve the bundled official Copilot without PATH installation: ${JSON.stringify(doctor.copilotProbe)}`);
  assert.equal(resolve(doctor.dataDirectory), resolve(defaultData));
  assert.equal(doctor.service, 'stopped');
  assert.equal(doctor.officialQuota, 'unverified');
  assert.equal(resolve(doctor.statusline.copilotHome), resolve(copilotHome));
  await assertNoService(defaultData);
  const explicitDoctor = JSON.parse((await cli(dataDir, ['doctor'], { env: { ...environment, PILOTMETER_DATA_DIR: decoyData } })).stdout);
  assert.equal(resolve(explicitDoctor.dataDirectory), resolve(dataDir), '--data-dir must take precedence over the environment.');
  assert.equal(await exists(dataDir), false);
  assert.equal(await exists(decoyData), false);
  assert.deepEqual(JSON.parse((await cli(dataDir, ['status', '--json'])).stdout), { state: 'stopped' });
  const invalid = await cli(null, ['not-a-pilotmeter-command'], { expectedExit: 1 });
  assert.match(invalid.stderr, /unknown command/i);
  await assertNoService(defaultData);
  record('Help/version/doctor, bundled Node and official Copilot versions, data-directory precedence, and invalid-command exit code');

  const cacheRoot = join(defaultData, 'runtime');
  const cacheNames = (await readdir(cacheRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const versionPattern = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cachePattern = new RegExp(`^${versionPattern}-[a-f0-9]{16}$`);
  assert.equal(cacheNames.filter(name => cachePattern.test(name)).length, 1, 'Expected one versioned payload cache.');
  cacheDirectory = join(cacheRoot, cacheNames.find(name => cachePattern.test(name)));
  assertOwned(await realpath(cacheDirectory));
  const bundledNode = join(cacheDirectory, 'runtime', 'node.exe');
  const appRoot = join(cacheDirectory, 'app');
  const bundledCopilot = join(appRoot, 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe');
  for (const path of [bundledNode, bundledCopilot, join(appRoot, 'bin', 'pilotmeter.js'), join(appRoot, 'dist', 'daemon', 'server.js'), join(appRoot, 'dist', 'providers', 'copilot-client.js'), join(appRoot, 'public', 'index.html')]) assert.ok((await stat(path)).isFile(), `Missing cached runtime file: ${path}`);
  const cachedManifest = await readJson(join(appRoot, 'package.json'));
  assert.equal(cachedManifest.name, manifest.name);
  assert.equal(cachedManifest.version, manifest.version);
  assert.equal(cachedManifest.dependencies['@github/copilot'], '1.0.88');
  for (const dependency of ['copilot', 'copilot-win32-x64']) {
    assert.equal((await readJson(join(appRoot, 'node_modules', '@github', dependency, 'package.json'))).version, '1.0.88');
    assert.match(await readFile(join(appRoot, 'node_modules', '@github', dependency, 'LICENSE.md'), 'utf8'), /GitHub Copilot CLI License/);
  }
  const originalCopilotLicense = await readFile(join(appRoot, 'node_modules', '@github', 'copilot', 'LICENSE.md'));
  assert.deepEqual(await readFile(join(cacheDirectory, 'licenses', 'GITHUB-COPILOT-LICENSE.md')), originalCopilotLicense);
  const notices = await readFile(join(cacheDirectory, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  assert.match(notices, /GitHub Copilot CLI 1\.0\.88/);
  assert.match(notices, /MIT license does not apply to the bundled Copilot CLI/);
  const desktopRoot = join(cacheDirectory, 'desktop');
  for (const name of ['PilotMeter.Desktop.exe', 'PilotMeter.Desktop.exe.config'])
    assert.ok((await stat(join(desktopRoot, name))).isFile(), `Missing standalone desktop component: ${name}`);
  assert.equal((await readdir(desktopRoot)).some(name => /webview/i.test(name)), false, 'The native main window must not package a WebView.');
  for (const dependency of Object.keys(cachedManifest.dependencies ?? {})) await access(join(appRoot, 'node_modules', dependency, 'package.json'));
  for (const dependency of Object.keys(cachedManifest.devDependencies ?? {})) assert.equal(await exists(join(appRoot, 'node_modules', dependency)), false, `Development dependency in production payload: ${dependency}`);
  const runtime = JSON.parse((await run(bundledNode, ['-p', 'JSON.stringify({version:process.version,arch:process.arch})'])).stdout);
  assert.deepEqual(runtime, { version: 'v24.14.0', arch: 'x64' });
  record('Concurrent first launches share one complete cache with x64 Node and production dependencies');

  const desktopContracts = await run(process.execPath, [join(workspace, 'scripts', 'test-windows-desktop.mjs')], { env: process.env, cwd: workspace, timeout: 360_000 });
  assert.match(desktopContracts.stdout, /Desktop contracts passed: \d+/);
  assert.match(desktopContracts.stdout, /Native layout: \d+ checks passed/);
  assert.match(desktopContracts.stdout, /Desktop login: \d+ checks passed/);
  assert.match(desktopContracts.stdout, /Desktop recovery checks passed: \d+/);
  console.log(desktopContracts.stdout.trim());
  record('Windowless native checks verify transport boundaries, DPI layouts, login lifecycle, and service recovery');

  beginStart(dataDir);
  const started = (await cli(dataDir, ['start', '--background'], { env: { ...environment, PILOTMETER_DATA_DIR: decoyData } })).stdout;
  const instance = await verifiedInstance(dataDir);
  const widget = await jsonAt(instance, '/api/widget');
  assert.equal(widget.app, 'pilotmeter');
  assert.equal(widget.version, manifest.version);
  assert.equal(widget.instanceId, instance.instanceId);
  assert.equal(widget.state, 'needs-login');
  assert.equal(widget.percentage, null);
  assert.equal(widget.accountLogin, null);
  const desktop = await jsonAt(instance, '/api/desktop');
  assert.equal(desktop.instanceId, instance.instanceId);
  assert.equal(desktop.presentation.primary, null);
  assert.deepEqual(desktop.presentation.buckets, []);
  assert.equal('runCommand' in desktop, false);
  record('GUI launcher packages a native main window; widget and desktop APIs bind unknown login state to the verified daemon');
  assert.ok(started.includes(instance.url));
  assert.equal(await exists(decoyData), false);
  await cli(dataDir, ['start', '--background']);
  assert.equal((await verifiedInstance(dataDir)).instanceId, instance.instanceId);
  const emptyStatus = JSON.parse((await cli(dataDir, ['status', '--json'])).stdout);
  assert.equal(emptyStatus.demo, false);
  assert.equal(emptyStatus.local.sessionCount, 0);
  assert.equal(emptyStatus.local.nanoAiu, null);
  assert.equal(emptyStatus.display.percentage, null);
  assert.notEqual(emptyStatus.display.mode, 'official');
  const activeDoctor = JSON.parse((await cli(dataDir, ['doctor'])).stdout);
  assert.equal(activeDoctor.service.url, instance.url);
  const officialRunVersion = await cli(dataDir, ['run', '--', '--version']);
  assert.match(officialRunVersion.stdout, /^GitHub Copilot CLI 1\.0\.88\./);
  const emptyAccountsResponse = await http(instance.url, '/api/auth/accounts', { headers: { authorization: `Bearer ${instance.managementToken}` } });
  assert.equal(emptyAccountsResponse.status, 200);
  const emptyAccounts = await emptyAccountsResponse.json();
  assert.deepEqual(emptyAccounts.accounts, []); assert.equal(emptyAccounts.activeAccountId, null); assert.equal(emptyAccounts.quota, null);
  assert.deepEqual(await readdir(copilotHome), [], 'Version-only checks must not create real Copilot login state.');
  record('Bundled Copilot run --version works without PATH; account API starts empty and no login is performed');
  record('Detached service startup, authenticated instance ownership, reuse, and unknown empty usage');

  const htmlResponse = await http(instance.url, '/');
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-type'), /text\/html/);
  assert.ok(htmlResponse.headers.get('content-security-policy')?.includes("script-src 'self'"));
  const html = await htmlResponse.text();
  assert.match(html, /<title>PilotMeter/);
  assert.doesNotMatch(html, /(?:src|href)=["']\/main\.ts["']/);
  const assetPaths = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(match => match[1]);
  assert.ok(assetPaths.some(path => path.endsWith('.js')) && assetPaths.some(path => path.endsWith('.css')));
  for (const path of assetPaths) {
    const response = await http(instance.url, path);
    assert.equal(response.status, 200, `Packaged asset: ${path}`);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  record('Bundled dashboard HTML, JavaScript, CSS, and content security policy');

  const attr = (key, value, kind = 'stringValue') => ({ key, value: { [kind]: value } });
  const period = new Date().toISOString().slice(0, 7);
  const time = (BigInt(Date.parse(`${period}-01T00:00:00.000Z`)) * 1_000_000n).toString();
  const telemetry = { resourceSpans: [{ resource: { attributes: [attr('service.version', '1.0.88')] }, scopeSpans: [{ scope: { name: 'synthetic-exe-smoke' }, spans: [{
    traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'),
    startTimeUnixNano: time, endTimeUnixNano: time,
    attributes: [attr('gen_ai.operation.name', 'invoke_agent'), attr('gen_ai.conversation.id', 'synthetic-exe-session 中文'),
      attr('github.copilot.nano_aiu', '2500000000', 'intValue'), attr('server.address', 'api.example.test'), attr('server.port', '443', 'intValue')],
  }] }] }] };
  const postTelemetry = target => http(target.url, '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilotmeter-token': target.collectorToken }, body: JSON.stringify(telemetry) });
  const ingestion = await postTelemetry(instance);
  assert.equal(ingestion.status, 200); await ingestion.arrayBuffer();
  const importPath = join(ownedRoot, "回放 日志 & %PATH% ! ' (x).jsonl");
  await writeFile(importPath, `${JSON.stringify(telemetry)}\n`);
  const imported = JSON.parse((await cli(dataDir, ['import', importPath, '--source-label', 'synthetic 中文 & %PATH% ! "label"'])).stdout);
  assert.equal(imported.duplicates, 1, 'A path with shell characters must import and deduplicate the same trace.');
  await cli(dataDir, ['config', 'set', 'budget.monthlyCredits', '25.125']);
  assert.equal((await jsonAt(instance, '/api/settings')).monthlyBudget, '25.125');
  const usage = JSON.parse((await cli(dataDir, ['status', '--json'])).stdout);
  assert.equal(usage.local.nanoAiu, '2500000000');
  assert.equal(usage.local.knownCalls, 1);
  assert.equal(usage.local.unitVerified, false, 'Synthetic data never establishes a real unit verification.');
  assert.equal(usage.display.percentage, null);
  const cacheText = await readFile(join(dataDir, 'status.json'), 'utf8');
  const cache = JSON.parse(cacheText);
  assert.equal(cache.local.nanoAiu, '2500000000');
  assert.equal(cacheText.includes(instance.managementToken), false);
  assert.equal(cacheText.includes(instance.collectorToken), false);
  const statusline = await cli(dataDir, ['statusline'], { input: '{"synthetic":"stdin 中文"}\n' });
  assert.equal(statusline.stderr, '');
  cacheLine = statusline.stdout.trim();
  assert.equal(cacheLine.split(/\r?\n/).length, 1);
  assert.match(cacheLine, /PilotMeter/);
  assert.match(cacheLine, /2500000000/, 'The EXE must execute its bundled cache reader successfully.');
  record('Synthetic OTLP ingestion, hostile import path, deduplication, settings, and a token-free statusline cache');

  const fakeDir = join(ownedRoot, 'fake copilot 中文 & (test)');
  await mkdir(fakeDir);
  const capturePath = join(fakeDir, 'capture.json');
  const fakeScript = join(fakeDir, 'fake-copilot.cjs');
  const fakeShim = join(fakeDir, 'copilot.cmd');
  const fakeOutput = 'original-cli-output 中文 & %PATH%\n';
  const fakeError = 'original-cli-error 中文\n';
  await writeFile(fakeScript, `const fs = require('node:fs');
if (process.argv.length === 3 && process.argv[2] === '--version') { console.log('1.0.88'); }
else {
  fs.writeFileSync(process.env.PILOTMETER_TEST_CAPTURE, JSON.stringify({
    args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8'), runtime: process.execPath,
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    captureContent: process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
    authenticated: /^x-pilotmeter-token=[a-f0-9]{64}$/.test(process.env.OTEL_EXPORTER_OTLP_HEADERS || ''),
    billingCredentialPresent: Boolean(process.env.PILOTMETER_GITHUB_TOKEN)
  }));
  process.stdout.write(${JSON.stringify(fakeOutput)}); process.stderr.write(${JSON.stringify(fakeError)}); process.exitCode = 7;
}
`);
  await writeFile(fakeShim, '@"%PILOTMETER_TEST_NODE%" "%~dp0fake-copilot.cjs" %*\r\n');
  const fakeEnvironment = { ...environment, PILOTMETER_COPILOT_BIN: fakeShim, PILOTMETER_TEST_NODE: bundledNode,
    PILOTMETER_TEST_CAPTURE: capturePath, PILOTMETER_TEST_SENTINEL: 'must-stay-literal' };
  const fakeDoctor = JSON.parse((await cli(dataDir, ['doctor'], { env: fakeEnvironment })).stdout);
  assert.equal(fakeDoctor.copilot, '1.0.88');
  const argumentsToForward = ['-p', '中文 prompt "quoted" (round) & echo SHOULD_NOT_RUN | pipe', '--name', 'name with spaces',
    '--model=value', '%PILOTMETER_TEST_SENTINEL%', 'a!b^c', '', 'C:\\中文 path\\ends with slash\\'];
  const inputToForward = 'stdin 中文 first line\n"quoted" & | %PATH% ! \\ second line\r\n';
  const forwarded = await cli(dataDir, ['run', '--', ...argumentsToForward], { env: fakeEnvironment, input: inputToForward, expectedExit: 7 });
  assert.equal(forwarded.stdout, fakeOutput, 'The launcher must not add banners or corrupt child stdout.');
  assert.equal(forwarded.stderr, fakeError, 'The launcher must preserve child stderr.');
  const captured = await readJson(capturePath);
  assert.deepEqual(captured.args, argumentsToForward);
  assert.equal(captured.stdin, inputToForward);
  assert.equal(resolve(captured.runtime).toLowerCase(), resolve(bundledNode).toLowerCase());
  assert.equal(captured.endpoint, instance.url);
  assert.equal(captured.captureContent, 'false');
  assert.equal(captured.authenticated, true);
  assert.equal(captured.billingCredentialPresent, false);
  record('Fake npm Copilot shim uses bundled Node and preserves its supported argv, all streams, and exit code 7');

  const boundaryArgument = 'embedded\\\\"quote';
  const boundaryCapture = join(fakeDir, 'cmd-boundary-capture.json');
  const boundaryProbe = "const child=require(process.env.PILOTMETER_TEST_APP+'/node_modules/cross-spawn').sync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});if(child.error)throw child.error;process.exitCode=child.status??1;";
  await run(bundledNode, ['--input-type=commonjs', '-e', boundaryProbe, fakeShim, boundaryArgument], {
    env: { ...fakeEnvironment, PILOTMETER_TEST_APP: appRoot, PILOTMETER_TEST_CAPTURE: boundaryCapture },
    input: inputToForward, expectedExit: 7,
  });
  const boundaryObserved = (await readJson(boundaryCapture)).args;
  assert.equal(boundaryObserved.length, 1);
  if (boundaryObserved[0] !== boundaryArgument) assert.equal(boundaryObserved[0], 'embedded\\\\quote', 'Unexpected new npm shim quoting behavior.');
  cmdShimLimitation = { ...cmdShimLimitation, state: boundaryObserved[0] === boundaryArgument ? 'not-reproduced' : 'reproduced',
    requested: boundaryArgument, received: boundaryObserved[0],
    evidence: 'Direct production cross-spawn to .cmd probe bypasses the EXE and PilotMeter CLI; the native receiver below checks this argument exactly.' };
  announce(`Existing .cmd quoting boundary: ${cmdShimLimitation.state}`);

  // A native receiver isolates launcher argument quoting from cmd.exe/npm shim
  // parsing, which independently rewrites backslash-before-quote combinations.
  const nativeFake = join(fakeDir, 'native-copilot.exe');
  const nativeSource = join(fakeDir, 'NativeCopilot.cs');
  const nativeCapture = join(fakeDir, 'native-capture.txt');
  await writeFile(nativeSource, '\uFEFF' + String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
internal static class NativeCopilot {
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll")] private static extern bool FreeConsole();
  [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  private static string Encode(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? "")); }
  public static int Main(string[] args) {
    if (args.Length == 3 && args[0] == "--probe-console-of") {
      // CREATE_NO_WINDOW can retain a console association without a window.
      // Inspect the target's window, after detaching the probe's own console.
      FreeConsole();
      var attached = AttachConsole(UInt32.Parse(args[1], CultureInfo.InvariantCulture));
      var consoleError = attached ? 0 : Marshal.GetLastWin32Error();
      var window = attached ? GetConsoleWindow() : IntPtr.Zero;
      var result = attached
        ? (window == IntPtr.Zero ? "console:no-window" : (IsWindowVisible(window) ? "console:visible-window" : "console:hidden-window"))
        : "no-console:" + consoleError.ToString(CultureInfo.InvariantCulture);
      if (attached) FreeConsole();
      File.WriteAllText(args[2], result);
      return 0;
    }
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("1.0.88"); return 0; }
    var captured = new List<string>();
    captured.Add(args.Length.ToString(CultureInfo.InvariantCulture));
    foreach (var argument in args) captured.Add(Encode(argument));
    captured.Add(Encode(Console.In.ReadToEnd()));
    captured.Add(Encode(Process.GetCurrentProcess().MainModule.FileName));
    captured.Add(Encode(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT")));
    captured.Add(Encode(Environment.GetEnvironmentVariable("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT")));
    captured.Add(Encode(Regex.IsMatch(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_HEADERS") ?? "", "^x-pilotmeter-token=[a-f0-9]{64}$") ? "true" : "false"));
    captured.Add(Encode(String.IsNullOrEmpty(Environment.GetEnvironmentVariable("PILOTMETER_GITHUB_TOKEN")) ? "false" : "true"));
    File.WriteAllLines(Environment.GetEnvironmentVariable("PILOTMETER_TEST_CAPTURE"), captured.ToArray(), new UTF8Encoding(false));
    byte[] output = Encoding.UTF8.GetBytes("original-cli-output 中文 & %PATH%\n");
    byte[] error = Encoding.UTF8.GetBytes("original-cli-error 中文\n");
    using (var stream = Console.OpenStandardOutput()) stream.Write(output, 0, output.Length);
    using (var stream = Console.OpenStandardError()) stream.Write(error, 0, error.Length);
    return 7;
  }
}
`);
  const compiler = join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/codepage:65001', `/out:${nativeFake}`, nativeSource]);
  const consoleCapture = join(fakeDir, 'node-console.txt');
  await writeFile(join(fakeDir, 'probe-console.cjs'), `const { spawnSync } = require('node:child_process');
for (const [kind, pid] of [['launcher', process.ppid], ['node', process.pid]]) {
  const probe = spawnSync(process.env.PILOTMETER_TEST_CONSOLE_RECEIVER,
    ['--probe-console-of', String(pid), process.env.PILOTMETER_TEST_CONSOLE_CAPTURE + '.' + kind],
    { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  if (probe.error || probe.status !== 0) throw new Error('Packaged Node console probe failed.');
}
`);
  // On Windows DETACHED_PROCESS removes any inherited (including hidden) console.
  // Redirecting stdout alone does not establish the no-console parent scenario.
  const headlessVersion = await cli(null, ['--version'], { cwd: fakeDir, detached: true, env: { ...environment,
    NODE_OPTIONS: '--require=./probe-console.cjs', PILOTMETER_TEST_CONSOLE_RECEIVER: nativeFake,
    PILOTMETER_TEST_CONSOLE_CAPTURE: consoleCapture } });
  assert.equal(headlessVersion.stdout.trim(), manifest.version);
  assert.equal(await readFile(`${consoleCapture}.launcher`, 'utf8'), 'no-console:6', 'The detached fixture must give the GUI launcher no inherited console.');
  assert.ok(['no-console:6', 'console:no-window', 'console:hidden-window'].includes(await readFile(`${consoleCapture}.node`, 'utf8')),
    'Redirected GUI launcher must start its bundled Node without a visible console window.');
  record('Redirected GUI launcher without an inherited console starts bundled Node without a visible console window');
  const nativeEnvironment = { ...environment, PILOTMETER_COPILOT_BIN: nativeFake, PILOTMETER_TEST_CAPTURE: nativeCapture,
    PILOTMETER_TEST_SENTINEL: 'must-stay-literal' };
  const nativeArguments = [...argumentsToForward, 'embedded\\\\"quote', '\\"', 'ends in two backslashes\\\\'];
  const nativeResult = await cli(dataDir, ['run', '--', ...nativeArguments], { env: nativeEnvironment, input: inputToForward, expectedExit: 7 });
  assert.equal(nativeResult.stdout, fakeOutput);
  assert.equal(nativeResult.stderr, fakeError);
  const nativeLines = (await readFile(nativeCapture, 'utf8')).trimEnd().split(/\r?\n/);
  assert.equal(Number(nativeLines.shift()), nativeArguments.length);
  const nativeValues = nativeLines.map(line => Buffer.from(line, 'base64').toString('utf8'));
  assert.deepEqual(nativeValues.slice(0, nativeArguments.length), nativeArguments);
  assert.deepEqual(nativeValues.slice(nativeArguments.length), [inputToForward, nativeFake, instance.url, 'false', 'true', 'false']);
  record('Native fake Copilot verifies exact backslash/quote argv, empty arguments, UTF-8 streams, and exit propagation');

  const settingsPath = join(copilotHome, 'settings.json');
  const originalSettings = { theme: 'dark', footer: { separator: ' | ' } };
  await writeFile(settingsPath, `${JSON.stringify(originalSettings, null, 2)}\n`);
  const installation = JSON.parse((await cli(dataDir, ['init', '--statusline'], { env: nativeEnvironment })).stdout);
  assert.equal(installation.status, 'installed');
  assertOwned(installation.bridgePath);
  const bridge = await readFile(installation.bridgePath, 'utf8');
  assert.ok(bridge.includes(bundledNode.replaceAll("'", "''")), 'The generated bridge must reference the cached Node runtime.');
  assert.ok(bridge.includes(join(appRoot, 'bin', 'pilotmeter.js').replaceAll("'", "''")));
  assert.equal(bridge.includes(copiedExe), false);
  const installedSettings = await readJson(settingsPath);
  assert.equal(installedSettings.footer.showCustom, true);
  assert.equal(installedSettings.theme, originalSettings.theme);
  const relocatedDirectory = join(ownedRoot, '另一处 EXE copy & %PATH% !');
  await mkdir(relocatedDirectory);
  const relocatedExe = join(relocatedDirectory, 'Relocated PilotMeter.exe');
  await copyFile(copiedExe, relocatedExe);
  const parkedExe = `${copiedExe}.parked`;
  assertOwned(copiedExe); assertOwned(parkedExe);
  await rename(copiedExe, parkedExe);
  try {
    assert.equal((await run(relocatedExe, ['--version'], { cwd: relocatedDirectory })).stdout.trim(), manifest.version);
    const bridgeResult = await run(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installation.bridgePath],
      { input: '{"synthetic":"bridge stdin 中文"}\n', cwd: relocatedDirectory });
    assert.equal(bridgeResult.stderr, '');
    assert.equal(bridgeResult.stdout.trim().split(/\r?\n/).length, 1);
    assert.match(bridgeResult.stdout, /2500000000/);
    const restore = JSON.parse((await run(relocatedExe, ['--data-dir', dataDir, 'init', '--restore-statusline'], { cwd: relocatedDirectory })).stdout);
    assert.equal(restore.status, 'restored');
    assert.deepEqual(await readJson(settingsPath), originalSettings);
  } finally { await rename(parkedExe, copiedExe); }
  record('Isolated statusline install/restore and generated PowerShell bridge survive original EXE removal and relocation');

  beginStart(demoDir);
  const demoOutput = (await cli(dataDir, ['demo'])).stdout;
  const demoInstance = await verifiedInstance(demoDir);
  assert.notEqual(demoInstance.url, instance.url);
  assert.notEqual(demoInstance.pid, instance.pid);
  assert.ok(demoOutput.includes(demoInstance.url));
  const demoStatus = JSON.parse((await cli(demoDir, ['status', '--json'])).stdout);
  assert.equal(demoStatus.demo, true);
  assert.ok(demoStatus.local.sessionCount > 0);
  const refusedIngestion = await postTelemetry(demoInstance);
  assert.equal(refusedIngestion.status, 409); await refusedIngestion.arrayBuffer();
  const unchanged = JSON.parse((await cli(dataDir, ['status', '--json'])).stdout);
  assert.equal(unchanged.demo, false);
  assert.equal(unchanged.local.nanoAiu, '2500000000');
  assert.equal(unchanged.local.knownCalls, 1);
  await stopThroughExe(demoDir);
  record('Demo runs independently, labels synthetic data, rejects real ingestion, and leaves the real ledger intact');

  await stopThroughExe(dataDir);
  assert.equal(await exists(join(dataDir, 'usage.db')), true);
  beginStart(dataDir);
  await cli(dataDir, ['start', '--background']);
  const restarted = await verifiedInstance(dataDir);
  assert.notEqual(restarted.instanceId, instance.instanceId);
  const persisted = JSON.parse((await cli(dataDir, ['status', '--json'])).stdout);
  assert.equal(persisted.local.nanoAiu, '2500000000');
  assert.equal(persisted.local.knownCalls, 1);
  assert.equal((await jsonAt(restarted, '/api/settings')).monthlyBudget, '25.125');
  await stopThroughExe(dataDir);
  record('Graceful CLI stop and restart preserve the exact ledger and settings');

  // Native desktop interaction is separately exercised in an interactive
  // session. The headless CLI remains available without creating any windows.
  beginStart(defaultData);
  const defaultLaunch = await cli(null, ['start', '--background']);
  const defaultInstance = await verifiedInstance(defaultData);
  assert.ok(defaultLaunch.stdout.includes(defaultInstance.url));
  const defaultStatus = JSON.parse((await cli(null, ['status', '--json'])).stdout);
  assert.equal(defaultStatus.demo, false);
  assert.equal(defaultStatus.local.nanoAiu, null);
  assert.equal(defaultStatus.local.sessionCount, 0);
  await stopThroughExe(defaultData, true);
  assert.equal((await cli(null, ['--version'])).stdout.trim(), manifest.version);
  assert.deepEqual(await readdir(exeDirectory), [basename(copiedExe)], 'The application must not depend on neighboring extracted files.');
  assert.deepEqual((await readdir(cacheRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name), cacheNames);
  assert.deepEqual(await readJson(join(copilotHome, 'settings.json')), originalSettings, 'The test-owned Copilot settings must be restored.');
  record('Explicit headless start uses isolated LOCALAPPDATA; extracted cache is reused without opening desktop windows');

  for (const state of services.values()) assert.equal(state.stopped, true);
  const cacheVictim = join(appRoot, 'bin', 'pilotmeter.js');
  assertOwned(await realpath(cacheVictim));
  const originalEntry = await readFile(cacheVictim);
  try {
    await writeFile(cacheVictim, Buffer.concat([originalEntry, Buffer.from('\n// Synthetic smoke-test cache integrity mutation.\n')]));
    const refused = await cli(null, ['--version'], { expectedExit: 1 });
    assert.match(refused.stderr, /PilotMeter/);
    assert.equal(refused.stdout.includes(manifest.version), false, 'A changed cached entry point must not run.');
  } finally { await writeFile(cacheVictim, originalEntry); }
  assert.equal((await cli(null, ['--version'])).stdout.trim(), manifest.version);
  record('Stopped cache rejects a modified app file and launches again after exact restoration');
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const directory of [...services.keys()].reverse()) {
    try { await cleanupService(directory); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], `Some owned service exits could not be confirmed; retaining ${ownedRoot}`);
  if (!failure) {
    try {
      await assertSafeRemoval();
      await rm(ownedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) { failure = error; }
  }
}

const report = { package: `${manifest.name}@${manifest.version}`, artifact: executable, artifactSha256: artifactHash,
  artifactBytes: artifact.length, platform: process.platform, bundledNode: 'v24.14.0 / x64', bundledCopilot: '1.0.88 / win32-x64', checks,
  cmdShimLimitation,
  browserAcceptance: 'Only the bundled Copilot version command ran; no login, model session, browser, or desktop window was launched. Widget and native window interactions require separate interactive acceptance.',
  ...(failure ? { retainedDirectory: ownedRoot, failure: String(failure.stack || failure), uncertainChildPids: [...uncertainChildren] } : { result: 'passed' }) };
if (failure) {
  if (failure instanceof AggregateError) report.causes = failure.errors.map(error => String(error.stack || error));
  await writeFile(join(ownedRoot, 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  console.error(`[windows-exe-smoke] FAILED; retained isolated state at ${ownedRoot}`);
  process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
