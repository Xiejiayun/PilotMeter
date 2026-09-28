import { createHash, type Hash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { ImportResult, SpanRecord } from '../shared/types.js';
import { Repository, type ImportCursor } from '../storage/repository.js';
import { parseOtlp } from './otlp.js';

const READ_SIZE = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const COMMIT_LINES = 256;

function hashPrefix(fd: number, length: number): Hash | null {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(READ_SIZE);
  let position = 0;
  while (position < length) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, length - position), position);
    if (!count) return null;
    hash.update(chunk.subarray(0, count));
    position += count;
  }
  return hash;
}

/** Import complete UTF-8 OTLP JSON lines. A trailing partial line remains unread in the cursor. */
export function importJsonl(repository: Repository, filePath: string, sourceContext: string): ImportResult {
  const path = realpathSync(filePath);
  const fileKey = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new Error('Import requires a regular file with a supported size');
    const fileIdentity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const previous = repository.getImportCursor(fileKey);
    let offset = previous?.offset ?? 0;
    let generation = previous?.generation ?? 0;
    let hash: Hash | null = null;
    if (previous && previous.fileIdentity === fileIdentity && info.size >= offset) {
      hash = hashPrefix(fd, offset);
      if (hash?.copy().digest('hex') !== previous.prefixHash) hash = null;
    }
    if (!hash) {
      if (previous) generation++;
      offset = 0;
      hash = createHash('sha256');
    }
    let position = offset;
    let buffered = Buffer.alloc(0);
    let spans: SpanRecord[] = [];
    let rejectedLines = 0;
    let completeLines = 0;
    const total: ImportResult = { accepted: 0, duplicates: 0, conflicts: 0, rejected: 0, offset, pendingBytes: 0 };
    const commit = (): void => {
      const cursor: ImportCursor = { fileKey, fileIdentity, generation, offset, prefixHash: hash!.copy().digest('hex') };
      const result = repository.ingestImport(spans, cursor, rejectedLines);
      total.accepted += result.accepted; total.duplicates += result.duplicates;
      total.conflicts += result.conflicts; total.rejected += result.rejected;
      total.offset = offset;
      spans = []; rejectedLines = 0; completeLines = 0;
    };
    const buffer = Buffer.allocUnsafe(READ_SIZE);
    while (position < info.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (!count) break;
      position += count;
      buffered = Buffer.concat([buffered, buffer.subarray(0, count)]);
      let consumed = 0;
      while (true) {
        const newline = buffered.indexOf(10, consumed);
        if (newline < 0) break;
        const bytes = buffered.subarray(consumed, newline + 1);
        if (bytes.length > MAX_LINE_BYTES) throw new Error('JSONL line exceeds the 16 MiB import limit');
        hash.update(bytes);
        offset += bytes.length;
        consumed = newline + 1;
        try {
          const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
          if (line) spans.push(...parseOtlp(JSON.parse(line), sourceContext));
        } catch {
          rejectedLines++;
        }
        completeLines++;
        if (completeLines >= COMMIT_LINES) commit();
      }
      // Copy to avoid retaining a large consumed backing buffer for a small partial line.
      buffered = Buffer.from(buffered.subarray(consumed));
      if (buffered.length > MAX_LINE_BYTES) throw new Error('JSONL line exceeds the 16 MiB import limit');
    }
    if (completeLines || !previous || generation !== previous.generation) commit();
    total.pendingBytes = Math.max(0, fstatSync(fd).size - (total.offset ?? 0));
    return total;
  } finally { closeSync(fd); }
}
