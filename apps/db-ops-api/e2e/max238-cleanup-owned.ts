import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { dropOwnedDatabase } from '../src/testing/owned-fixture.js';

const nonce = process.env.MAX238_E2E_NONCE!;
const port = Number(process.env.MAX238_TEST_MYSQL_PORT);
if (!nonce || !port || port === 3306) throw new Error('missing exact run nonce and isolated port');
const schemaNonce = createHash('sha256').update(nonce).digest('hex').slice(0, 24);
const user = `max238cn_ro_${createHash('sha256').update(nonce).digest('hex').slice(0, 16)}`;
const root = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
try {
  const handleDir = `${process.cwd()}/.max238-handles`;
  await dropOwnedDatabase(root, { nonce: schemaNonce, purpose: 'cntarget', handleDir });
  await dropOwnedDatabase(root, { nonce: schemaNonce, purpose: 'cnplatform', handleDir });
  await root.query(`DROP USER '${user}'@'%'`);
} finally { await root.end(); }
