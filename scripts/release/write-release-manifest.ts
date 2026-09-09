import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createSourceBinding } from '../../apps/db-ops-api/src/platform/deployment-binding.js';
import { assertSourcePath } from '../../apps/db-ops-api/src/platform/source-snapshot-service.js';

const [destination, version, commit] = process.argv.slice(2);
if (!destination || !version || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('RELEASE_ARGUMENTS_INVALID');
const paths = (process.env.SLIDE_SOURCE_PATHS ?? '').split(',').map(path => path.trim()).filter(Boolean);
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
let source;
{
  const files = git(['ls-tree', '--full-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(path => {
    if (paths.length && !paths.some(prefix => path.startsWith(prefix))) return false;
    try { assertSourcePath(path); return true; } catch { return false; }
  }).map(path => ({ path, content: git(['show', `${commit}:${path}`]) }));
  source = createSourceBinding(version, commit, paths, files);
}
writeFileSync(destination, JSON.stringify({ version, commit, node: process.version, source }, null, 2) + '\n', { flag: 'wx' });
