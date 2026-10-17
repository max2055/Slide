/** Exact server.ts process, disposable platform schema, API-only lease owner.
 * No worker may claim jobs, call a model or contact a target in this test. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { startFeedbackFixture } from '../investigations/feedback-test-fixture.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('P10 actual server process registration', () => {
  it('serves authenticated operations from server.ts while an isolated lease prevents all workers', async () => {
    process.env.T11_TEST_MYSQL_PASSWORD = process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '';
    const fixture = await startFeedbackFixture(port);
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const httpPort = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    let child: ChildProcess | undefined, output = '';
    try {
      await fixture.rows("INSERT INTO worker_leases(lease_name,owner_id,fencing_token,expires_at) VALUES('slide-singleton-workers','p10-test-reserved',1,DATE_ADD(NOW(),INTERVAL 5 MINUTE))");
      child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), env: {
        ...process.env, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root',
        DB_PASSWORD: process.env.T11_TEST_MYSQL_PASSWORD, DB_NAME: fixture.database,
        PORT: String(httpPort), JWT_SECRET_KEY: fixture.secret, ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false', INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false',
        OPERATIONS_CONTEXT_ENABLED: 'true', OPERATIONS_CASES_ENABLED: 'true', OPERATIONS_BASELINES_ENABLED: 'false',
        OPERATIONS_ATTENTION_ENABLED: 'false', OPERATIONS_ACTION_PLANS_ENABLED: 'false',
        OPERATIONS_ACTION_DISPATCH_ENABLED: 'false', OPERATIONS_STOP_NEW_DISPATCH: 'true',
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
      const deadline = Date.now() + 30_000;
      while (!output.includes('服务器已启动') && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
      expect(output, 'actual server must finish API-only initialization').toContain('WORKER_LEASE_UNAVAILABLE');
      const headers = { Authorization: `Bearer ${fixture.tokens.owner}` };
      const response = await fetch(`http://127.0.0.1:${httpPort}/api/operations/knowledge`, { headers });
      expect(response.status).toBe(404); // authenticated original role has no new permission
      await fixture.rows("INSERT INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code='operations:cases:view'");
      const allowed = await fetch(`http://127.0.0.1:${httpPort}/api/operations/knowledge`, { headers });
      expect(allowed.status).toBe(200); expect((await allowed.json() as any).qualification).toBe('not_qualified');
      await fixture.rows("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='operations:cases:view'");
      expect((await fetch(`http://127.0.0.1:${httpPort}/api/operations/knowledge`, { headers })).status).toBe(404);
      const anon = await fetch(`http://127.0.0.1:${httpPort}/api/operations/knowledge`); expect(anon.status).toBe(401);
      const noExecute = await fetch(`http://127.0.0.1:${httpPort}/api/operations/actions/execute`, { method: 'POST', headers }); expect(noExecute.status).toBe(404);
      const [lease] = await fixture.rows("SELECT owner_id FROM worker_leases WHERE lease_name='slide-singleton-workers'"); expect(lease.owner_id).toBe('p10-test-reserved');
      expect((await fixture.rows('SELECT COUNT(*) n FROM action_executions'))[0].n).toBe(0);
    } finally {
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        const timeout = setTimeout(() => child?.kill('SIGKILL'), 10_000);
        await exited; clearTimeout(timeout);
      }
      await writeFile('.p10-server-process.log', output);
      await fixture.close();
    }
  }, 60_000);
});
