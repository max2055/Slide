import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { SourceManagementService } from './source-management-service.js';
import { describeSourceFiles } from './source-snapshot-service.js';
import { registerSourceRoutes } from './source-routes.js';
import { auditLogManager } from '../audit/audit-log.js';

// Only substitute the remote endpoint. clone/fetch/checkout and snapshot IO are real.
const remote = vi.hoisted(() => ({ path: '' }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const run = promisify(actual.execFile);
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: (command: string, args: string[], options: any) =>
    run(command, args.map(arg => arg === 'https://gitlab.example.test/group/subgroup/repo.git' ? `file://${remote.path}` : arg),
      { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } }) }) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('syncs a non-tip commit through HTTP routes, publishes manifest, reads it and repeats sync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slide-source-integration-'));
  remote.path = join(root, 'repo'); mkdirSync(remote.path);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: remote.path, encoding: 'utf8', stdio: 'pipe' }).trim();
  const app = Fastify();
  try {
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    mkdirSync(join(remote.path, 'src'));
    const content = 'export const selected = 1;\n';
    writeFileSync(join(remote.path, 'src/a.ts'), content);
    writeFileSync(join(remote.path, 'excluded.ts'), 'export const excluded = 1;');
    git('add', '.'); git('commit', '-m', 'selected commit'); const commitSha = git('rev-parse', 'HEAD');
    writeFileSync(join(remote.path, 'src/a.ts'), 'export const selected = 2;\n');
    git('add', '.'); git('commit', '-m', 'later commit');
    const treeDigest = createHash('sha256').update(JSON.stringify(describeSourceFiles([{ path: 'src/a.ts', content }]))).digest('hex');
    vi.stubEnv('SLIDE_SOURCE_ROOT', join(root, 'snapshots')); vi.stubEnv('SLIDE_SOURCE_SIGNING_KEY', 'fixture-signing-key-'.repeat(3));
    vi.stubEnv('SLIDE_SOURCE_ALLOW_DRIFT', 'false'); vi.stubEnv('SLIDE_SOURCE_ALLOW_UNSAFE', 'false');
    const stored = new Map<string, string>();
    const execute = vi.fn(async (sql: string, values?: string[]) => {
      if (sql.startsWith('REPLACE')) { stored.set(values![0], values![1]); return [[], []]; }
      return [stored.has(values![0]) ? [{ config_value: stored.get(values![0]) }] : [], []];
    });
    const service = new SourceManagementService(() => ({ execute }), ['https://gitlab.example.test']);
    vi.spyOn(service as any, 'deployment').mockReturnValue({ releaseId: 'fixture-release', commitSha, treeDigest });
    vi.spyOn(auditLogManager, 'logToolCall').mockResolvedValue(undefined as any);
    vi.spyOn(auditLogManager, 'logConfigChange').mockResolvedValue(undefined as any);
    await registerSourceRoutes(app, async request => { (request as any).user = { userId: 1, username: 'admin', permissions: ['admin:*'] }; }, service);
    const config = await app.inject({ method: 'PUT', url: '/api/platform/source/config', payload: { provider: 'gitlab', baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/subgroup/repo', ref: commitSha, allowedPaths: ['src/'], allowModelContent: false } });
    expect(config.statusCode).toBe(200);
    for (let i = 0; i < 2; i++) {
      const sync = await app.inject({ method: 'POST', url: '/api/platform/source/sync', payload: { token: 'one-use-fixture' } });
      expect(sync.statusCode, sync.body).toBe(200);
      expect(sync.json()).toMatchObject({ commitSha, treeDigest, projectId: 'group/subgroup/repo' });
      const manifest = await app.inject('/api/platform/source/manifest');
      expect(manifest.statusCode, manifest.body).toBe(200);
      expect(manifest.json().files.map((file: any) => file.path)).toEqual(['src/a.ts']);
    }
    expect(JSON.stringify(execute.mock.calls)).not.toContain('one-use-fixture');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
