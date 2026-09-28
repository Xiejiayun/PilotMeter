import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importJsonl } from '../../dist/collectors/jsonl.js';
import { parseOtlp } from '../../dist/collectors/otlp.js';
import { Repository } from '../../dist/storage/repository.js';
import { envelope, span } from '../fixtures/synthetic-otlp.mjs';

const line = (number, overrides = {}) => `${JSON.stringify(envelope([span(number, overrides)]))}\n`;
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-import-'));
  const db = join(directory, 'usage.sqlite');
  const repository = new Repository(db);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  return { repository, directory, db, path: join(directory, 'synthetic.jsonl') };
}

test('live ingestion then import and replay produce no duplicate usage', t => {
  const { repository, path, directory } = setup(t);
  repository.ingest(parseOtlp(envelope([span(1)]), 'live-source'));
  writeFileSync(path, line(1) + line(2));
  assert.deepEqual(importJsonl(repository, path, 'file-source'), { accepted: 1, duplicates: 1, conflicts: 0, rejected: 0, offset: Buffer.byteLength(line(1) + line(2)), pendingBytes: 0 });
  assert.equal(importJsonl(repository, path, 'file-source').accepted, 0);
  const moved = join(directory, 'moved-synthetic.jsonl');
  renameSync(path, moved);
  assert.equal(importJsonl(repository, moved, 'third-source').duplicates, 2);
  assert.equal(repository.summary('2026-09').knownCalls, 2);
});

test('an incomplete UTF-8 line waits until its newline and survives database restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pilotmeter-partial-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic.jsonl');
  const db = join(directory, 'usage.sqlite');
  const bytes = Buffer.from(line(2, { session: '中文会话' }));
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  writeFileSync(path, Buffer.concat([Buffer.from(line(1)), bytes.subarray(0, split)]));
  let repository = new Repository(db);
  let result = importJsonl(repository, path, 'source');
  assert.equal(result.accepted, 1);
  assert.equal(result.pendingBytes, split);
  assert.equal(result.offset, Buffer.byteLength(line(1)));
  repository.close();
  appendFileSync(path, bytes.subarray(split));
  repository = new Repository(db);
  result = importJsonl(repository, path, 'source');
  assert.equal(result.accepted, 1);
  assert.equal(result.pendingBytes, 0);
  assert.equal(repository.summary('2026-09').knownCalls, 2);
  assert.ok(repository.sessions('2026-09').items.some(item => item.sessionId === '中文会话'));
  repository.close();
});

test('truncation, same-size rewrite and rotation reset generation without losing or recounting events', t => {
  const { repository, path, directory } = setup(t);
  writeFileSync(path, line(1) + line(2));
  importJsonl(repository, path, 'source');
  writeFileSync(path, line(3));
  assert.equal(importJsonl(repository, path, 'source').accepted, 1);
  writeFileSync(path, line(4));
  assert.equal(importJsonl(repository, path, 'source').accepted, 1);
  renameSync(path, join(directory, 'rotated.jsonl'));
  writeFileSync(path, line(1) + line(5));
  const result = importJsonl(repository, path, 'source');
  assert.equal(result.accepted, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(repository.summary('2026-09').knownCalls, 5);
});

test('malformed complete JSON and invalid UTF-8 are diagnosed without leaking data', t => {
  const { repository, path, db } = setup(t);
  writeFileSync(path, Buffer.concat([Buffer.from('SYNTHETIC_PRIVATE_INVALID_JSON\n'), Buffer.from([0xff, 10]), Buffer.from(line(1))]));
  const result = importJsonl(repository, path, 'source');
  assert.equal(result.rejected, 2);
  assert.equal(result.accepted, 1);
  assert.equal(result.pendingBytes, 0);
  assert.ok(repository.diagnostics().some(item => item.code === 'invalid-import-line'));
  assert.equal(JSON.stringify(repository.diagnostics()).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(readFileSync(db).toString('utf8').includes('SYNTHETIC_PRIVATE'), false);
});

test('cursor and ledger roll back together on failure and replay safely', t => {
  const { repository, path } = setup(t);
  writeFileSync(path, line(1) + line(2));
  const ingest = repository.ingest.bind(repository);
  repository.ingest = spans => { ingest(spans); throw new Error('synthetic write failure'); };
  assert.throws(() => importJsonl(repository, path, 'source'), /synthetic write failure/);
  assert.equal(repository.summary('2026-09').knownCalls, 0);
  repository.ingest = ingest;
  const result = importJsonl(repository, path, 'source');
  assert.equal(result.accepted, 2);
  assert.equal(result.duplicates, 0);
});

test('large files cross read and transaction boundaries without UTF-8 or offset errors', t => {
  const { repository, path } = setup(t);
  const data = Array.from({ length: 260 }, (_, index) => line(index + 1, { session: '跨块会话', cost: '1' })).join('');
  writeFileSync(path, data);
  const result = importJsonl(repository, path, 'source');
  assert.equal(result.accepted, 260);
  assert.equal(result.offset, Buffer.byteLength(data));
  assert.equal(result.pendingBytes, 0);
  assert.equal(repository.summary('2026-09').nanoAiu, '260');
  assert.equal(importJsonl(repository, path, 'source').duplicates, 0);
});
