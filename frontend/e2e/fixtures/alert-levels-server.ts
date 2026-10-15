import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { MigrationRunner } from '../../../apps/db-ops-api/src/migrations/runner.js';
import { dbConnection } from '../../../apps/db-ops-api/src/db-connection.js';
import { ActorContextService, signAccessToken } from '../../../apps/db-ops-api/src/auth/actor-context.js';
import { createVerifyToken } from '../../../apps/db-ops-api/src/auth-middleware.js';
import { requirePermission, hasPermission } from '../../../apps/db-ops-api/src/auth/require-permission.js';
import { getAccessibleInstanceIds, hasInstanceAccess } from '../../../apps/db-ops-api/src/auth/require-instance-access.js';
import { alertDatabaseService } from '../../../apps/db-ops-api/src/alert-database-service.js';
import { alertEscalationService } from '../../../apps/db-ops-api/src/alert-escalation-service.js';

/** Real SQL, JWT, live permissions and production route handlers; no jobs/model calls. */
export async function startAlertLevelsServer() {
  const port = Number(process.env.ALERT_LEVEL_TEST_MYSQL_PORT);
  if (!port) throw new Error('Explicit disposable localhost MySQL port required');
  const require = createRequire(resolve('../apps/db-ops-api/package.json'));
  const mysql = require('mysql2/promise');
  const Fastify = require('fastify');
  const { transpileModule } = require('typescript');
  const database = `max164_levels_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const connection = { host: '127.0.0.1', port, user: 'root', password: process.env.ALERT_LEVEL_TEST_MYSQL_PASSWORD ?? '' };
  const admin = mysql.createPool(connection);
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = mysql.createPool({ ...connection, database });
  const original = dbConnection.getPool;
  dbConnection.getPool = () => pool;
  const app = Fastify();
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const close = async () => {
    await vite?.close(); await app.close(); dbConnection.getPool = original;
    await pool.end();
    if (!/^max164_levels_\d+_[a-f0-9]+$/.test(database)) throw new Error('UNSAFE_SCHEMA');
    await admin.query(`DROP DATABASE ${database}`); await admin.end();
  };
  try {
    await new MigrationRunner(pool).run();
    await pool.query("INSERT INTO users (id,username,password_hash) VALUES (101,'max164-reader','no-login')");
    await pool.query("INSERT INTO roles (id,name) VALUES (101,'max164-reader')");
    await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('alert:view','alert:manage','instance:view','config:view')");
    await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101)');
    await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (101,'可见测试资源','fixture.invalid',3306,'fixture','unused'),(102,'不可见测试资源','fixture.invalid',3306,'fixture','unused')");
    await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-write')");
    const contexts = new ActorContextService(() => pool);
    const owner = await contexts.loadActiveActor(101);
    const secret = randomUUID();
    const verifyToken = createVerifyToken(secret, contexts);
    // Execute the current server.ts route registrations, rather than copying a simplified API.
    const source = readFileSync(resolve('../apps/db-ops-api/server.ts'), 'utf8');
    const listRoutes = source.slice(source.indexOf("  fastify.get('/api/alerts',"), source.indexOf('  // 确认告警（'));
    const escalationRoutes = source.slice(source.indexOf("  fastify.get('/api/alerts/escalation/rules',"), source.indexOf("  fastify.post('/api/alerts/escalation/check',"));
    const names = ['fastify','verifyToken','requirePermission','hasPermission','hasInstanceAccess','getAccessibleInstanceIds','alertDatabaseService','alertEscalationService'];
    new Function(...names, transpileModule(listRoutes + escalationRoutes, {}).outputText)(app, verifyToken, requirePermission, hasPermission, hasInstanceAccess, getAccessibleInstanceIds, alertDatabaseService, alertEscalationService);
    app.get('/api/auth/permissions', { preHandler: [verifyToken] }, (request: any) => request.user.permissions);
    // Ancillary page data is empty in this fixture; alert reads/writes are production handlers.
    app.get('/api/*', async () => []);
    const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'),
      server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: apiUrl, changeOrigin: true } } } });
    await vite.listen();
    return { url: `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`, pool, close, owner, token: signAccessToken(owner, secret) };
  } catch (error) { await close(); throw error; }
}
