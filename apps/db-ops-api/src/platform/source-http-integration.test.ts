import Fastify from 'fastify';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceManagementService } from './source-management-service.js';
import { registerSourceRoutes } from './source-routes.js';
import { auditLogManager } from '../audit/audit-log.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('syncs approved HTTP Git refs without deployment binding, reads partial snapshots and preserves identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slide-http-source-'));
  const repo = join(root, 'group/repo.git'); mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const selected = 1;\n');
  git('add', '.'); git('commit', '-m', 'base'); const baseCommit = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'release');
  writeFileSync(join(repo, 'src/a.ts'), 'export const selected = 2;\n');
  writeFileSync(join(repo, 'src/private.json'), '{"password":"fixture-sensitive-value"}');
  writeFileSync(join(repo, 'src/large.ts'), 'x'.repeat(512 * 1024 + 1));
  git('add', '.'); git('commit', '-m', 'release'); const commit = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  const token = 'one-use-test-credential';
  const authorization = 'Basic ' + Buffer.from('oauth2:' + token).toString('base64');
  let redirect = false; let requests = 0;
  const upstream = createServer((req, res) => {
    requests++;
    if (redirect) { res.writeHead(302, { Location: 'http://127.0.0.1:1/leak' }); res.end(); return; }
    if (req.headers.authorization !== authorization) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url!, 'http://fixture');
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'fixture' } });
    req.pipe(child.stdin); child.stdin.on('error', () => {});
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume();
    child.on('close', code => {
      if (code !== 0) { res.writeHead(500); res.end(); return; }
      const output = Buffer.concat(chunks); const boundary = output.indexOf('\r\n\r\n');
      if (boundary < 0) { res.writeHead(500); res.end(); return; }
      for (const line of output.subarray(0, boundary).toString().split('\r\n')) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        const name = line.slice(0, colon); const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
        else res.setHeader(name, value);
      }
      res.end(output.subarray(boundary + 4));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const snapshotsRoot = join(root, 'snapshots');
  vi.stubEnv('SLIDE_SOURCE_ROOT', snapshotsRoot); vi.stubEnv('SLIDE_SOURCE_SIGNING_KEY', 'fixture-signing-key-'.repeat(3));
  for (const key of ['SLIDE_RELEASE_MANIFEST', 'SLIDE_RELEASE_ID', 'SLIDE_COMMIT_SHA', 'SLIDE_SOURCE_DIGEST']) vi.stubEnv(key, '');
  vi.stubEnv('SLIDE_SOURCE_ALLOW_UNSAFE', 'false'); vi.stubEnv('SLIDE_SOURCE_ALLOW_DRIFT', 'false');
  const values = new Map<string, string>();
  const execute = vi.fn(async (sql: string, params: string[] = []) => {
    if (sql.startsWith('REPLACE')) { values.set(params[0], params[1]); return [[], []]; }
    return [values.has(params[0]) ? [{ config_value: values.get(params[0]) }] : [], []];
  });
  vi.spyOn(auditLogManager, 'logToolCall').mockResolvedValue(undefined as any);
  vi.spyOn(auditLogManager, 'logConfigChange').mockResolvedValue(undefined as any);
  const alternateOrigin = origin.replace('127.0.0.1', 'localhost');
  const service = new SourceManagementService(() => ({ execute }), [origin, alternateOrigin]);
  const app = Fastify();
  await registerSourceRoutes(app, async request => { (request as any).user = { userId: 1, username: 'admin', permissions: ['admin:*'] }; }, service);
  const api = await app.listen({ port: 0, host: '127.0.0.1' });
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(api + '/api/platform/source/' + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const config = { provider: 'gitlab', baseUrl: origin, repositoryPath: 'group/repo', ref: 'release', allowedPaths: ['src/'], allowModelContent: true };
  try {
    expect(await call('config', config, 'PUT')).toMatchObject({ status: 200 });
    const sync = await call('sync', { token });
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    expect(sync.body).toMatchObject({ commitSha: commit, completeness: 'partial', verification: { status: 'repository-unbound', reason: 'SOURCE_DEPLOYMENT_UNKNOWN' } });
    expect(sync.body.files.map((file: any) => file.path)).toEqual(['src/a.ts']);
    expect(sync.body.skippedFiles).toEqual(expect.arrayContaining([
      { path: 'src/private.json', reason: 'SOURCE_SENSITIVE_CONTENT' }, { path: 'src/large.ts', reason: 'SOURCE_FILE_TOO_LARGE' },
    ]));
    expect(JSON.stringify(sync.body)).not.toContain('fixture-sensitive-value');
    expect(await call('manifest')).toMatchObject({ status: 200, body: { releaseId: sync.body.releaseId, commitSha: commit } });
    expect(await call('region?path=src/a.ts&startLine=1&endLine=1')).toMatchObject({ status: 200, body: { content: 'export const selected = 2;', source: { commitSha: commit, completeness: 'partial', verification: { status: 'repository-unbound' } } } });
    expect(await call('region?path=src/private.json&startLine=1&endLine=1')).toMatchObject({ status: 403 });
    expect(await call('search?query=selected')).toMatchObject({ status: 200, body: { matches: [{ path: 'src/a.ts' }], source: { commitSha: commit } } });
    expect(await call('symbol?name=selected')).toMatchObject({ status: 200, body: { matches: [{ name: 'selected' }], source: { commitSha: commit } } });
    expect(await call('sync', { token })).toMatchObject({ status: 200, body: { releaseId: sync.body.releaseId } });
    expect(JSON.stringify([...values])).not.toContain(token);

    // A stale/mismatched deployment can neither block reads nor claim verification.
    vi.stubEnv('SLIDE_RELEASE_ID', 'deployed'); vi.stubEnv('SLIDE_COMMIT_SHA', baseCommit); vi.stubEnv('SLIDE_SOURCE_DIGEST', 'a'.repeat(64));
    expect(await call('manifest')).toMatchObject({ status: 200, body: { verification: { status: 'repository-unbound', reason: 'SOURCE_COMMIT_MISMATCH' } } });
    expect(await call('sync', { token })).toMatchObject({ status: 200, body: { releaseId: sync.body.releaseId } });

    // A real new branch head must create a distinct immutable snapshot.
    git('checkout', 'release'); writeFileSync(join(repo, 'src/a.ts'), 'export const selected = 3;\n'); git('add', '.'); git('commit', '-m', 'next');
    const nextCommit = git('rev-parse', 'HEAD');
    const next = await call('sync', { token });
    expect(next).toMatchObject({ status: 200, body: { commitSha: nextCommit } });
    expect(next.body.releaseId).not.toBe(sync.body.releaseId);
    expect(readFileSync(join(snapshotsRoot, sync.body.releaseId, 'src/a.ts'), 'utf8')).toContain('selected = 2');

    // Matching identity still does not call an incomplete snapshot deployment-verified.
    vi.stubEnv('SLIDE_COMMIT_SHA', nextCommit); vi.stubEnv('SLIDE_SOURCE_DIGEST', next.body.treeDigest);
    expect(await call('manifest')).toMatchObject({ status: 200, body: { verification: { status: 'repository-unbound', reason: 'SOURCE_SNAPSHOT_PARTIAL' } } });
    const target = join(snapshotsRoot, next.body.releaseId, 'src/a.ts'); chmodSync(target, 0o600); writeFileSync(target, 'tampered');
    expect(await call('region?path=src/a.ts&startLine=1&endLine=1')).toMatchObject({ status: 409, body: { error: 'SOURCE_SNAPSHOT_UNTRUSTED' } });

    await call('config', { ...config, ref: 'main' }, 'PUT');
    expect(await call('manifest')).toMatchObject({ status: 409 });
    const clean = await call('sync', { token }); expect(clean).toMatchObject({ status: 200, body: { commitSha: baseCommit, completeness: 'complete' } });
    vi.stubEnv('SLIDE_COMMIT_SHA', baseCommit); vi.stubEnv('SLIDE_SOURCE_DIGEST', clean.body.treeDigest);
    expect(await call('manifest')).toMatchObject({ status: 200, body: { verification: { status: 'deployment-verified' } } });
    vi.stubEnv('SLIDE_SOURCE_DIGEST', 'c'.repeat(64));
    expect(await call('manifest')).toMatchObject({ status: 200, body: { verification: { status: 'repository-unbound', reason: 'SOURCE_TREE_MISMATCH' } } });
    await call('config', { ...config, ref: 'main', baseUrl: alternateOrigin }, 'PUT');
    expect(await call('manifest')).toMatchObject({ status: 409, body: { error: 'SOURCE_NOT_SYNCED' } });
    await call('config', { ...config, ref: 'main', allowedPaths: ['src/public/'] }, 'PUT');
    expect(await call('manifest')).toMatchObject({ status: 409, body: { error: 'SOURCE_NOT_SYNCED' } });
    await call('config', { ...config, ref: 'main' }, 'PUT');
    expect(await call('sync', { token: 'bad-token' })).toMatchObject({ status: 400, body: { error: 'SOURCE_CREDENTIAL_INVALID' } });
    redirect = true;
    expect(await call('sync', { token })).toMatchObject({ body: { error: 'SOURCE_UPSTREAM_UNAVAILABLE' } });
    expect(requests).toBeGreaterThan(0);
  } finally {
    await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
