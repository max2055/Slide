import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerChatRoutes } from '../chat-routes.js';
import { dbConnection } from '../db-connection.js';
import { registerHttpSecurity } from '../security/http-security.js';
import { registerCronRoutes } from './cron-routes.js';

it('MAX-684 returns the created script JSON over a socket with production async hooks', async () => {
  const app = Fastify();
  // Keep ScriptService and the INSERT path real; only the SQL transport is controlled.
  // Real MySQL persistence is additionally covered by the isolated browser acceptance.
  const execute = vi.fn(async () => [{ insertId: 37 }, []]);
  const pool = vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  const verifyToken = async (request: any) => {
    request.user = { userId: 7, roles: ['admin'], permissions: ['*'] };
  };
  const authorizeChat = vi.fn();
  const handleChatSend = vi.fn();
  try {
    app.addHook('onSend', async (_request, _reply, payload) => payload);
    await registerHttpSecurity(app);
    await registerChatRoutes(app, { verifyToken, service: {} as any, authorizeChat, handleChatSend });
    registerCronRoutes(app, verifyToken, () => undefined);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/cron/scripts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'socket regression', content: 'SELECT 7 AS qualified_value', target_db_type: 'mysql' }),
    });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeGreaterThan(0);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(body)).toEqual({ id: 37, message: '创建成功' });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      'INSERT INTO cron_scripts (name, description, script_type, content, target_db_type) VALUES (?, ?, ?, ?, ?)',
      ['socket regression', null, 'sql', 'SELECT 7 AS qualified_value', 'mysql'],
    );
    expect(authorizeChat).not.toHaveBeenCalled();
    expect(handleChatSend).not.toHaveBeenCalled();
  } finally {
    await app.close();
    pool.mockRestore();
  }
});
