import Fastify from 'fastify';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { auditLogManager, DatabaseAuditLogStore, memoryAuditLogStore } from '../audit/audit-log.js';
import { SourceManagementService } from './source-management-service.js';
import { registerSourceRoutes } from './source-routes.js';
import { SourceSnapshotService } from './source-snapshot-service.js';

const port = Number(process.env.SOURCE_TEST_MYSQL_PORT);
afterEach(() => { vi.unstubAllEnvs(); });

// Opt-in isolated SQL + real HTTP Git + real API listener. No provider calls.
// The trusted fixture actor tests source IO, not JWT/RBAC acceptance.
describe.skipIf(!port)('source sync real HTTP/MySQL acceptance', () => {
  it('reserves root manifest, binds the exact commit and survives service recreation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slide-source-sql-'));
    const repo = join(root, 'group/repo.git'); mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src/a.ts'), 'export const selected = "main";\n');
    writeFileSync(join(repo, 'manifest.json'), '{"name":"repository-manifest"}');
    git('add', '.'); git('commit', '-m', 'main'); const mainCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'release'); writeFileSync(join(repo, 'src/a.ts'), 'export const selected = "release";\n');
    git('add', '.'); git('commit', '-m', 'release'); const commit = git('rev-parse', 'HEAD'); git('checkout', 'main');
    const token = 'one-use-sql-test-credential';
    const authorization = 'Basic ' + Buffer.from('oauth2:' + token).toString('base64');
    const proxyAuthorization = 'Basic ' + Buffer.from('fixture-proxy-user:fixture-proxy-credential').toString('base64');
    let proxyRequests = 0;
    const upstream = createServer((req, res) => {
      if (req.url!.startsWith('http://')) {
        if (req.headers['proxy-authorization'] !== proxyAuthorization) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' }); res.end(); return; }
        proxyRequests++;
      }
      if (req.headers.authorization !== authorization) { res.writeHead(401); res.end(); return; }
      const url = new URL(req.url!, 'http://fixture');
      const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'fixture' } });
      req.pipe(child.stdin); child.stdin.on('error', () => {}); child.stderr.resume();
      const chunks: Buffer[] = []; child.stdout.on('data', chunk => chunks.push(chunk));
      child.on('close', code => {
        const output = Buffer.concat(chunks); const boundary = output.indexOf('\r\n\r\n');
        if (code !== 0 || boundary < 0) { res.writeHead(500); res.end(); return; }
        for (const line of output.subarray(0, boundary).toString().split('\r\n')) {
          const colon = line.indexOf(':'); if (colon < 0) continue;
          const name = line.slice(0, colon); const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
          else res.setHeader(name, value);
        }
        res.end(output.subarray(boundary + 4));
      });
    });
    const database = `source_test_${randomUUID().replaceAll('-', '')}`;
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.SOURCE_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    const admin = mysql.createPool(options); const pool = mysql.createPool({ ...options, database });
    let app = Fastify();
    try {
      await admin.query(`CREATE DATABASE ${database}`); await new MigrationRunner(pool).run();
      auditLogManager.setPersistentStore(new DatabaseAuditLogStore(pool));
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      const snapshotRoot = join(root, 'snapshots'); const signingKey = 'fixture-source-signing-key-'.repeat(2);
      vi.stubEnv('SLIDE_SOURCE_ROOT', snapshotRoot); vi.stubEnv('SLIDE_SOURCE_SIGNING_KEY', signingKey);
      for (const key of ['SLIDE_RELEASE_MANIFEST', 'SLIDE_RELEASE_ID', 'SLIDE_COMMIT_SHA', 'SLIDE_SOURCE_DIGEST']) vi.stubEnv(key, '');
      const start = async () => {
        const service = new SourceManagementService(() => pool, [origin]);
        await registerSourceRoutes(app, async request => {
          (request as any).user = { userId: 1, username: 'fixture', permissions: request.headers.authorization === 'reader' ? ['config:view'] : ['admin:*'] };
        }, service);
        return app.listen({ port: 0, host: '127.0.0.1' });
      };
      let api = await start();
      const call = async (path: string, body?: unknown, method = 'POST', reader = false) => {
        const response = await fetch(api + '/api/platform/source/' + path, {
          method: body === undefined ? 'GET' : method,
          headers: { 'Content-Type': 'application/json', ...(reader ? { authorization: 'reader' } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() as any };
      };
      const proxy = origin.replace('http://', 'http://fixture-proxy-user:fixture-proxy-credential@');
      const config = { provider: 'gitlab', baseUrl: origin, repositoryPath: 'group/repo', ref: commit, allowedPaths: [], allowModelContent: false, httpProxy: proxy };
      expect(await call('config', config, 'PUT')).toMatchObject({ status: 200 });
      const readerConfig = await call('config', undefined, 'GET', true);
      expect(readerConfig.status).toBe(200); expect(JSON.stringify(readerConfig.body)).not.toContain('fixture-proxy-credential');
      expect(readerConfig.body.config.httpProxy).toBe(origin + '/');
      const sync = await call('sync', { token });
      expect(sync).toMatchObject({ status: 200, body: { commitSha: commit, completeness: 'partial',
        files: [{ path: 'src/a.ts' }], skippedFiles: [{ path: 'manifest.json', reason: 'SOURCE_PATH_INVALID' }],
        verification: { status: 'repository-unbound', reason: 'SOURCE_DEPLOYMENT_UNKNOWN' } } });
      const stored = JSON.parse(readFileSync(join(snapshotRoot, sync.body.releaseId, 'manifest.json'), 'utf8'));
      expect(stored.signature).toMatch(/^[a-f0-9]{64}$/);
      expect(await new SourceSnapshotService(snapshotRoot, signingKey).manifest(sync.body.releaseId)).toMatchObject({ commitSha: commit });
      expect(await call('manifest')).toMatchObject({ status: 200, body: { commitSha: commit } });
      expect(await call('sync', { token })).toMatchObject({ status: 200, body: { releaseId: sync.body.releaseId, commitSha: commit } });
      await app.close(); app = Fastify(); api = await start();
      expect(await call('manifest')).toMatchObject({ status: 200, body: { releaseId: sync.body.releaseId, commitSha: commit } });
      expect(await call('region?path=src/a.ts&startLine=1&endLine=1')).toMatchObject({ status: 200, body: { content: 'export const selected = "release";' } });
      expect(await call('config', { ...config, allowedPaths: ['src/'] }, 'PUT')).toMatchObject({ status: 200 });
      const complete = await call('sync', { token }); expect(complete).toMatchObject({ status: 200, body: { commitSha: commit, completeness: 'complete' } });
      vi.stubEnv('SLIDE_RELEASE_ID', 'deployed'); vi.stubEnv('SLIDE_COMMIT_SHA', commit); vi.stubEnv('SLIDE_SOURCE_DIGEST', complete.body.treeDigest);
      expect(await call('manifest')).toMatchObject({ status: 200, body: { verification: { status: 'deployment-verified' } } });
      vi.stubEnv('SLIDE_COMMIT_SHA', mainCommit);
      expect(await call('manifest')).toMatchObject({ status: 200, body: { verification: { status: 'repository-unbound', reason: 'SOURCE_COMMIT_MISMATCH' } } });
      expect(await call('region?path=src/a.ts&startLine=1&endLine=1')).toMatchObject({ status: 200, body: { content: 'export const selected = "release";', source: { commitSha: commit } } });
      const [configs] = await pool.query('SELECT config_value FROM system_config');
      const [audits] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM audit_log_entries');
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(configs)).not.toContain(token); expect(JSON.stringify(audits)).not.toContain(token);
      expect(JSON.stringify(audits)).not.toContain('fixture-proxy-credential'); expect(proxyRequests).toBeGreaterThan(0);
    } finally {
      await app.close(); auditLogManager.setPersistentStore(memoryAuditLogStore);
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await pool.end(); await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
