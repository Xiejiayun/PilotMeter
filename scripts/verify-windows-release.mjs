import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verify the actual distributable files before upload, without starting an app.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, lock.packages[''].version);
const output = join(root, 'build', 'windows');
const stem = `PilotMeter-${pkg.version}-win-x64`;
const expected = [stem + '.exe', stem + '.exe.json', stem + '.zip'];
const sums = (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/);
assert.equal(sums.length, expected.length, 'Checksum list must contain exactly the current release assets.');
const seen = new Set();
const hashes = new Map();
for (const line of sums) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
  assert.ok(match, 'Invalid checksum entry.');
  const [, digest, name] = match;
  assert.ok(expected.includes(name) && !seen.has(name), 'Unexpected or duplicate release asset.');
  seen.add(name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(output, name))) hash.update(chunk);
  assert.equal(hash.digest('hex'), digest, 'Checksum mismatch: ' + name);
  hashes.set(name, digest);
}
const manifest = JSON.parse(await readFile(join(output, stem + '.exe.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.filename, stem + '.exe');
assert.equal(manifest.platform, 'win32');
assert.equal(manifest.arch, 'x64');
assert.equal(manifest.sha256, hashes.get(stem + '.exe'));
assert.equal(manifest.bytes, (await stat(join(output, stem + '.exe'))).size);
assert.equal(manifest.desktop.mainWindow, 'native-winforms');
assert.equal(manifest.desktop.webView, false);
assert.equal(manifest.desktop.pets, 10);
assert.equal(manifest.desktop.defaultEntry, 'pet');
const executable = await open(join(output, stem + '.exe'), 'r');
try {
  const header = Buffer.alloc(4096);
  await executable.read(header, 0, header.length, 0);
  assert.equal(header.subarray(0, 2).toString('ascii'), 'MZ');
  const pe = header.readUInt32LE(0x3c);
  assert.ok(pe > 0 && pe + 94 < header.length, 'Invalid executable header.');
  assert.equal(header.readUInt32LE(pe), 0x00004550);
  assert.equal(header.readUInt16LE(pe + 4), 0x8664, 'The executable must target Windows x64.');
  assert.equal(header.readUInt16LE(pe + 24 + 68), 2, 'Double-click must not allocate a console.');
} finally { await executable.close(); }
console.log(`Verified ${pkg.version}: native x64 EXE, portable ZIP, manifest and all SHA-256 checksums.`);
