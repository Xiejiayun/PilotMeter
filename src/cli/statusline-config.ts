import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse as parsePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Field { present: boolean; value?: Json }
interface Snapshot { settingsPath: string; targetPath: string; text: string; digest: string; exists: boolean; mode: number }
interface Manifest {
  version: 1; status: 'installed' | 'restored'; settingsPath: string; targetPath: string;
  cliVersion: string; bridgePath: string; backupPath: string; createdAt: string;
  originalFileDigest: string; installedFileDigest: string;
  original: { statusLine: Field; showCustom: Field; footerPresent: boolean };
  installed: { statusLine: Json; showCustom: true };
}
export interface StatuslineOptions {
  dataDir: string; copilotHome?: string; cliVersion: string; replace?: boolean; entryPath?: string; nodePath?: string;
}
export interface StatuslineInspection {
  copilotHome: string; settingsPath: string; targetPath: string; exists: boolean; symlink: boolean;
  hasStatusLine: boolean; projectOverrides: string[]; warnings: string[];
}
export interface StatuslineInstallResult {
  status: 'installed' | 'unchanged' | 'needs-confirmation'; settingsPath: string; bridgePath: string;
  backupPath: string | null; changes: string[]; warnings: string[]; review: string;
}
export interface StatuslineRestoreResult {
  status: 'restored' | 'partial' | 'not-installed'; settingsPath: string;
  restored: string[]; conflicts: string[]; warnings: string[];
}

const MANIFEST = 'statusline-installation.json';
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const same = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);
const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function safePath(path: string): string {
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('Statusline paths must not contain control characters');
  return resolve(path);
}

function homePath(explicit?: string): string {
  return safePath(explicit || process.env.COPILOT_HOME || join(homedir(), '.copilot'));
}

function targetFor(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling settings symlink must never be replaced with an ordinary file.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Copilot settings symlink has no readable target'); }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
    const parent = dirname(path);
    if (parent === path) return path;
    return join(targetFor(parent), parsePath(path).base);
  }
}

function snapshot(settingsPath: string): Snapshot {
  const targetPath = targetFor(settingsPath);
  try {
    const info = statSync(targetPath);
    if (!info.isFile()) throw new Error('Copilot settings must be a regular file');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(targetPath));
    return { settingsPath, targetPath, text, digest: digest(text), exists: true, mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { settingsPath, targetPath, text: '', digest: digest(''), exists: false, mode: 0o600 };
  }
}

function tree(text: string): Node {
  const errors: ParseError[] = [];
  const parsed = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
  if (errors.length || (parsed && parsed.type !== 'object')) throw new Error('Copilot settings must be a valid JSONC object; no changes were written');
  const result = parsed ?? parseTree('{}')!;
  const check = (node: Node): void => {
    if (node.type === 'object') {
      const keys = node.children?.map(property => String(property.children?.[0]?.value)) ?? [];
      if (new Set(keys).size !== keys.length) throw new Error('Copilot settings contain duplicate keys; no changes were written');
    }
    for (const child of node.children ?? []) check(child);
  };
  check(result);
  return result;
}

function field(root: Node, path: string[]): Field {
  const node = findNodeAtLocation(root, path);
  // jsonc-parser uses null-prototype objects; normalize prototypes before value comparisons.
  return node ? { present: true, value: JSON.parse(JSON.stringify(getNodeValue(node))) as Json } : { present: false };
}

function editableText(text: string): string {
  const parsed = parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: true });
  return parsed ? text : `${text}${text && !text.endsWith('\n') ? '\n' : ''}{}\n`;
}

function change(text: string, path: string[], value: Json | undefined): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indentation = text.match(/\n([ \t]+)"/)?.[1];
  return applyEdits(text, modify(text, path, value, { formattingOptions: {
    insertSpaces: !indentation?.includes('\t'), tabSize: indentation && !indentation.includes('\t') ? indentation.length : 2,
    eol, keepLines: true,
  } }));
}

function writeAtomic(path: string, text: string, mode = 0o600): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { encoding: 'utf8', mode, flag: 'wx' }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}

function compareAndWrite(original: Snapshot, text: string): void {
  mkdirSync(dirname(original.targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${original.targetPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: original.mode, flag: 'wx' });
    const current = snapshot(original.settingsPath);
    if (current.targetPath !== original.targetPath || current.exists !== original.exists || current.digest !== original.digest) {
      throw new Error('Copilot settings changed during installation or restore; the concurrent edit was preserved. Retry after reviewing it.');
    }
    renameSync(temporary, original.targetPath);
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}

function readManifest(dataDir: string): Manifest | null {
  try {
    const result = JSON.parse(readFileSync(join(dataDir, MANIFEST), 'utf8')) as Manifest;
    if (result.version !== 1 || !result.original || !result.installed) throw new Error('Unsupported statusline installation record');
    return result;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function locked<T>(dataDir: string, work: () => T): T {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, 'statusline-install.lock');
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another statusline configuration operation is in progress; no settings were changed');
    throw error;
  }
  try { return work(); }
  finally { closeSync(lock); unlinkSync(lockPath); }
}

export function inspectStatusline(options: { copilotHome?: string; dataDir?: string } = {}): StatuslineInspection {
  const copilotHome = homePath(options.copilotHome);
  const settingsPath = join(copilotHome, 'settings.json');
  const current = snapshot(settingsPath);
  const parsed = tree(current.text);
  const warnings: string[] = [];
  const projectOverrides: string[] = [];
  let directory = process.cwd();
  while (true) {
    for (const relative of [['.github', 'copilot', 'settings.json'], ['.copilot', 'settings.json']]) {
      const path = join(directory, ...relative);
      if (path === settingsPath || !existsSync(path)) continue;
      try {
        const project = tree(snapshot(path).text);
        if (field(project, ['statusLine']).present || field(project, ['footer', 'showCustom']).present) projectOverrides.push(path);
      } catch { warnings.push(`Project settings could not be inspected: ${path}`); }
    }
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, '.git'))) break;
    directory = parent;
  }
  for (const path of projectOverrides) warnings.push(`Project settings may override the user statusline: ${path}`);
  return { copilotHome, settingsPath, targetPath: current.targetPath, exists: current.exists,
    symlink: current.exists && lstatSync(settingsPath).isSymbolicLink(), hasStatusLine: field(parsed, ['statusLine']).present,
    projectOverrides, warnings };
}

function bridge(dataDir: string, nodePath: string, entryPath: string): { path: string; content: string; command: string } {
  if (process.platform === 'win32') {
    const path = join(dataDir, 'statusline-bridge.ps1');
    // Windows PowerShell 5 requires a BOM to read non-ASCII paths as UTF-8.
    const content = `\uFEFF$ErrorActionPreference = 'Stop'\r\n& ${powershellQuote(nodePath)} ${powershellQuote(entryPath)} '--data-dir' ${powershellQuote(dataDir)} 'statusline'\r\nexit $LASTEXITCODE\r\n`;
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!existsSync(executable) || /[%!^&|<>"\r\n]/.test(executable)) throw new Error('A supported Windows PowerShell installation is required for the statusline bridge');
    const encoded = Buffer.from(`& ${powershellQuote(path)}; exit $LASTEXITCODE`, 'utf16le').toString('base64');
    return { path, content, command: `"${executable}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}` };
  }
  const path = join(dataDir, 'statusline-bridge.sh');
  return { path, content: `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(entryPath)} --data-dir ${shellQuote(dataDir)} statusline\n`, command: shellQuote(path) };
}

export function installStatusline(options: StatuslineOptions): StatuslineInstallResult {
  if (options.cliVersion !== '1.0.88') throw new Error('Statusline configuration is verified only for Copilot CLI 1.0.88; no settings were changed');
  const dataDir = safePath(options.dataDir);
  const originalEntry = safePath(options.entryPath ?? fileURLToPath(new URL('../../bin/pilotmeter.js', import.meta.url)));
  const originalNode = safePath(options.nodePath ?? process.execPath);
  const entryPath = realpathSync(originalEntry);
  const nodePath = realpathSync(originalNode);
  if (![entryPath, nodePath].every(path => statSync(path).isFile())) throw new Error('Statusline Node and package entry paths must be regular files');
  if ([dataDir, originalEntry, originalNode, entryPath, nodePath].some(path => /(?:^|[\\/])_npx(?:[\\/]|$)/i.test(path))) {
    throw new Error('Install PilotMeter at a stable location before configuring statusline; temporary _npx paths are not supported');
  }
  const inspection = inspectStatusline(options);
  const initial = snapshot(inspection.settingsPath);
  const parsed = tree(initial.text);
  const oldStatusLine = field(parsed, ['statusLine']);
  const oldFooter = findNodeAtLocation(parsed, ['footer']);
  if (oldFooter && oldFooter.type !== 'object') throw new Error('Copilot footer is not an object; review that setting before installing statusline');
  const script = bridge(dataDir, nodePath, entryPath);
  const statusLine: Json = { type: 'command', command: script.command, refreshInterval: 5 };
  const previous = readManifest(dataDir);
  const sameInstallation = previous?.status === 'installed' && previous.settingsPath === initial.settingsPath
    && previous.targetPath === initial.targetPath && same(oldStatusLine.value, previous.installed.statusLine);
  const proposed: StatuslineInstallResult = { status: 'installed', settingsPath: initial.settingsPath, bridgePath: script.path,
    backupPath: null, changes: ['statusLine', 'footer.showCustom'], warnings: inspection.warnings,
    review: `Set statusLine to a command bridge at ${script.path} with a 5-second refresh and set footer.showCustom to true. Preserve all unrelated settings.` };
  if (oldStatusLine.present && !sameInstallation && !options.replace) {
    return { ...proposed, status: 'needs-confirmation', review: `Existing statusLine requires explicit --replace. ${proposed.review}` };
  }
  return locked(dataDir, () => {
    const current = snapshot(initial.settingsPath);
    if (current.digest !== initial.digest || current.targetPath !== initial.targetPath || current.exists !== initial.exists) throw new Error('Copilot settings changed before installation; no settings were changed');
    const backupPath = sameInstallation ? previous!.backupPath : join(dataDir, `statusline-settings-${Date.now()}-${randomUUID()}.jsonc.backup`);
    if (!sameInstallation) writeFileSync(backupPath, initial.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const original = sameInstallation ? previous!.original : {
      statusLine: oldStatusLine, showCustom: field(parsed, ['footer', 'showCustom']), footerPresent: !!oldFooter,
    };
    let updated = editableText(initial.text);
    updated = change(updated, ['statusLine'], statusLine);
    updated = change(updated, ['footer', 'showCustom'], true);
    tree(updated);
    const manifest: Manifest = { version: 1, status: 'installed', settingsPath: initial.settingsPath, targetPath: initial.targetPath,
      cliVersion: options.cliVersion, bridgePath: script.path, backupPath, createdAt: sameInstallation ? previous!.createdAt : new Date().toISOString(),
      originalFileDigest: sameInstallation ? previous!.originalFileDigest : initial.digest, installedFileDigest: digest(updated),
      original, installed: { statusLine, showCustom: true } };
    // Save recovery information before mutating settings; an interrupted install remains reversible.
    writeAtomic(join(dataDir, MANIFEST), JSON.stringify(manifest, null, 2));
    writeAtomic(script.path, script.content, 0o700);
    if (updated !== initial.text) compareAndWrite(initial, updated);
    return { ...proposed, status: updated === initial.text ? 'unchanged' : 'installed', backupPath };
  });
}

export function restoreStatusline(options: { dataDir: string; copilotHome?: string }): StatuslineRestoreResult {
  const dataDir = safePath(options.dataDir);
  const settingsPath = join(homePath(options.copilotHome), 'settings.json');
  const previous = readManifest(dataDir);
  const empty: StatuslineRestoreResult = { status: 'not-installed', settingsPath, restored: [], conflicts: [], warnings: [] };
  if (!previous || previous.status === 'restored') return empty;
  if (previous.settingsPath !== settingsPath) throw new Error('Statusline was installed for a different COPILOT_HOME; select that directory to restore it');
  return locked(dataDir, () => {
    const current = snapshot(settingsPath);
    if (current.targetPath !== previous.targetPath) return { ...empty, status: 'partial', conflicts: ['settings.json target changed'], warnings: ['The settings symlink or its target changed; no settings were modified.'] };
    const parsed = tree(current.text);
    let updated = editableText(current.text);
    const restored: string[] = [];
    const conflicts: string[] = [];
    for (const [path, original, installed] of [
      [['statusLine'], previous.original.statusLine, previous.installed.statusLine],
      [['footer', 'showCustom'], previous.original.showCustom, previous.installed.showCustom],
    ] as [string[], Field, Json][]) {
      const existing = field(parsed, path);
      if (existing.present && same(existing.value, installed)) {
        updated = change(updated, path, original.present ? original.value : undefined);
        restored.push(path.join('.'));
      } else if (!(existing.present === original.present && (!existing.present || same(existing.value, original.value)))) conflicts.push(path.join('.'));
    }
    // Remove only an empty footer object created by this installation, preserving later footer additions.
    const footer = findNodeAtLocation(tree(updated), ['footer']);
    const footerText = footer ? updated.slice(footer.offset, footer.offset + footer.length) : '';
    if (!previous.original.footerPresent && footer?.type === 'object' && !footer.children?.length && !/\/\/|\/\*/.test(footerText)) updated = change(updated, ['footer'], undefined);
    tree(updated);
    if (updated !== current.text) compareAndWrite(current, updated);
    if (!conflicts.length) writeAtomic(join(dataDir, MANIFEST), JSON.stringify({ ...previous, status: 'restored' }, null, 2));
    return { status: conflicts.length ? 'partial' : 'restored', settingsPath, restored, conflicts,
      warnings: conflicts.length ? ['Later edits were preserved; only fields still matching PilotMeter were restored.'] : [] };
  });
}
