import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createSourceBinding } from '../../apps/db-ops-api/src/platform/deployment-binding.js';
import { assertSourcePath, MAX_FILE_BYTES, MAX_FILES } from '../../apps/db-ops-api/src/platform/source-snapshot-service.js';

const [destination, version, commit] = process.argv.slice(2);
if (!destination || !version || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('RELEASE_ARGUMENTS_INVALID');
const paths = (process.env.SLIDE_SOURCE_PATHS ?? '').split(',').map(path => path.trim()).filter(Boolean);
// assertSourcePath caps each path at 512 ASCII characters. The tree read must hold a complete
// contract listing; a single blob read must hold one contract file. Overflow is a domain error.
const MAX_SOURCE_PATH_LENGTH = 512;
const TREE_LIST_BYTES = MAX_FILES * (MAX_SOURCE_PATH_LENGTH + 1);
const gitOutputOverflow = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOBUFS';
const git = (args: string[], maxBuffer: number, overflow: string) => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer }); }
  catch (error) {
    if (gitOutputOverflow(error)) throw new Error(overflow);
    throw error;
  }
};
let source;
if (paths.length) {
  const files = git(['ls-tree', '--full-tree', '-r', '--name-only', '-z', commit], TREE_LIST_BYTES, 'SOURCE_FILE_COUNT_INVALID').split('\0').filter(path => {
    if (!paths.some(prefix => path.startsWith(prefix))) return false;
    try { assertSourcePath(path); return true; } catch { return false; }
  }).map(path => ({ path, content: git(['show', `${commit}:${path}`], MAX_FILE_BYTES, 'SOURCE_FILE_TOO_LARGE') }));
  source = createSourceBinding(version, commit, paths, files);
}
writeFileSync(destination, JSON.stringify({ version, commit, node: process.version, source }, null, 2) + '\n', { flag: 'wx' });
