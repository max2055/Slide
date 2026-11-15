import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { AuthDatabaseService } from './auth-database-service.js';

describe('MAX-669 / #299 user deletion errors', () => {
  for (const byId of [true, false]) {
    const remove = (service: AuthDatabaseService) => byId ? service.deleteUserById(42) : service.deleteUser('audited');
    for (const error of [
      { code: 'ER_ROW_IS_REFERENCED_2', errno: 1451, message: 'SQL DELETE users fk_agent_tool_audit_actor' },
      { code: 'ER_ACCESS_DENIED_ERROR', message: 'SQL connection secret details' },
    ]) {
      it(`${byId ? 'ID' : 'username'} hides database details for ${error.code}`, async () => {
        const execute = vi.fn(async (sql: string) => {
          if (sql.startsWith('SELECT')) return [[{ id: 42, username: 'audited' }]];
          throw error;
        });
        const service = new AuthDatabaseService(() => ({ execute }) as unknown as mysql.Pool);
        const result = await remove(service);
        expect(result.success).toBe(false);
        expect(result.error).not.toMatch(/SQL|DELETE|fk_|secret/);
        if (error.errno === 1451) {
          expect(result).toMatchObject({ code: 'USER_HAS_RETAINED_RECORDS' });
          expect(result.error).toContain('停用');
          expect(result.error).toContain('审计');
        }
      });
    }
  }

  it('the production DELETE route hides unexpected failures and preserves self-delete protection', async () => {
    const app = Fastify();
    const service = { deleteUserById: vi.fn().mockRejectedValue(new Error('SQL secret details')) };
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  // 删除用户\n'), end = source.indexOf('  // 重置密码\n', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    new Function('fastify', 'verifyToken', 'requirePermission', 'authDatabaseService',
      ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    )(app, async (request: any) => { request.user = { userId: 1 }; }, () => async () => {}, service);
    try {
      const failure = await app.inject({ method: 'DELETE', url: '/api/users/42' });
      expect(failure.statusCode).toBe(500);
      expect(failure.body).not.toMatch(/SQL|secret/);
      service.deleteUserById.mockClear();
      const self = await app.inject({ method: 'DELETE', url: '/api/users/1' });
      expect(self.statusCode).toBe(400);
      expect(self.json().error).toBe('不能删除自己');
      expect(service.deleteUserById).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
