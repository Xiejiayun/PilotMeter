import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { installStatusline, inspectStatusline, restoreStatusline } from '../../dist/cli/statusline-config.js';

function setup(t, suffix = '') {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pilotmeter-statusline-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = suffix ? join(directory, suffix) : directory;
  const copilotHome = join(root, 'copilot');
  const dataDir = join(root, 'data');
  fs.mkdirSync(copilotHome, { recursive: true });
  const entryPath = join(root, 'entry.mjs');
  fs.writeFileSync(entryPath, `import fs from 'node:fs'; console.log(JSON.stringify({argv:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')}));`);
  const options = { dataDir, copilotHome, entryPath, nodePath: process.execPath, cliVersion: '1.0.88' };
  return { directory, root, options, settingsPath: join(copilotHome, 'settings.json') };
}

test('JSONC install preserves comments and unrelated settings and records an exact backup', t => {
  const { options, settingsPath } = setup(t);
  const original = '{\r\n  // My theme comment\r\n  "theme": "dark",\r\n  "footer": {\r\n    // Keep footer details\r\n    "showCustom": false,\r\n    "separator": " | ",\r\n  },\r\n}\r\n';
  fs.writeFileSync(settingsPath, original);
  const result = installStatusline(options);
  assert.equal(result.status, 'installed');
  const installed = fs.readFileSync(settingsPath, 'utf8');
  assert.ok(installed.includes('// My theme comment'));
  assert.ok(installed.includes('// Keep footer details'));
  assert.equal(parse(installed).theme, 'dark');
  assert.equal(parse(installed).footer.separator, ' | ');
  assert.equal(parse(installed).footer.showCustom, true);
  assert.equal(parse(installed).statusLine.refreshInterval, 5);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
  const manifest = JSON.parse(fs.readFileSync(join(options.dataDir, 'statusline-installation.json'), 'utf8'));
  assert.equal(manifest.originalFileDigest, createHash('sha256').update(original).digest('hex'));
  assert.equal(manifest.original.showCustom.value, false);
  assert.equal(manifest.original.statusLine.present, false);
  const restored = restoreStatusline(options);
  assert.equal(restored.status, 'restored');
  const final = fs.readFileSync(settingsPath, 'utf8');
  assert.deepEqual(parse(final), parse(original));
  assert.ok(final.includes('// My theme comment'));
  assert.ok(final.includes('// Keep footer details'));
});

test('an existing custom statusLine requires --replace and refusal writes nothing', t => {
  const { options, settingsPath } = setup(t);
  const original = '{\n  // Existing integration\n  "statusLine": { "type": "command", "command": "existing-command", "refreshInterval": 10 },\n  "theme": "light"\n}\n';
  fs.writeFileSync(settingsPath, original);
  const refused = installStatusline(options);
  assert.equal(refused.status, 'needs-confirmation');
  assert.match(refused.review, /--replace/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  assert.equal(fs.existsSync(options.dataDir), false);
  assert.equal(installStatusline({ ...options, replace: true }).status, 'installed');
  assert.equal(restoreStatusline(options).status, 'restored');
  assert.deepEqual(parse(fs.readFileSync(settingsPath, 'utf8')), parse(original));
});

test('reinstall is idempotent and retains the first original values and backup', t => {
  const { options, settingsPath } = setup(t);
  const first = installStatusline(options);
  const text = fs.readFileSync(settingsPath, 'utf8');
  const again = installStatusline(options);
  assert.equal(again.status, 'unchanged');
  assert.equal(again.backupPath, first.backupPath);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), text);
  assert.equal(restoreStatusline(options).status, 'restored');
  assert.deepEqual(parse(fs.readFileSync(settingsPath, 'utf8')), {});
  assert.equal(restoreStatusline(options).status, 'not-installed');
});

test('restore preserves later statusLine and footer edits while restoring unchanged fields', t => {
  const { options, settingsPath } = setup(t);
  fs.writeFileSync(settingsPath, '{"theme":"dark","footer":{"showCustom":false}}');
  installStatusline(options);
  const settings = parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.statusLine = { type: 'command', command: 'my-new-statusline' };
  settings.footer.newField = 'added-later';
  settings.theme = 'light';
  fs.writeFileSync(settingsPath, `// A later comment\n${JSON.stringify(settings, null, 2)}`);
  const result = restoreStatusline(options);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.conflicts, ['statusLine']);
  const restored = parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(restored.statusLine.command, 'my-new-statusline');
  assert.equal(restored.footer.showCustom, false);
  assert.equal(restored.footer.newField, 'added-later');
  assert.equal(restored.theme, 'light');
  assert.ok(fs.readFileSync(settingsPath, 'utf8').includes('// A later comment'));
});

test('restore leaves an added footer field intact instead of removing the parent object', t => {
  const { options, settingsPath } = setup(t);
  installStatusline(options);
  const settings = parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.footer.newField = 'preserve';
  settings.newUserSetting = true;
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  assert.equal(restoreStatusline(options).status, 'restored');
  assert.deepEqual(parse(fs.readFileSync(settingsPath, 'utf8')), { footer: { newField: 'preserve' }, newUserSetting: true });
});

test('generated bridge preserves hostile paths, argv and stdin with clean stdout', t => {
  const { options, settingsPath } = setup(t, "space 中文 & (%) %PATH% ! ' (x)");
  installStatusline(options);
  const settings = parse(fs.readFileSync(settingsPath, 'utf8'));
  const input = JSON.stringify({ session: 'synthetic session', message: '" & echo SHOULD_NOT_RUN | %PATH% ! 中文' });
  const result = spawnSync(settings.statusLine.command, { shell: true, input, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.argv, ['--data-dir', options.dataDir, 'statusline']);
  assert.equal(output.stdin, input);
});

test('COPILOT_HOME is honored and project overrides are reported without changing project files', t => {
  const { options, directory } = setup(t);
  const savedHome = process.env.COPILOT_HOME;
  const savedCwd = process.cwd();
  const project = join(directory, 'project');
  const projectSettings = join(project, '.github', 'copilot', 'settings.json');
  fs.mkdirSync(join(project, '.github', 'copilot'), { recursive: true });
  const content = '{"statusLine":{"type":"command","command":"project-command"}}';
  fs.writeFileSync(projectSettings, content);
  process.env.COPILOT_HOME = options.copilotHome;
  process.chdir(project);
  try {
    const result = installStatusline({ ...options, copilotHome: undefined });
    assert.equal(result.settingsPath, join(options.copilotHome, 'settings.json'));
    assert.ok(result.warnings.some(item => item.includes(projectSettings)));
    assert.equal(fs.readFileSync(projectSettings, 'utf8'), content);
    assert.deepEqual(inspectStatusline().projectOverrides, [projectSettings]);
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = savedHome;
  }
});

test('symbolic-link settings keep the link and update and restore its target', t => {
  const { options, settingsPath, directory } = setup(t);
  const target = join(directory, 'real-settings.json');
  fs.writeFileSync(target, '// Linked settings\n{"theme":"dark"}');
  try { fs.symlinkSync(target, settingsPath, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Creating file symlinks requires OS permission'); return; } throw error; }
  assert.equal(inspectStatusline(options).symlink, true);
  installStatusline(options);
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
  assert.equal(parse(fs.readFileSync(target, 'utf8')).footer.showCustom, true);
  restoreStatusline(options);
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
  assert.deepEqual(parse(fs.readFileSync(target, 'utf8')), { theme: 'dark' });
});

test('retargeting the settings symlink prevents restore from changing the new target', t => {
  const { options, settingsPath, directory } = setup(t);
  const first = join(directory, 'first-settings.json');
  const second = join(directory, 'second-settings.json');
  fs.writeFileSync(first, '{}'); fs.writeFileSync(second, '{"theme":"new-target"}');
  try { fs.symlinkSync(first, settingsPath, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Creating file symlinks requires OS permission'); return; } throw error; }
  installStatusline(options);
  fs.unlinkSync(settingsPath); fs.symlinkSync(second, settingsPath, 'file');
  const result = restoreStatusline(options);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.conflicts, ['settings.json target changed']);
  assert.equal(fs.readFileSync(second, 'utf8'), '{"theme":"new-target"}');
});

test('unsupported versions, temporary npx paths and ambiguous JSONC leave settings untouched', t => {
  const { options, settingsPath, directory } = setup(t);
  fs.writeFileSync(settingsPath, '{}');
  assert.throws(() => installStatusline({ ...options, cliVersion: '1.0.89' }), /1\.0\.88/);
  const cachedEntry = join(directory, '_npx', 'package', 'entry.mjs');
  fs.mkdirSync(join(directory, '_npx', 'package'), { recursive: true });
  fs.copyFileSync(options.entryPath, cachedEntry);
  assert.throws(() => installStatusline({ ...options, entryPath: cachedEntry }), /_npx/);
  for (const invalid of ['{broken', '{"footer":false}', '{"theme":"a","theme":"b"}']) {
    fs.writeFileSync(settingsPath, invalid);
    assert.throws(() => installStatusline(options));
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), invalid);
  }
  assert.equal(fs.existsSync(options.dataDir), false);
});

test('compare-and-swap rejects an intervening settings edit before atomic replacement', t => {
  const { options, settingsPath } = setup(t);
  fs.writeFileSync(settingsPath, '{"theme":"original"}');
  const originalWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function (path, ...args) {
    const result = originalWrite.call(fs, path, ...args);
    if (!injected && typeof path === 'string' && path.startsWith(`${settingsPath}.`) && path.endsWith('.tmp')) {
      injected = true;
      originalWrite.call(fs, settingsPath, '{"theme":"concurrently-edited","userAdded":true}');
    }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => installStatusline(options), /changed during installation/); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{"theme":"concurrently-edited","userAdded":true}');
  assert.equal(fs.existsSync(join(options.dataDir, 'statusline-install.lock')), false);
});

test('a pre-existing configuration lock refuses concurrent mutation', t => {
  const { options, settingsPath } = setup(t);
  fs.writeFileSync(settingsPath, '{}');
  fs.mkdirSync(options.dataDir);
  fs.writeFileSync(join(options.dataDir, 'statusline-install.lock'), 'another operation');
  assert.throws(() => installStatusline(options), /in progress/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{}');
});
