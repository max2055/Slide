import '../../apps/db-ops-api/node_modules/dotenv/config.js';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';

const database = process.env.QUALIFICATION_DB_NAME ?? 'db_ops_ai_qualification';
if (!/^db_ops_ai_qualification(?:_[a-z0-9_]+)?$/.test(database)) {
  throw new Error('qualification reset requires a db_ops_ai_qualification database name');
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
try {
  await db.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await db.query(`CREATE DATABASE \`${database}\` DEFAULT CHARACTER SET utf8mb4`);
  console.log(`qualification database reset: ${database}`);
} finally {
  await db.end();
}
