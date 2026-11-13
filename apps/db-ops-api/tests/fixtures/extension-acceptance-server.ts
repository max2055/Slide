import Fastify from 'fastify';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dbConnection } from '../../src/db-connection.js';
import { registerExtensionRoutes } from './extension-routes.js';

// Explicit opt-in acceptance only; never read private credentials during test collection.
const profileFile = process.env.SLIDE_EXTENSION_PROFILE_FILE;
const profileKey = process.env.SLIDE_EXTENSION_PROFILE_KEY;
if (!profileFile || !profileKey) throw new Error('Set SLIDE_EXTENSION_PROFILE_FILE and SLIDE_EXTENSION_PROFILE_KEY');
const profile = JSON.parse(readFileSync(profileFile, 'utf8'))[profileKey];
const config = { host: profile.host, port: profile.port, user: profile.user, password: profile.password };
const schema = `max428_${process.pid}_${randomBytes(4).toString('hex')}`;
const owner = await mysql.createConnection(config);
let pool: mysql.Pool | undefined;
const app = Fastify();
let permissions = ['*'];
let stopped = false;
async function cleanup() {
  if (stopped) return; stopped = true;
  await app.close();
  await pool?.end();
  await owner.query(`DROP DATABASE IF EXISTS \`${schema}\``);
  const [rows] = await owner.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schema]);
  console.log(JSON.stringify({ cleanup: 'passed', remainingSchemas: (rows as unknown[]).length, schema }));
  await owner.end();
}
try {
  await owner.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  pool = mysql.createPool({ ...config, database: schema, connectionLimit: 2 });
  await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
  await pool.query('INSERT INTO users VALUES (1)');
  await pool.query(readFileSync(new URL('../../sql/migrations/076_agent_extensions.sql', import.meta.url), 'utf8'));
  dbConnection.getPool = () => pool!;
  app.post('/fixture/access', async request => { permissions = (request.body as { permissions: string[] }).permissions; return { ok: true }; });
  app.get('/fixture/rows', async () => { const [rows] = await pool!.query('SELECT id, name, description, digest, status FROM agent_extensions ORDER BY id'); return rows; });
  registerExtensionRoutes(app, async request => {
    if (request.headers.authorization !== 'Bearer extension-fixture') throw new Error('Fixture token required');
    (request as any).user = { userId: 1, username: 'fixture', roles: [], permissions };
  });
  await app.listen({ host: '127.0.0.1', port: Number(process.env.SLIDE_EXTENSION_API_PORT || 3198) });
  console.log(JSON.stringify({ ready: true, schema, mysqlPort: config.port, auth: 'injected fixture actor; production requirePermission and extension routes/service' }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void cleanup().then(() => process.exit(0), error => { console.error(error.code || error.name); process.exit(1); }); });
} catch (error) { await cleanup(); throw error; }
