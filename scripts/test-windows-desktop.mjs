import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiles shipping native sources. Layout forms render at zero opacity; no visible windows.
const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.includes('--help')) { console.log('Usage: node scripts/test-windows-desktop.mjs\nWindows x64 native contracts and isolated loopback transport checks. No visible windows or external network.'); process.exit(0); }
assert.equal(process.argv.length, 2, 'This test takes no arguments.');
assert.equal(process.platform, 'win32', 'Desktop contracts require Windows.');
assert.equal(process.arch, 'x64', 'Desktop contracts require Windows x64.');
const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
assert.ok((await stat(compiler)).isFile(), 'The .NET Framework C# compiler is required.');
const temporaryParent = await realpath(resolve(tmpdir()));
const temporary = await mkdtemp(join(temporaryParent, 'pilotmeter-desktop-contracts-'));
const executable = join(temporary, 'DesktopContractTests.exe');
let passed = false;

function run(command, args, timeout = 30_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: temporary, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop contract command timed out.')); }, timeout);
    const collect = chunk => {
      output += chunk;
      if (output.length > 128 * 1024) { child.kill(); clearTimeout(timer); reject(new Error('Desktop contract output exceeded its bound.')); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Desktop contract command failed (' + code + '):\n' + output));
      else resolveRun(output.trim());
    });
  });
}

let scenario = 'normal', foreign = false;
const csrf = 'a'.repeat(64);
const fixture = createServer(async (req, res) => {
  const send = (value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.headers['x-pilotmeter-instance'] !== '11111111-1111-4111-8111-111111111111') { send({ error: 'missing expected instance' }, 409); return; }
  if (req.url === '/health') { const id = foreign ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111'; foreign = false; send({ app: 'pilotmeter', version: 'contract', instanceId: id }); return; }
  if (req.url === '/api/session') { send({ csrfToken: csrf }); return; }
  if (req.url === '/api/auth/select' && req.method === 'POST') {
    if (req.headers.origin !== fixtureOrigin || req.headers['x-pilotmeter-csrf'] !== csrf || req.headers.authorization) { send({ error: 'incorrect native authorization' }, 403); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    scenario = JSON.parse(body).accountId;
    send({ result: 'authorized' }); return;
  }
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/api/desktop' || pathname === '/api/desktop/records') { send({ result: 'read' }); return; }
  if (req.url === '/api/auth/accounts') {
    if (scenario === 'medium') { send({ result: 'read', content: 'x'.repeat(70000) }); return; }
    if (scenario === 'redirect') { res.writeHead(302, { location: 'https://example.invalid/' }); res.end(); return; }
    if (scenario === 'oversized') { send({ content: 'x'.repeat(1024 * 1024 + 1) }); return; }
    if (scenario === 'error') { send({ error: 'synthetic error' }, 409); return; }
    if (scenario === 'pending') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"result":'); return; }
    if (scenario === 'foreign-conflict') { send({ error: '本机服务已更换，请重新连接。' }, 409); return; }
    if (scenario === 'foreign') foreign = true;
    send({ result: 'read' }); return;
  }
  send({ error: 'unexpected endpoint' }, 404);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;


try {
  await copyFile(join(workspace, 'scripts', 'windows', 'DesktopApp.config'), executable + '.config');
  const physical = join(temporary, "data 空格 & %PATH% ! ' (x)");
  const alias = join(temporary, 'data-junction');
  await mkdir(physical);
  await symlink(physical, alias, 'junction');
  const contractArguments = [
    '/nologo', '/target:exe', '/platform:x64', '/langversion:5', '/main:DesktopContractTests', '/out:' + executable,
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Net.Http.dll', '/reference:System.Web.Extensions.dll',
    ...['pilot', 'cat', 'shiba', 'penguin', 'slime', 'robot', 'cloud', 'sprout', 'jellyfish', 'dragon'].map((name, index) => {
      const id = String(index + 1).padStart(2, '0');
      return '/resource:' + join(workspace, 'docs', 'design', 'pets', `pet-${id}-${name}.png`) + ',PilotMeter.Pets.' + id;
    }),
    join(workspace, 'scripts', 'windows', 'DesktopApp.cs'),
    join(workspace, 'scripts', 'windows', 'DesktopWidget.cs'),
    join(workspace, 'scripts', 'windows', 'DesktopBrand.cs'),
    join(workspace, 'scripts', 'windows', 'DesktopMainWindow.cs'),
    join(workspace, 'scripts', 'windows', 'DesktopNativeApi.cs'),
    join(workspace, 'scripts', 'windows', 'DesktopDashboardViews.cs'),
    join(workspace, 'scripts', 'windows', 'DesktopPets.cs'),
    join(workspace, 'test', 'windows', 'desktop-api.cs'),
    join(workspace, 'test', 'windows', 'native-view.cs'),
    join(workspace, 'test', 'windows', 'desktop-contracts.cs'),
    join(workspace, 'test', 'windows', 'desktop-pets.cs'),
  ];
  await run(compiler, contractArguments);
  console.log(await run(executable, [physical, alias, fixtureOrigin]));
  const nativeArguments = contractArguments.filter(argument => !/^\/(?:main|out):/u.test(argument));
  const layoutExecutable = join(temporary, 'DesktopLayoutTests.exe');
  await copyFile(join(workspace, 'scripts', 'windows', 'DesktopApp.config'), layoutExecutable + '.config');
  await run(compiler, ['/main:DesktopLayoutTests', '/out:' + layoutExecutable, ...nativeArguments,
    '/win32manifest:' + join(workspace, 'scripts', 'windows', 'app.manifest'),
    join(workspace, 'test', 'windows', 'desktop-layout.cs')]);
  console.log(await run(layoutExecutable, [join(workspace, '.tmp', 'ui-review')], 90_000));
  const recoveryExecutable = join(temporary, 'DesktopRecoveryTests.exe');
  await copyFile(join(workspace, 'scripts', 'windows', 'DesktopApp.config'), recoveryExecutable + '.config');
  await run(compiler, ['/main:DesktopRecoveryTests', '/out:' + recoveryExecutable, ...nativeArguments,
    join(workspace, 'test', 'windows', 'desktop-recovery.cs')]);
  console.log(await run(recoveryExecutable, [join(temporary, 'recovery')], 45_000));
  passed = true;
} finally {
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  if (passed) {
    const canonical = await realpath(temporary);
    assert.ok(canonical.startsWith(temporaryParent + sep) && canonical === resolve(temporary), 'Cleanup must stay inside its owned temporary directory.');
    assert.ok(!(await lstat(temporary)).isSymbolicLink(), 'Cleanup root must not be a link.');
    await rm(temporary, { recursive: true });
  } else console.error('Retained failed desktop contract files: ' + temporary);
}
