import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodeVersion = '24.14.0';
const copilotVersion = '1.0.88';
const archiveName = 'node-v' + nodeVersion + '-win-x64.zip';
// Pinned from the official release SHASUMS256.txt, independently of each download.
const archiveSha256 = '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66';
const nodeSha256 = '63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this distribution on Windows x64.');
const output = join(workspace, 'build', 'windows');
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, 'stage-'));
const payload = join(stage, 'payload');
const app = join(payload, 'app');
await mkdir(app, { recursive: true });
const packageInfo = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(packageInfo.version)) throw new Error('Invalid release version.');
if (packageInfo.dependencies?.['@github/copilot'] !== copilotVersion) throw new Error('The release requires the exactly pinned official Copilot CLI.');
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const helper = join(workspace, 'scripts', 'windows', 'package.ps1');
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(path => path && existsSync(path));
if (!npmCli) throw new Error('Build dependencies require a local npm installation.');
// Preserve registry/proxy configuration, but do not let inherited install-mode
// overrides turn the production payload into a developer installation.
const npmEnvironment = { ...process.env };
for (const name of Object.keys(npmEnvironment)) {
  if (/^npm_config_(?:include|omit|production|only|also|dev|optional)$/i.test(name)) delete npmEnvironment[name];
}

function run(command, args, cwd = workspace, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveRun(stdout) : reject(new Error(command + ' failed (' + code + ')\n' + stdout + stderr)));
  });
}
const npm = args => run(process.execPath, [npmCli, ...args], workspace, npmEnvironment);
const ps = args => run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const step = message => console.log('[Windows EXE] ' + message);
async function bundledCopilotVersion(command) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(command, ['--no-auto-update', '--version'], stage); }
    catch (error) {
      // Windows can briefly deny execution of a freshly extracted native file.
      // Retry only the version probe, never an install or a credential operation.
      if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
      step('Copilot version probe temporarily denied; retry ' + (attempt + 1) + '/4');
      await new Promise(resolveRetry => setTimeout(resolveRetry, 250 * 2 ** attempt));
    }
  }
}

// Keep this application allowlist aligned with scripts/pack-smoke.mjs. npm's
// files field permits whole directories, including stale compiler output.
const applicationFile = /^(?:package\.json|README\.md|LICENSE|docs\/(?:compatibility|validation-guide|npm-package-contents|windows-exe|releasing)\.md|bin\/pilotmeter\.js|dist\/.+\.(?:js|d\.ts|js\.map)|public\/index\.html|public\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|svg|ico))$/;
const privateApplicationFile = /(?:^|\/)(?:\.env(?:\.|$)|test(?:s)?|fixtures|node_modules|\.git|\.npmrc|[^/]*(?:credentials|secrets)[^/]*)(?:\/|$)|\.(?:db|sqlite|log)(?:[.-]|$)/i;
const secretPatterns = [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
function rejectSecrets(name, bytes) {
  // All credential signatures are ASCII. Latin-1 avoids UTF-8 expansion of a native binary.
  const text = bytes.toString('latin1');
  if (secretPatterns.some(pattern => pattern.test(text))) throw new Error('Credential-shaped content in release file: ' + name);
}
async function inspectFile(path, name, scanSecrets = true) {
  const digest = createHash('sha256'); let size = 0; let carry = Buffer.alloc(0);
  for await (const bytes of createReadStream(path, { highWaterMark: 256 * 1024 })) {
    digest.update(bytes); size += bytes.length;
    if (scanSecrets) {
      // Retain more than the longest signature prefix/minimum token length so a
      // credential crossing a read boundary remains detectable. Memory is bounded.
      rejectSecrets(name, Buffer.concat([carry, bytes]));
      carry = bytes.subarray(Math.max(0, bytes.length - 512));
    }
  }
  return { sha256: digest.digest('hex'), size };
}
function sameMembers(actual, expected, label) {
  const left = [...actual].sort(); const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    const extra = left.filter(name => !expected.has(name));
    const missing = right.filter(name => !actual.has(name));
    throw new Error(label + ' differs from the approved release set; extra=' + JSON.stringify(extra) + ', missing=' + JSON.stringify(missing));
  }
}
function productionGraph(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('The release requires a package-lock v3 dependency graph.');
  const selected = new Set();
  const compatible = (values, current) => !values || (!values.includes('!' + current) && (values.every(value => value.startsWith('!')) || values.includes(current)));
  function locate(from, dependency) {
    if (!/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/i.test(dependency)) throw new Error('Unexpected dependency name: ' + dependency);
    for (let base = from; ;) {
      const path = (base ? base + '/' : '') + 'node_modules/' + dependency;
      if (lock.packages[path]) return path;
      if (!base) return null;
      const parent = base.lastIndexOf('/node_modules/');
      base = parent < 0 ? '' : base.slice(0, parent);
    }
  }
  function visit(path) {
    const record = lock.packages[path];
    if (path) {
      if (selected.has(path)) return;
      if (record.dev === true || record.link || !record.version || !record.integrity) throw new Error('Invalid or development-only production dependency: ' + path);
      selected.add(path);
    }
    const dependencies = { ...record.dependencies, ...record.optionalDependencies, ...record.peerDependencies };
    for (const name of Object.keys(dependencies)) {
      const optional = Object.hasOwn(record.optionalDependencies ?? {}, name) || record.peerDependenciesMeta?.[name]?.optional === true;
      const target = locate(path, name);
      if (!target) { if (optional) continue; throw new Error('Missing locked production dependency: ' + name); }
      const next = lock.packages[target];
      if (!compatible(next.os, 'win32') || !compatible(next.cpu, 'x64')) {
        if (optional) continue;
        throw new Error('Production dependency does not support Windows x64: ' + target);
      }
      if (record.peerDependenciesMeta?.[name]?.optional === true && next.dev === true) continue;
      visit(target);
    }
  }
  visit('');
  return selected;
}
async function verifyProductionInstall(lock) {
  const expected = productionGraph(lock); const actual = new Set();
  async function modules(path) {
    let entries;
    try { entries = await readdir(join(app, path), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Dependency links are not permitted in the release: ' + path + '/' + entry.name);
      if ((entry.name === '.bin' && entry.isDirectory()) || (entry.name === '.package-lock.json' && entry.isFile())) continue;
      if (!entry.isDirectory()) throw new Error('Unexpected node_modules member: ' + path + '/' + entry.name);
      const names = entry.name.startsWith('@') ? (await readdir(join(app, path, entry.name), { withFileTypes: true })).map(child => {
        if (!child.isDirectory() || child.isSymbolicLink()) throw new Error('Invalid scoped dependency: ' + child.name);
        return entry.name + '/' + child.name;
      }) : [entry.name];
      for (const name of names) {
        const member = path + '/' + name;
        actual.add(member);
        if (!expected.has(member) || lock.packages[member]?.dev === true) throw new Error('Unexpected dependency installed in the production payload: ' + member);
        const metadata = JSON.parse(await readFile(join(app, member, 'package.json'), 'utf8'));
        if (metadata.version !== lock.packages[member].version || metadata.name !== (lock.packages[member].name ?? name)) throw new Error('Installed dependency does not match its lock record: ' + member);
        const licenses = (await readdir(join(app, member), { withFileTypes: true })).filter(file => file.isFile() && /^(?:licen[cs]e|copying)(?:[.-].*)?$/i.test(file.name));
        if (!licenses.length || !(await Promise.all(licenses.map(file => stat(join(app, member, file.name))))).some(file => file.size > 0)) throw new Error('Production dependency is missing its license: ' + member);
        await modules(member + '/node_modules');
      }
    }
  }
  await modules('node_modules');
  sameMembers(actual, expected, 'Installed production dependencies');
  step('Verified ' + actual.size + ' locked production dependencies and their licenses');
}

step('Build CLI and browser assets');
await npm(['run', 'build']);
step('Prepare the production npm package and locked dependencies');
const pack = JSON.parse(await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', stage]))[0];
if (!pack || typeof pack.filename !== 'string' || /[/\\]/.test(pack.filename)) throw new Error('Unexpected npm pack response.');
if (!Array.isArray(pack.files)) throw new Error('npm pack did not report its file manifest.');
const packageFiles = new Set();
for (const file of pack.files) {
  if (typeof file.path !== 'string' || /[\t\r\n\\:]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || !applicationFile.test(file.path) || privateApplicationFile.test(file.path) || packageFiles.has(file.path)) throw new Error('Unexpected application archive member: ' + file.path);
  packageFiles.add(file.path);
}
for (const required of ['package.json', 'bin/pilotmeter.js', 'dist/cli/main.js', 'dist/daemon/server.js', 'public/index.html', 'README.md', 'LICENSE', 'docs/compatibility.md', 'docs/validation-guide.md', 'docs/npm-package-contents.md', 'docs/windows-exe.md', 'docs/releasing.md']) {
  if (!packageFiles.has(required)) throw new Error('Missing application file: ' + required);
}
for (const extension of ['js', 'css']) if (![...packageFiles].some(name => name.startsWith('public/assets/') && name.endsWith('.' + extension))) throw new Error('Missing built browser ' + extension + ' asset.');
if ('sha512-' + createHash('sha512').update(await readFile(join(stage, pack.filename))).digest('base64') !== pack.integrity) throw new Error('npm package integrity mismatch.');
await run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xzf', join(stage, pack.filename), '-C', app, '--strip-components=1']);
sameMembers(new Set(await files(app)), packageFiles, 'Extracted application files');
for (const file of packageFiles) rejectSecrets(file, await readFile(join(app, file)));
await copyFile(join(workspace, 'package-lock.json'), join(app, 'package-lock.json'));
const lock = JSON.parse(await readFile(join(app, 'package-lock.json'), 'utf8'));
if (lock.version !== packageInfo.version || lock.packages?.['']?.version !== packageInfo.version
  || lock.packages?.['node_modules/@github/copilot']?.version !== copilotVersion
  || lock.packages?.['node_modules/@github/copilot-win32-x64']?.version !== copilotVersion) throw new Error('Release metadata and Copilot runtime do not match the lockfile.');
for (const [name, record] of Object.entries(lock.packages ?? {})) {
  if (record.resolved) {
    const source = new URL(record.resolved);
    if (source.username || source.password) throw new Error('Credential-bearing dependency URL in lockfile: ' + name);
  }
}
await npm(['ci', '--prefix', app, '--include=prod', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
await verifyProductionInstall(lock);
const copilotMember = 'app/node_modules/@github/copilot-win32-x64/copilot.exe';
const copilotExecutable = join(payload, copilotMember);
const copilotOutput = await bundledCopilotVersion(copilotExecutable);
if (!copilotOutput.startsWith('GitHub Copilot CLI ' + copilotVersion + '.')) throw new Error('Unexpected bundled Copilot version.');
await writeFile(join(payload, 'WINDOWS-README.md'), (await readFile(join(workspace, 'docs', 'windows-exe.md'), 'utf8'))
  .replaceAll('](validation-guide.md)', '](app/docs/validation-guide.md)')
  .replaceAll('](releasing.md)', '](app/docs/releasing.md)')
  .replaceAll('](../README.md#', '](app/README.md#'));
await mkdir(join(payload, 'licenses'), { recursive: true });
await copyFile(join(workspace, 'node_modules', 'vite', 'LICENSE.md'), join(payload, 'licenses', 'VITE-LICENSE.md'));
await copyFile(join(app, 'node_modules', '@github', 'copilot', 'LICENSE.md'), join(payload, 'licenses', 'GITHUB-COPILOT-LICENSE.md'));
await writeFile(join(payload, 'THIRD-PARTY-NOTICES.txt'),
  'PilotMeter ' + packageInfo.version + '\n' +
  'PilotMeter: MIT; see app/LICENSE.\n' +
  'Node.js ' + nodeVersion + ': complete notices and component licenses in NODE-LICENSE.txt.\n' +
  'GitHub Copilot CLI ' + copilotVersion + ': redistributed unmodified as a component of PilotMeter under the GitHub Copilot CLI License; see licenses/GITHUB-COPILOT-LICENSE.md.\n' +
  'Copilot package copyright, trademark, attribution, and license notices remain in app/node_modules/@github/copilot and app/node_modules/@github/copilot-win32-x64.\n' +
  'PilotMeter is independently licensed under MIT; its MIT license does not apply to the bundled Copilot CLI.\n' +
  'Production npm dependency licenses are retained under app/node_modules.\n' +
  'The built browser modulepreload helper is from Vite; see licenses/VITE-LICENSE.md.\n' +
  'The launcher uses the Windows-provided .NET Framework; no .NET runtime is redistributed.\n');

step('Download and verify official Node.js ' + nodeVersion + ' x64');
const cached = join(output, archiveName);
let archive;
try { archive = await readFile(cached); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!archive || hash(archive) !== archiveSha256) {
  const response = await fetch('https://nodejs.org/dist/v' + nodeVersion + '/' + archiveName, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('Official Node download failed: HTTP ' + response.status);
  archive = Buffer.from(await response.arrayBuffer());
  if (hash(archive) !== archiveSha256) throw new Error('Official Node archive checksum mismatch. No EXE was produced.');
  await writeFile(cached, archive);
}
await ps(['-Mode', 'ExtractNode', '-Source', cached, '-Destination', payload, '-NodeDirectory', 'node-v' + nodeVersion + '-win-x64']);
if (hash(await readFile(join(payload, 'runtime', 'node.exe'))) !== nodeSha256) throw new Error('Extracted Node executable checksum mismatch.');
// Probe the redistributable, rather than accidentally validating the developer machine's Node.
const runtime = JSON.parse(await run(join(payload, 'runtime', 'node.exe'), ['-e',
  'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");d.exec("SELECT 1");d.close();console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch}))']));
if (runtime.version !== nodeVersion || runtime.platform !== 'win32' || runtime.arch !== 'x64') throw new Error('Unexpected bundled runtime.');

step('Compile the native Windows desktop application');
await mkdir(join(payload, 'desktop'), { recursive: true });
const desktopConfiguration = join(stage, 'DesktopBuildInfo.cs');
await writeFile(desktopConfiguration, 'using System.Reflection;\n[assembly: AssemblyInformationalVersion("' + packageInfo.version + '")]\n');
await ps(['-Mode', 'CompileDesktop', '-Source', join(workspace, 'scripts', 'windows', 'DesktopApp.cs'),
  '-Destination', join(payload, 'desktop', 'PilotMeter.Desktop.exe'), '-Configuration', desktopConfiguration,
  '-ApplicationManifest', join(workspace, 'scripts', 'windows', 'app.manifest'),
  '-ApplicationIcon', join(workspace, 'web', 'assets', 'pilotmeter.ico')]);
await copyFile(join(workspace, 'scripts', 'windows', 'DesktopApp.config'), join(payload, 'desktop', 'PilotMeter.Desktop.exe.config'));

async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('The release must not contain symbolic links: ' + relative);
    if (entry.isDirectory()) result.push(...await files(join(root, entry.name), relative + '/'));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('Unexpected release file type: ' + relative);
  }
  return result.sort();
}
const members = await files(payload);
const lines = [];
let unpackedBytes = 0;
let copilotExecutableSha256;
for (const name of members) {
  if (/[\t\r\n\\:]/.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe release path.');
  if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|[^/]*\.(?:pem|pfx|p12|key)|[^/]*\.(?:db|sqlite|log)(?:[.-][^/]*)?)$/i.test(name)) throw new Error('Private or runtime-state file in release payload: ' + name);
  const scanStarted = performance.now();
  const checked = await inspectFile(join(payload, name), name, name !== 'runtime/node.exe');
  unpackedBytes += checked.size;
  lines.push(checked.sha256 + '\t' + checked.size + '\t' + name);
  if (name === copilotMember) {
    copilotExecutableSha256 = checked.sha256;
    step('Scanned and hashed the unmodified Copilot executable: ' + checked.size + ' bytes in ' + Math.round(performance.now() - scanStarted) + ' ms');
  }
}
if (!copilotExecutableSha256) throw new Error('The official Copilot executable is missing from the payload.');
const fileManifest = join(stage, 'payload-files.tsv');
await writeFile(fileManifest, lines.join('\n') + '\n');
step('Embed verified application and runtime into the Windows launcher');
const zip = join(stage, 'payload.zip');
await ps(['-Mode', 'Zip', '-Source', payload, '-Destination', zip]);
const payloadHash = hash(await readFile(zip));
const config = join(stage, 'BuildInfo.cs');
await writeFile(config, 'using System.Reflection;\n[assembly: AssemblyInformationalVersion("' + packageInfo.version + '")]\n' +
  'internal static class BuildInfo { internal const string Version = "' + packageInfo.version +
  '"; internal const string PayloadHash = "' + payloadHash + '"; }\n');
const name = 'PilotMeter-' + packageInfo.version + '-win-x64.exe';
const built = join(stage, name);
await ps(['-Mode', 'Compile', '-Source', join(workspace, 'scripts', 'windows', 'Launcher.cs'), '-Destination', built,
  '-Configuration', config, '-Payload', zip, '-FileManifest', fileManifest,
  '-ApplicationManifest', join(workspace, 'scripts', 'windows', 'app.manifest'),
  '-ApplicationIcon', join(workspace, 'web', 'assets', 'pilotmeter.ico')]);
const exe = join(output, name);
await copyFile(built, exe);
const exeHash = hash(await readFile(exe));
await writeFile(join(output, name + '.json'), JSON.stringify({
  version: packageInfo.version, platform: 'win32', arch: 'x64', nodeVersion, copilotVersion, copilotExecutableSha256,
  desktop: { defaultEntry: 'pet', mainWindow: 'native-winforms', webView: false, pets: 10 },
  filename: name, sha256: exeHash, bytes: (await stat(exe)).size, unpackedBytes, payloadHash, files: members.length,
  signed: false, nodeArchiveSha256: archiveSha256, nodeExecutableSha256: nodeSha256,
}, null, 2) + '\n');
// Keep a convenient portable bundle alongside the directly runnable EXE.
// Its checksum file validates the EXE; the external list also covers the bundle.
const portable = join(stage, 'portable');
await mkdir(portable);
await copyFile(exe, join(portable, name));
await copyFile(join(output, name + '.json'), join(portable, name + '.json'));
await writeFile(join(portable, 'README.md'), '# PilotMeter ' + packageInfo.version + '\n\n' +
  '双击 ' + name + ' 显示桌面宠物，点击宠物打开主窗口。无需安装 Node/npm/WebView。\n\n' +
  '支持 Windows 10/11 x64 和系统 .NET Framework 4.8。十个宠物可在账户页或右键菜单切换。\n\n' +
  '升级前从旧宠物菜单退出桌面界面，再用旧版 EXE 执行 stop，之后启动新版；账户和账本保留。\n\n' +
  'SHA256SUMS 包含本包 EXE 校验值；版本清单记录运行时与未签名状态。\n\n' +
  '[完整使用指南](https://github.com/Xiejiayun/PilotMeter/blob/v' + packageInfo.version + '/docs/windows-exe.md)\n');
await writeFile(join(portable, 'SHA256SUMS'), exeHash + '  ' + name + '\n');
const portableName = name.replace(/\.exe$/, '.zip');
const portableArchive = join(stage, portableName);
await ps(['-Mode', 'Zip', '-Source', portable, '-Destination', portableArchive]);
await copyFile(portableArchive, join(output, portableName));
const checksums = [];
for (const asset of [name, name + '.json', portableName]) {
  const result = await inspectFile(join(output, asset), asset, false);
  checksums.push(result.sha256 + '  ' + asset);
}
await writeFile(join(output, 'SHA256SUMS'), checksums.join('\n') + '\n');
step('Ready: ' + exe + ' (' + (await stat(exe)).size + ' bytes)');
step('SHA-256: ' + exeHash);
