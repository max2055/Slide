import { randomUUID } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { chatDatabaseService } from './chat-database-service.js';
import { MigrationRunner } from './migrations/runner.js';
import type { ActorContext } from './auth/actor-context.js';

const engine = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('./adapter/get-agent-engine.js', () => ({ getAgentEngine: async () => engine }));
import { handleChatSend } from './chat-handler.js';

// Opt in with the same injected MySQL configuration as the existing CI suites.
const port = process.env.INVESTIGATION_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT;
describe.skipIf(!port)('MAX-629 handler error propagation with real MySQL (#502)', () => {
  const database = `max629_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  const actor: ActorContext = {
    userId: 1, username: 'handler-fixture', roles: [], permissions: [],
    sessionVersion: 1, instanceScopes: {}, requestId: 'max629',
  };

  beforeAll(async () => {
    const options = {
      host: process.env.REPORT_TEST_MYSQL_HOST ?? '127.0.0.1',
      port: Number(port),
      user: process.env.REPORT_TEST_MYSQL_USER ?? 'root',
      password: process.env.INVESTIGATION_TEST_MYSQL_PASSWORD ?? process.env.REPORT_TEST_MYSQL_PASSWORD ?? '',
      connectionLimit: 2,
    };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    await new MigrationRunner(pool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    try { await pool?.end(); }
    finally {
      if (admin) {
        try { await admin.query(`DROP DATABASE IF EXISTS ${database}`); }
        finally { await admin.end(); }
      }
    }
  });

  it.each([
    { chatFails: true, saveFails: true },
    { chatFails: true, saveFails: false },
    { chatFails: false, saveFails: true },
    { chatFails: false, saveFails: false },
  ])('chat failure=$chatFails, assistant save failure=$saveFails', async ({ chatFails, saveFails }) => {
    const session = await chatDatabaseService.createSession(actor, { title: 'MAX-629 isolated test' });
    const chatError = new Error('deterministic engine failure');
    const result = { finalContent: 'final answer', stopReason: 'completed' };
    engine.chat.mockImplementationOnce(async (_key, _message, emit) => {
      emit({ type: 'text_delta', delta: 'partial answer' });
      if (chatFails) throw chatError;
      return result;
    });
    if (saveFails) {
      await pool.query(`CREATE TRIGGER reject_assistant BEFORE INSERT ON chat_messages FOR EACH ROW
        BEGIN IF NEW.role = 'assistant' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX-629 injected assistant write failure';
        END IF; END`);
    }
    try {
      const outcome = await handleChatSend(actor, { sessionKey: session.session_id, message: 'hello' })
        .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      if (chatFails && saveFails) {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        expect(outcome.error.cause).toBe(chatError);
        expect(outcome.error.errors[0]).toBe(chatError);
        expect(outcome.error.errors).toHaveLength(2);
        expect(outcome.error.errors[1]).toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
      } else if (chatFails) {
        expect(outcome.error).toBe(chatError);
      } else if (saveFails) {
        expect(outcome.error).toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
      } else {
        expect(outcome.error).toBeUndefined();
        expect(outcome.value).toEqual({ ...result, sessionKey: session.session_id });
      }
      const messages = await chatDatabaseService.getMessages(actor, session.session_id);
      expect(messages.map(message => message.role)).toEqual(saveFails ? ['user'] : ['user', 'assistant']);
      expect(messages[0].content).toBe('hello');
      if (!saveFails) {
        expect(messages[1].content).toBe(chatFails ? 'partial answer' : 'final answer');
        expect(messages[1].parent_id).toBe(messages[0].message_id);
      }
      expect((await chatDatabaseService.getSession(actor, session.session_id)).message_count).toBe(saveFails ? 1 : 2);
    } finally {
      if (saveFails) await pool.query('DROP TRIGGER reject_assistant');
    }
  });
});
