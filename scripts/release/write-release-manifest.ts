import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createSourceBinding } from '../../apps/db-ops-api/src/platform/deployment-binding.js';
import { assertSourcePath, MAX_FILE_BYTES, MAX_FILES, MAX_SNAPSHOT_BYTES } from '../../apps/db-ops-api/src/platform/source-snapshot-service.js';

const [destination, version, commit] = process.argv.slice(2);
if (!destination || !version || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('RELEASE_ARGUMENTS_INVALID');
const paths = (process.env.SLIDE_SOURCE_PATHS ?? '').split(',').map(path => path.trim()).filter(Boolean);
// assertSourcePath caps each path at 512 ASCII characters. The tree read must hold a complete
// contract listing; a single blob read must hold one contract file. Overflow is a domain error.
const MAX_SOURCE_PATH_LENGTH = 512;
const TREE_LIST_BYTES = MAX_FILES * (MAX_SOURCE_PATH_LENGTH + 1);
const gitOutputOverflow = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOBUFS';
const git = (args: string[], maxBuffer: number, overflow: string) => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer, timeout: 30_000 }); }
  catch (error) {
    if (gitOutputOverflow(error)) throw new Error(overflow);
    throw error;
  }
};
let source;
if (paths.length) {
  const selected = git(['ls-tree', '--full-tree', '-r', '--name-only', '-z', commit], TREE_LIST_BYTES, 'SOURCE_FILE_COUNT_INVALID').split('\0').filter(path => {
    if (!paths.some(prefix => path.startsWith(prefix))) return false;
    try { assertSourcePath(path); return true; } catch { return false; }
  });
  if (!selected.length || selected.length > MAX_FILES) throw new Error('SOURCE_FILE_COUNT_INVALID');
  // One process per blob made the 20,000-file boundary exceed the backend CI budget.
  // Check byte limits before reading, then use one bounded batch for all blob contents.
  const input = selected.map(path => `${commit}:${path}\n`).join('');
  const headers = execFileSync('git', ['cat-file', '--batch-check'], {
    input, encoding: 'utf8', maxBuffer: MAX_FILES * 100, timeout: 30_000,
  }).trimEnd().split('\n');
  let total = 0;
  const sizes = headers.map(header => {
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
    if (!match) throw new Error('SOURCE_BLOB_INVALID');
    const size = Number(match[2]);
    if (size > MAX_FILE_BYTES) throw new Error('SOURCE_FILE_TOO_LARGE');
    total += size;
    return size;
  });
  if (headers.length !== selected.length) throw new Error('SOURCE_BLOB_INVALID');
  if (total > MAX_SNAPSHOT_BYTES) throw new Error('SOURCE_SNAPSHOT_TOO_LARGE');
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    input, maxBuffer: MAX_SNAPSHOT_BYTES + MAX_FILES * 100, timeout: 30_000,
  });
  let offset = 0;
  const files = selected.map((path, index) => {
    const boundary = batch.indexOf(10, offset);
    if (boundary < offset || batch.toString('ascii', offset, boundary) !== headers[index]) throw new Error('SOURCE_BLOB_INVALID');
    const start = boundary + 1, end = start + sizes[index];
    if (end >= batch.length || batch[end] !== 10) throw new Error('SOURCE_BLOB_INVALID');
    offset = end + 1;
    return { path, content: batch.toString('utf8', start, end) };
  });
  if (offset !== batch.length) throw new Error('SOURCE_BLOB_INVALID');
  source = createSourceBinding(version, commit, paths, files);
}
writeFileSync(destination, JSON.stringify({ version, commit, node: process.version, source }, null, 2) + '\n', { flag: 'wx' });
