import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertSourceContent, assertSourcePath, describeSourceFiles, type SourceFile } from './source-snapshot-service.js';

export function resolveDeploymentBinding(env: NodeJS.ProcessEnv, release: unknown = {}) {
  const explicit = ['SLIDE_RELEASE_ID', 'SLIDE_COMMIT_SHA', 'SLIDE_SOURCE_DIGEST'].some(key => env[key] !== undefined);
  const source = explicit ? { releaseId: env.SLIDE_RELEASE_ID, commitSha: env.SLIDE_COMMIT_SHA, treeDigest: env.SLIDE_SOURCE_DIGEST } : (release as any)?.source;
  if (!source || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(source.releaseId ?? '')
    || !/^[a-f0-9]{40}$/.test(source.commitSha ?? '') || !/^[a-f0-9]{64}$/.test(source.treeDigest ?? '')) throw new Error('SOURCE_DEPLOYMENT_UNKNOWN');
  return { releaseId: source.releaseId as string, commitSha: source.commitSha as string, treeDigest: source.treeDigest as string };
}

export function readDeploymentBinding() {
  let release: unknown = {};
  if (process.env.SLIDE_RELEASE_MANIFEST) {
    try { release = JSON.parse(readFileSync(process.env.SLIDE_RELEASE_MANIFEST, 'utf8')); }
    catch { throw new Error('SOURCE_DEPLOYMENT_UNKNOWN'); }
  }
  return resolveDeploymentBinding(process.env, release);
}

export function createSourceBinding(releaseId: string, commitSha: string, allowedPaths: string[], files: SourceFile[]) {
  if (allowedPaths.length > 32 || allowedPaths.some(path => !/^[A-Za-z0-9_/-]+\/$/.test(path)
    || path.split('/').slice(0, -1).some(part => !part || part === '..'))) throw new Error('SOURCE_PATH_INVALID');
  if (!files.length || files.length > 4000 || new Set(files.map(file => file.path)).size !== files.length) throw new Error('SOURCE_FILE_COUNT_INVALID');
  for (const file of files) {
    assertSourcePath(file.path); assertSourceContent(file.content, file.path);
    if (allowedPaths.length && !allowedPaths.some(path => file.path.startsWith(path))) throw new Error('SOURCE_PATH_INVALID');
  }
  const descriptors = describeSourceFiles(files);
  if (descriptors.reduce((sum, file) => sum + file.bytes, 0) > 32 * 1024 * 1024) throw new Error('SOURCE_SNAPSHOT_TOO_LARGE');
  const treeDigest = createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
  const identity = resolveDeploymentBinding({}, { source: { releaseId, commitSha, treeDigest } });
  return { schemaVersion: 1, ...identity, allowedPaths, fileCount: files.length };
}
