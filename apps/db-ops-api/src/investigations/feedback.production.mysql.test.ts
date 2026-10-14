import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { startFeedbackFixture } from './feedback-test-fixture.js';

const mysqlPort = Number(process.env.T11_TEST_MYSQL_PORT);
describe.skipIf(!mysqlPort)('T11 actual server.ts production HTTP registration', () => {
  let f: Awaited<ReturnType<typeof startFeedbackFixture>>, child: ChildProcess, url: string;
  let logs = '';
  beforeAll(async () => {
    f = await startFeedbackFixture(mysqlPort);
    // Formal D1 standby: no worker, model send, collector or external target.
    await f.rows("INSERT INTO worker_leases (lease_name,owner_id,fencing_token,expires_at) VALUES ('slide-singleton-workers','t11-test-holder',1,DATE_ADD(NOW(),INTERVAL 10 MINUTE))");
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(done => listener.close(() => done())); url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DB_HOST: '127.0.0.1', DB_PORT: String(mysqlPort), DB_USER: 'root',
      DB_PASSWORD: process.env.T11_TEST_MYSQL_PASSWORD ?? '', DB_NAME: f.database,
      JWT_SECRET_KEY: f.secret, ENCRYPTION_KEY: randomBytes(32).toString('hex'), DOTENV_CONFIG_PATH: '/dev/null',
      PROMPT_HOT_RELOAD: 'false', SLIDE_MEMORY_PIPELINE_ENABLED: 'false',
    } });
    child.stdout!.on('data', b => { logs = (logs + b).slice(-30_000); });
    child.stderr!.on('data', b => { logs = (logs + b).slice(-30_000); });
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw Error(`server failed: ${logs}`);
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
    }, { timeout: 60_000, interval: 250 });
  }, 90_000);
  afterAll(async () => {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await f?.close();
  }, 30_000);
  it('uses default pool and real JWT for audit, evidence rejection, closure and reopen', async () => {
    const s = await f.seed(), path = `${url}/api/investigations/${s.inv.id}`;
    const headers = { authorization: `Bearer ${f.tokens.owner}`, 'content-type': 'application/json' };
    const post = (body: unknown, key = randomUUID()) => fetch(`${path}/feedback`, { method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(body) });
    expect((await fetch(`${path}/feedback`)).status).toBe(401);
    expect((await fetch(`${path}/feedback`, { headers })).status).toBe(200);
    expect((await post({ ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved' })).status).toBe(400);
    const key = randomUUID(), command = { ...s.base, kind: 'close', lifecycle: 'closed', problemStatus: 'resolved', verification: s.verification };
    const response = await post(command, key); expect(response.status).toBe(200); const closure = await response.json() as { version: number };
    expect(await (await post(command, key)).json()).toEqual(closure);
    const patched = await fetch(path, { method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: closure.version, lifecycle: 'open' }) });
    expect(patched.status).toBe(200); expect((await patched.json() as { problemStatus: string }).problemStatus).toBe('unconfirmed');
    const history = await (await fetch(`${path}/feedback`, { headers })).json() as { items: Array<{ command: { resultId: string } }> };
    expect(history.items[0].command.resultId).toBe(s.result.id);
    await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');
    expect((await fetch(`${path}/feedback`, { headers })).status).toBe(404);
    expect((await post(command, key)).status).toBe(404);
    expect(logs).toContain('WORKER_LEASE_UNAVAILABLE');
  });
});
