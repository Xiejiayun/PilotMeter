import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import crossSpawn from 'cross-spawn';

// This smoke test runs the published layout from a clean global prefix. Doctor
// may query the bundled Copilot version; it never publishes, signs in, sends a
// model request, opens a browser, or modifies a real user's settings.
const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
const tempParent = resolve(tmpdir());
const ownedRoot = await mkdtemp(join(tempParent, 'pilotmeter-pack-'));
// npm's generated Windows .cmd shim contains `SET dp0=%~dp0` and cannot run
// from an ampersand-containing prefix. Data/argument paths still exercise &.
const prefix = join(ownedRoot, '安装 prefix 中文 (test)');
const artifacts = join(ownedRoot, 'artifacts');
const dataDir = join(ownedRoot, '真实 ledger 数据 (isolated) & test');
const demoDir = join(dataDir, 'demo');
const cliShim = process.platform === 'win32' ? join(prefix, 'pilotmeter.cmd') : join(prefix, 'bin', 'pilotmeter');
const packageRoot = process.platform === 'win32' ? join(prefix, 'node_modules', manifest.name) : join(prefix, 'lib', 'node_modules', manifest.name);
const globalModules = dirname(packageRoot);
const userNpmConfig = join(ownedRoot, 'user.npmrc');
const globalNpmConfig = join(ownedRoot, 'global.npmrc');
const cliEnvironment = {
  ...process.env,
  COPILOT_HOME: join(ownedRoot, 'isolated copilot settings'),
  PILOTMETER_DATA_DIR: dataDir,
  NPM_CONFIG_CACHE: join(ownedRoot, 'npm-cache'),
  NPM_CONFIG_USERCONFIG: userNpmConfig,
  NPM_CONFIG_GLOBALCONFIG: globalNpmConfig,
  NO_COLOR: '1',
};
for (const key of Object.keys(cliEnvironment)) {
  if (/^(?:PILOTMETER_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN|NODE_PATH|NODE_OPTIONS)$/i.test(key)) delete cliEnvironment[key];
}
const pathKey = Object.keys(cliEnvironment).find(key => key.toLowerCase() === 'path') ?? 'PATH';
cliEnvironment[pathKey] = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${cliEnvironment[pathKey] ?? ''}`;
const npmCandidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
].filter(path => path && /(?:npm-cli\.js|npm\.js)$/.test(path));
let npmCli;
for (const candidate of npmCandidates) if (await exists(candidate)) { npmCli = candidate; break; }
assert.ok(npmCli, 'Cannot locate npm-cli.js beside this Node runtime; run this script through npm run test:pack.');
const npmExecutable = { command: process.execPath, args: [npmCli] };
const serviceDirectories = new Set();
const checks = [];
let report;
let failure;

function announce(message) { console.log(`[pack-smoke] ${message}`); }
function record(message) { checks.push(message); announce(`PASS ${message}`); }
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function terminateOwnedChild(child) {
  if (child.pid && child.exitCode === null) child.kill();
  return Promise.resolve();
}

function run(command, args, { cwd = ownedRoot, timeout = 45_000, env = cliEnvironment } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = crossSpawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolveResult(result);
    };
    const timer = setTimeout(async () => {
      await terminateOwnedChild(child);
      finish(new Error(`${basename(command)} exceeded ${timeout / 1000}s; arguments: ${JSON.stringify(args)}`));
    }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) { child.kill(); finish(new Error('Command output exceeded the smoke-test limit.')); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-256 * 1024); });
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => {
      if (code !== 0) finish(new Error(`${basename(command)} failed (${code ?? signal}): ${JSON.stringify(args)}\n${stdout}\n${stderr}`));
      else finish(null, { stdout, stderr });
    });
  });
}
function npm(args, options) { return run(npmExecutable.command, [...npmExecutable.args, ...args], options); }
function cli(directory, args) { return run(cliShim, ['--data-dir', directory, ...args]); }
function parsePackJson(output) {
  // npm lifecycle output can precede the final --json array.
  for (let position = output.indexOf('['); position >= 0; position = output.indexOf('[', position + 1)) {
    try { const value = JSON.parse(output.slice(position)); if (Array.isArray(value) && value.length === 1 && value[0].filename) return value[0]; } catch { /* Continue to the final JSON array. */ }
  }
  throw new Error('npm pack did not return its package manifest.');
}
async function http(url, path, options = {}) {
  return fetch(`${url}${path}`, { redirect: 'error', signal: AbortSignal.timeout(4_000), ...options });
}
async function jsonAt(url, path) {
  const response = await http(url, path);
  assert.equal(response.status, 200, `${path} must succeed`);
  return response.json();
}
async function verifiedInstance(directory) {
  const instance = await readJson(join(directory, 'instance.json'));
  assert.equal(instance.app, 'pilotmeter');
  assert.equal(instance.version, manifest.version);
  assert.match(instance.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const health = await jsonAt(instance.url, '/health');
  assert.equal(health.app, instance.app);
  assert.equal(health.instanceId, instance.instanceId);
  assert.equal(health.version, manifest.version);
  return instance;
}
async function waitStopped(instance, directory) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    let running = false;
    try {
      const response = await http(instance.url, '/health', { signal: AbortSignal.timeout(600) });
      if (response.ok) running = (await response.json()).instanceId === instance.instanceId;
    } catch { /* A refused connection is the expected stopped state. */ }
    if (!running && !(await exists(join(directory, 'instance.json')))) return;
    await delay(100);
  }
  throw new Error(`Owned service did not stop cleanly: ${directory}`);
}
async function stopThroughShim(directory) {
  const instance = await verifiedInstance(directory);
  await cli(directory, ['stop']);
  await waitStopped(instance, directory);
  assert.deepEqual(JSON.parse((await cli(directory, ['status', '--json'])).stdout), { state: 'stopped' });
}
async function cleanupService(directory) {
  if (!(await exists(join(directory, 'instance.json')))) return;
  const instance = await readJson(join(directory, 'instance.json'));
  assert.equal(instance.app, 'pilotmeter', 'Cleanup only manages this test’s PilotMeter instances');
  assert.match(instance.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  let health;
  try { health = await jsonAt(instance.url, '/health'); }
  catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return;
    throw error; // Unhealthy or unresponsive is not proof that the process exited.
  }
  assert.equal(health.app, instance.app);
  assert.equal(health.instanceId, instance.instanceId, 'Refuse to stop a reused address');
  const response = await http(instance.url, '/api/shutdown', { method: 'POST', headers: { authorization: `Bearer ${instance.managementToken}` } });
  assert.equal(response.status, 200);
  await waitStopped(instance, directory);
}
function assertSafeCleanup() {
  const target = resolve(ownedRoot);
  const relativePath = relative(tempParent, target);
  assert.ok(relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath));
  assert.ok(!relativePath.includes(sep) && basename(target).startsWith('pilotmeter-pack-'));
}

try {
  await mkdir(artifacts, { recursive: true });
  const configuredRegistry = process.env.PILOTMETER_TEST_NPM_REGISTRY || (await npm(['config', 'get', 'registry'], { cwd: workspace, env: { ...process.env, [pathKey]: cliEnvironment[pathKey] } })).stdout.trim();
  const registry = new URL(configuredRegistry);
  assert.equal(registry.protocol, 'https:', 'Package smoke test requires an HTTPS npm registry');
  assert.equal(registry.username + registry.password + registry.search + registry.hash, '', 'Registry URL must not embed credentials or query parameters');
  for (const key of Object.keys(cliEnvironment)) if (key.toLowerCase() === 'npm_config_registry') delete cliEnvironment[key];
  cliEnvironment.NPM_CONFIG_REGISTRY = registry.href;
  await writeFile(userNpmConfig, `registry=${registry.href}\nstrict-ssl=true\nfetch-retries=1\nfetch-timeout=30000\n`);
  await writeFile(globalNpmConfig, '');
  announce('Building and packing the actual npm artifact (no publishing).');
  const packed = parsePackJson((await npm(['pack', '--json', '--pack-destination', artifacts], { cwd: workspace, timeout: 180_000 })).stdout);
  const tarball = join(artifacts, packed.filename);
  assert.equal(basename(packed.filename), packed.filename);
  const archive = await readFile(tarball);
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, packed.integrity);
  const packageFiles = packed.files.map(file => file.path);
  for (const file of packageFiles) {
    assert.ok(/^(?:package\.json|README\.md|LICENSE|docs\/(?:compatibility|validation-guide|npm-package-contents|windows-exe)\.md|bin\/pilotmeter\.js|dist\/.+\.(?:js|d\.ts|js\.map)|public\/index\.html|public\/assets\/[A-Za-z0-9_.-]+\.(?:js|css))$/.test(file), `Unexpected archive member: ${file}`);
    assert.ok(!/(?:^|\/)(?:\.env(?:\.|$)|test(?:s)?|fixtures|node_modules|\.git|\.npmrc|[^/]*(?:credentials|secrets)[^/]*)(?:\/|$)|\.(?:db|sqlite|log)(?:[.-]|$)/i.test(file), `Private/development file in archive: ${file}`);
  }
  for (const required of ['package.json', 'bin/pilotmeter.js', 'dist/cli/main.js', 'dist/daemon/server.js', 'public/index.html', 'README.md', 'LICENSE', 'docs/compatibility.md', 'docs/validation-guide.md', 'docs/npm-package-contents.md', 'docs/windows-exe.md']) assert.ok(packageFiles.includes(required), `Missing package file: ${required}`);
  assert.ok(packageFiles.some(path => /^public\/assets\/.+\.js$/.test(path)), 'Built browser script must be packed');
  assert.ok(packageFiles.some(path => /^public\/assets\/.+\.css$/.test(path)), 'Built stylesheet must be packed');
  record('Archive integrity and strict package contents');

  announce('Installing globally into an isolated Chinese / spaces / parentheses prefix.');
  await npm(['install', '--global', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { timeout: 180_000 });
  await access(cliShim);
  const installed = await readJson(join(packageRoot, 'package.json'));
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.scripts?.postinstall, undefined, 'Installation must not start a service or modify user settings');
  for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
    assert.equal(await exists(join(globalModules, dependency)), false, `Dev dependency installed globally: ${dependency}`);
    assert.equal(await exists(join(packageRoot, 'node_modules', dependency)), false, `Dev dependency installed inside package: ${dependency}`);
  }
  const secretPatterns = [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
  for (const path of packageFiles) {
    const content = await readFile(join(packageRoot, path), 'utf8');
    for (const pattern of secretPatterns) assert.equal(pattern.test(content), false, `Credential-shaped content in package file: ${path}`);
  }
  record('Clean production install, generated global shim, and credential scan');

  const help = (await cli(dataDir, ['--help'])).stdout;
  for (const command of ['doctor', 'start', 'status', 'demo', 'stop']) assert.ok(help.includes(command), `Missing command in installed help: ${command}`);
  assert.equal((await cli(dataDir, ['--version'])).stdout.trim(), manifest.version);
  const doctor = JSON.parse((await cli(dataDir, ['doctor'])).stdout);
  assert.equal(doctor.platform, process.platform);
  assert.equal(doctor.node, process.version);
  assert.match(doctor.copilot, /^GitHub Copilot CLI 1\.0\.88\./, 'The installed platform must include the pinned native Copilot runtime.');
  assert.equal(doctor.service, 'stopped');
  assert.equal(doctor.officialQuota, 'unverified');
  assert.equal(await exists(dataDir), false, 'Read-only help/doctor must not create runtime data');
  assert.deepEqual(JSON.parse((await cli(dataDir, ['status', '--json'])).stdout), { state: 'stopped' });
  record('Installed help, version, read-only doctor, and stopped status');

  serviceDirectories.add(dataDir);
  const started = (await cli(dataDir, ['start', '--background'])).stdout.trim();
  const instance = await verifiedInstance(dataDir);
  assert.ok(started.includes(instance.url));
  await cli(dataDir, ['start', '--background']);
  assert.equal((await verifiedInstance(dataDir)).instanceId, instance.instanceId, 'Repeated start must reuse the same daemon');
  const status = JSON.parse((await cli(dataDir, ['status', '--json'])).stdout);
  assert.equal(status.demo, false);
  assert.equal(status.local.sessionCount, 0);
  assert.equal(status.local.nanoAiu, null);
  assert.equal(status.display.percentage, null);
  assert.notEqual(status.display.mode, 'official');
  const reconciliation = JSON.parse((await cli(dataDir, ['reconcile', 'status', '--json'])).stdout);
  assert.equal(reconciliation.state, 'unknown');
  assert.equal(reconciliation.difference, null);
  assert.equal(status.reconciliation.state, 'unknown');
  record('Installed background service, loopback health, reuse, and unknown empty usage');

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
    assert.equal(response.status, 200, `Installed static resource: ${path}`);
    assert.ok((await response.text()).length > 100);
  }
  await cli(dataDir, ['config', 'set', 'budget.monthlyCredits', '25.125']);
  assert.equal((await jsonAt(instance.url, '/api/settings')).monthlyBudget, '25.125');
  record('Packaged HTML/CSS/JS, CSP, and installed configuration command');

  serviceDirectories.add(demoDir);
  const demoOutput = (await cli(dataDir, ['demo'])).stdout;
  const demoInstance = await verifiedInstance(demoDir);
  assert.notEqual(demoInstance.url, instance.url);
  assert.ok(demoOutput.includes(demoInstance.url));
  const demoStatus = JSON.parse((await cli(demoDir, ['status', '--json'])).stdout);
  assert.equal(demoStatus.demo, true);
  assert.ok(demoStatus.local.sessionCount > 0, 'Demo must have visibly synthetic sessions');
  const realStatus = JSON.parse((await cli(dataDir, ['status', '--json'])).stdout);
  assert.equal(realStatus.demo, false);
  assert.equal(realStatus.local.sessionCount, 0, 'Demo must not modify the real ledger');
  record('Installed demo uses an independent ledger and marks its data');

  await stopThroughShim(demoDir);
  await stopThroughShim(dataDir);
  assert.equal(await exists(join(dataDir, 'usage.db')), true, 'Stop must preserve the ledger');
  await cli(dataDir, ['start', '--background']);
  const restarted = await verifiedInstance(dataDir);
  assert.notEqual(restarted.instanceId, instance.instanceId);
  assert.equal((await jsonAt(restarted.url, '/api/settings')).monthlyBudget, '25.125');
  assert.equal((await jsonAt(restarted.url, '/api/summary')).demo, false);
  await stopThroughShim(dataDir);
  record('Graceful stop, ledger retention, restart, and persisted settings');
  report = { package: `${manifest.name}@${manifest.version}`, platform: process.platform, node: process.version, archiveFiles: packageFiles.length, archiveBytes: archive.length, checks };
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const directory of serviceDirectories) {
    try { await cleanupService(directory); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], `Smoke test retained its directory because a service could not be safely stopped: ${ownedRoot}`);
  } else {
    assertSafeCleanup();
    try { await rm(ownedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { failure = new AggregateError([...(failure ? [failure] : []), error], `Could not remove the owned smoke-test directory: ${ownedRoot}`); }
  }
}
if (failure) throw failure;
console.log(JSON.stringify(report, null, 2));
