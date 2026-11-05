import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/migrations/runner.js';

const root = resolve(import.meta.dirname, '../../..');
const envFile = process.env.MAX326_TEST_ENV_FILE;
const tables = ['database_instances', 'servers', 'llm_providers', 'notification_channels', 'network_devices', 'network_device_credentials', 'agent_credential_references'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Run inside a disposable OS/container: the missing/empty HOME cases really
// write under its passwd home. Never overwrite an existing operator audit.
describe.skipIf(!envFile)('MAX-326 real MySQL and CLI / #695', () => {
  it('resolves paths and refuses unavailable homes before any database mutation', async () => {
    if (process.env.MAX326_TEST_ISOLATED_OS_HOME !== '1') throw new Error('A disposable OS home is required for this test');
    const config = parse(readFileSync(envFile!, 'utf8'));
    if (!config.DB_HOST || !config.DB_PORT || !config.DB_USER) throw new Error('Explicit MySQL endpoint required');
    const connection = { host: config.DB_HOST, port: Number(config.DB_PORT), user: config.DB_USER, password: config.DB_PASSWORD ?? '' };
    const name = `max326_${randomBytes(8).toString('hex')}`;
    const directory = mkdtempSync(join(tmpdir(), 'max326-'));
    const admin = await mysql.createConnection(connection);
    let db: mysql.Connection | undefined;
    let pool: mysql.Pool | undefined;
    const ownedAudits: string[] = [];
    try {
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log(JSON.stringify({ fixtureCreated: name }));
      pool = mysql.createPool({ ...connection, database: name });
      await new MigrationRunner(pool as any).run();
      db = await mysql.createConnection({ ...connection, database: name });
      const [version] = await db.query<RowDataPacket[]>('SELECT VERSION() AS version');
      console.log(JSON.stringify({ database: name, mysql: version[0].version, fullMigrations: true }));
      await db.query("INSERT INTO users (id,username,password_hash) VALUES (326,'max326-fixture','synthetic-hash')");
      await db.query("INSERT INTO database_instances (name,host,port,username,password_encrypted,connection_string,status,health_status) VALUES ('fixture','192.0.2.16',3306,'fixture','instance-cipher','synthetic-uri','active','healthy')");
      await db.query("INSERT INTO servers (host,os_type,credential_type,credential_encrypted,status) VALUES ('192.0.2.17','linux','password','server-cipher','online')");
      await db.query('DELETE FROM llm_providers');
      await db.query("INSERT INTO llm_providers (name,display_name,deployment_type,api_key_encrypted,enabled,is_default) VALUES ('cloud','cloud','cloud','provider-cipher',1,1)");
      await db.query("INSERT INTO notification_channels (name,type,config,delivery_start_at) VALUES ('fixture','webhook',JSON_OBJECT('secret','channel-cipher','name','ops'),NOW())");
      await db.query("INSERT INTO network_devices (id,name,host,status) VALUES (326,'fixture','192.0.2.18','online')");
      await db.query("INSERT INTO network_device_credentials (device_id,protocol,username,credential_encrypted) VALUES (326,'ssh','fixture','network-cipher')");
      await db.query("INSERT INTO agent_credential_references (ref_id,owner_id,tool_name,secret_encrypted,status,expires_at) VALUES ('max326-ref',326,'fixture','reference-cipher','active',DATE_ADD(NOW(),INTERVAL 1 DAY))");
      const selectedEnv = join(directory, 'selected.env');
      writeFileSync(selectedEnv, '', { mode: 0o600 });
      const key = randomBytes(32).toString('hex');
      const unavailable = join(directory, 'no-home.mjs');
      writeFileSync(unavailable, "import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ''; os.userInfo = () => { throw new Error('synthetic missing OS account'); }; syncBuiltinESMExports();\n");
      const osAudit = join(userInfo().homedir, '.config/slide/recovery/lost-encryption-key-rotation.json');
      const home = join(directory, 'home');
      const cases = [
        { name: 'HOME missing', env: {}, audit: osAudit },
        { name: 'HOME empty', env: { HOME: '' }, audit: osAudit },
        { name: 'HOME set', env: { HOME: home }, audit: join(home, '.config/slide/recovery/lost-encryption-key-rotation.json') },
        { name: 'empty explicit path', env: { HOME: home, SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH: '' }, audit: join(home, '.config/slide/recovery/lost-encryption-key-rotation.json') },
        { name: 'explicit absolute path without home', env: { HOME: '', NODE_OPTIONS: `--import=${unavailable}`, SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH: join(directory, 'explicit.json') }, audit: join(directory, 'explicit.json') },
        { name: 'explicit relative path', env: { HOME: '', NODE_OPTIONS: `--import=${unavailable}`, SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH: 'relative/audit.json' }, audit: join(directory, 'relative/audit.json') },
        { name: 'OS account unavailable; HOME missing', env: { NODE_OPTIONS: `--import=${unavailable}` }, audit: undefined },
        { name: 'OS account unavailable; HOME empty', env: { HOME: '', NODE_OPTIONS: `--import=${unavailable}` }, audit: undefined },
      ];
      const snapshot = async () => {
        const rows = [];
        for (const table of tables) rows.push((await db!.query(`SELECT * FROM ${table}`))[0]);
        return hash(JSON.stringify(rows));
      };
      for (const test of cases) {
        if (test.audit && existsSync(test.audit)) throw new Error('Refusing to overwrite an existing audit');
        const before = await snapshot();
        const result = spawnSync(join(root, 'apps/db-ops-api/node_modules/.bin/tsx'), [join(root, 'scripts/recovery/rotate-lost-encryption-key.ts'), '--env-file', selectedEnv], {
          cwd: directory, encoding: 'utf8', timeout: 30000,
          env: { PATH: process.env.PATH ?? '', DB_HOST: connection.host, DB_PORT: String(connection.port), DB_USER: connection.user, DB_PASSWORD: connection.password, DB_NAME: name,
            ENCRYPTION_KEY: key, SLIDE_ROTATE_LOST_ENCRYPTION_KEY: 'CONFIRM_LOST_KEY_ROTATION', ...test.env },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output.includes(key)).toBe(false);
        if (connection.password) expect(output.includes(connection.password)).toBe(false);
        expect(result.status, test.name).toBe(test.audit ? 0 : 1);
        expect(existsSync(join(directory, 'undefined'))).toBe(false);
        const after = await snapshot();
        if (test.audit) {
          ownedAudits.push(test.audit);
          expect(output).toContain(JSON.stringify(test.audit));
          const text = readFileSync(test.audit, 'utf8');
          expect(statSync(test.audit).mode & 0o777).toBe(0o600);
          expect(JSON.parse(text).entries.instances).toHaveLength(1);
          expect(after).not.toBe(before);
          for (const secret of [key, 'instance-cipher', 'channel-cipher', 'reference-cipher']) expect(text.includes(secret)).toBe(false);
          console.log(JSON.stringify({ case: test.name, exit: result.status, auditPath: test.audit, auditMode: '0600', auditSha256: hash(text), noSecrets: true }));
          rmSync(test.audit);
        } else {
          expect(output).toContain('Cannot determine the recovery audit directory');
          expect(output).toContain('SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH');
          expect(after).toBe(before);
          expect(existsSync(osAudit)).toBe(false);
          console.log(JSON.stringify({ case: test.name, exit: result.status, snapshotBefore: before, snapshotAfter: after, noDatabaseMutation: true, noUndefinedDirectory: true }));
        }
      }
    } finally {
      await db?.end();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      const [remaining] = await admin.query<RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
      expect(remaining).toHaveLength(0);
      await admin.end();
      for (const audit of ownedAudits) rmSync(audit, { force: true });
      rmSync(directory, { recursive: true, force: true });
      console.log(JSON.stringify({ fixtureDropped: name, temporaryFilesRemoved: true }));
    }
  }, 120000);
});
