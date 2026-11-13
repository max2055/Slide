import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import mysql, { type Connection, type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import { FeedbackService, type FeedbackStatus } from './feedback-service.js';
import { registerFeedbackRoutes } from './feedback-routes.js';

// Explicit opt-in only; configuration is injected, never read from developer credentials.
const enabled = process.env.FEEDBACK_TEST_MYSQL === '1' || Boolean(process.env.T06_TEST_MYSQL_PORT);
describe.skipIf(!enabled)('GitHub #517 feedback updates on real MySQL', () => {
  const database = `feedback_517_${randomUUID().replaceAll('-', '')}`;
  const owner: ActorContext = {
    userId: 7, username: 'alice', roles: [], permissions: [], sessionVersion: 1,
    instanceScopes: {}, requestId: 'feedback-mysql-test',
  };
  const admin = { ...owner, userId: 9, username: 'operator', roles: ['admin'] };
  const content = { title: '更新标题', description: '更新描述' };
  let control: Connection;
  let first: Pool;
  let second: Pool;
  let id: number;

  beforeAll(async () => {
    if (!process.env.FEEDBACK_TEST_MYSQL_CONFIG && !process.env.T06_TEST_MYSQL_PORT) {
      throw new Error('FEEDBACK_TEST_MYSQL_CONFIG or isolated T06_TEST_MYSQL_PORT required');
    }
    const config = process.env.FEEDBACK_TEST_MYSQL_CONFIG
      ? JSON.parse(process.env.FEEDBACK_TEST_MYSQL_CONFIG)
      : { host: '127.0.0.1', port: Number(process.env.T06_TEST_MYSQL_PORT), user: 'root', password: process.env.T06_TEST_MYSQL_PASSWORD ?? '' };
    control = await mysql.createConnection(config);
    await control.query(`CREATE DATABASE \`${database}\``);
    first = mysql.createPool({ ...config, database, connectionLimit: 1 });
    second = mysql.createPool({ ...config, database, connectionLimit: 1 });
    // Only the referenced user columns are needed; feedback DDL is the applied migration.
    await first.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, username VARCHAR(100))');
    await first.query("INSERT INTO users VALUES (7, 'alice'), (8, 'bob'), (9, 'operator')");
    for (const name of ['084_problem_feedback.sql', '085_problem_feedback_status.sql']) {
      const sql = await readFile(new URL(`../sql/migrations/${name}`, import.meta.url), 'utf8');
      await first.query(sql);
    }
  }, 15_000);

  afterAll(async () => {
    await Promise.all([first?.end(), second?.end()]);
    if (control) {
      try { await control.query(`DROP DATABASE IF EXISTS \`${database}\``); }
      finally { await control.end(); }
    }
  });

  beforeEach(async () => {
    await first.query('DELETE FROM problem_feedback');
    const item = await new FeedbackService(() => executor(first)).create(owner, {
      title: '原标题', description: '原描述', source: 'manual',
    });
    id = item.id;
  });

  function executor(pool: Pool) {
    return {
      async execute<T>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
        return await pool.execute(sql, values as Parameters<Pool['execute']>[1]) as [T, unknown];
      },
    };
  }

  // Force a second connection's committed write after A's SELECT snapshot but before A's UPDATE.
  function afterSnapshot(action: () => Promise<unknown>) {
    let pending = true;
    return new FeedbackService(() => ({
      async execute<T>(sql: string, values?: unknown[]): Promise<[T, unknown]> {
        const result = await executor(first).execute<T>(sql, values);
        if (pending && sql.includes('SELECT f.id')) {
          pending = false;
          await action();
        }
        return result as [T, unknown];
      },
    }));
  }

  async function put(service: FeedbackService, actor: ActorContext, status?: FeedbackStatus) {
    const app = Fastify();
    await registerFeedbackRoutes(app, async (request) => { (request as { user?: ActorContext }).user = actor; }, service);
    try {
      return await app.inject({ method: 'PUT', url: `/api/feedback/${id}`, payload: { ...content, ...(status === undefined ? {} : { status }) } });
    } finally { await app.close(); }
  }

  async function stored() {
    const [rows] = await second.query<RowDataPacket[]>('SELECT title, description, status, updated_by FROM problem_feedback WHERE id = ?', [id]);
    return rows[0];
  }

  it.each([['owner', owner], ['admin', admin]] as const)('preserves concurrent resolution when %s edits content through PUT', async (_name, actor) => {
    const service = afterSnapshot(() => new FeedbackService(() => executor(second)).update(admin, id, { title: '原标题', description: '原描述', status: 'resolved' }));
    const response = await put(service, actor);
    expect(response.statusCode).toBe(200);
    expect(response.json().feedback).toMatchObject({ ...content, status: 'resolved' });
    expect(await stored()).toMatchObject({ ...content, status: 'resolved', updated_by: actor.userId });
  });

  it('keeps resolved when the content edit executes before resolution', async () => {
    expect((await put(new FeedbackService(() => executor(first)), owner)).statusCode).toBe(200);
    await new FeedbackService(() => executor(second)).update(admin, id, { ...content, status: 'resolved' });
    expect(await stored()).toMatchObject({ ...content, status: 'resolved' });
  });

  it('applies the last executed explicit status, including an intentional reopen', async () => {
    const service = afterSnapshot(() => new FeedbackService(() => executor(second)).update(admin, id, { ...content, status: 'resolved' }));
    const response = await put(service, owner, 'pending');
    expect(response.statusCode).toBe(200);
    expect(response.json().feedback.status).toBe('pending');
    expect(await stored()).toMatchObject({ ...content, status: 'pending' });
  });

  it('rejects another owner without changing stored content or status', async () => {
    const response = await put(new FeedbackService(() => executor(first)), { ...owner, userId: 8, username: 'bob' }, 'resolved');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'FEEDBACK_NOT_FOUND' });
    expect(await stored()).toMatchObject({ title: '原标题', status: 'pending' });
  });

  it('rechecks owner in UPDATE if ownership changes after the snapshot', async () => {
    const service = afterSnapshot(() => second.execute('UPDATE problem_feedback SET created_by = 8 WHERE id = ?', [id]));
    const response = await put(service, owner, 'resolved');
    expect(response.statusCode).toBe(404);
    expect(await stored()).toMatchObject({ title: '原标题', status: 'pending' });
  });

  it('returns not found if feedback is concurrently deleted', async () => {
    const service = afterSnapshot(() => new FeedbackService(() => executor(second)).delete(admin, id));
    const response = await put(service, owner);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'FEEDBACK_NOT_FOUND' });
    expect(await stored()).toBeUndefined();
  });
});
