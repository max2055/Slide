import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/migrations/runner.js';
import { LOST_KEY_ROTATION_SENTINEL } from '../src/credential-rotation.js';

const root = resolve(import.meta.dirname, '../../..');
const envFile = process.env.MAX316_TEST_ENV_FILE;
const tables = ['database_instances', 'servers', 'llm_providers', 'notification_channels', 'network_devices', 'network_device_credentials', 'agent_credential_references'];

// Opt in explicitly. Read credentials only from the authorized local file;
// create and drop only this test's randomly named databases, never DB_NAME.
describe.skipIf(!envFile)('MAX-316 real MySQL CLI recovery / GitHub #463', () => {
  async function fixture(backup: boolean, check: (db: mysql.Connection, run: (credentials?: { user: string; password: string }) => { status: number | null; output: string; audit: string }) => Promise<void>) {
    const config = parse(readFileSync(envFile!, 'utf8'));
    if (!config.DB_HOST || !config.DB_PORT || !config.DB_USER) throw new Error('Explicit MySQL endpoint required');
    const connection = { host: config.DB_HOST, port: Number(config.DB_PORT), user: config.DB_USER, password: config.DB_PASSWORD ?? '' };
    const name = `max316_${randomBytes(8).toString('hex')}`;
    const directory = mkdtempSync(join(tmpdir(), 'max316-'));
    const admin = await mysql.createConnection(connection);
    let db: mysql.Connection | undefined;
    let pool: mysql.Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log(JSON.stringify({ fixtureCreated: name }));
      pool = mysql.createPool({ ...connection, database: name });
      await new MigrationRunner(pool as any).run();
      db = await mysql.createConnection({ ...connection, database: name });
      const [version] = await db.query<RowDataPacket[]>('SELECT VERSION() AS version');
      const [historical] = await db.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_providers_backup'");
      expect(historical).toHaveLength(0);
      console.log(JSON.stringify({ database: name, endpoint: `${connection.host}:${connection.port}`, mysql: version[0].version, fullMigrations: true, backup }));
      await db.query("INSERT INTO users (id,username,password_hash) VALUES (316,'max316-fixture','synthetic-hash')");
      await db.query("INSERT INTO database_instances (name,host,port,username,password_encrypted,connection_string,status,health_status) VALUES ('fixture','192.0.2.16',3306,'fixture','instance-cipher','synthetic-uri','active','healthy')");
      await db.query("INSERT INTO servers (host,os_type,credential_type,credential_encrypted,status) VALUES ('192.0.2.17','linux','password','server-cipher','online')");
      await db.query("DELETE FROM llm_providers");
      await db.query("INSERT INTO llm_providers (name,display_name,deployment_type,api_key_encrypted,enabled,is_default) VALUES ('cloud','cloud','cloud','provider-cipher',1,1),('local','local','local',NULL,1,1)");
      await db.query("INSERT INTO notification_channels (name,type,config,delivery_start_at) VALUES ('fixture','webhook',JSON_OBJECT('secret','channel-cipher','name','ops'),NOW())");
      await db.query("INSERT INTO network_devices (id,name,host,status) VALUES (316,'fixture','192.0.2.18','online')");
      for (const protocol of ['ssh', 'snmpv2c', 'snmpv3']) {
        await db.execute('INSERT INTO network_device_credentials (device_id,protocol,username,credential_encrypted,auth_secret_encrypted,privacy_secret_encrypted,community_encrypted,host_key_fingerprint) VALUES (316,?,\'fixture\',\'credential-cipher\',\'auth-cipher\',\'privacy-cipher\',\'community-cipher\',\'SHA256:keep\')', [protocol]);
      }
      for (const status of ['active', 'consumed', 'expired', 'revoked']) {
        await db.execute("INSERT INTO agent_credential_references (ref_id,owner_id,tool_name,secret_encrypted,status,expires_at) VALUES (?,316,'fixture','reference-cipher',?,DATE_ADD(NOW(),INTERVAL 1 DAY))", [status, status]);
      }
      if (backup) {
        // Same table creation as the one-time historical migration, without
        // replaying its unrelated ALTERs against a current schema.
        await db.query('CREATE TABLE llm_providers_backup AS SELECT * FROM llm_providers');
      }
      const selectedEnv = join(directory, 'test.env');
      writeFileSync(selectedEnv, '', { mode: 0o600 });
      const audit = join(directory, 'audit.json');
      const key = randomBytes(32).toString('hex');
      const run = (credentials = { user: connection.user, password: connection.password }) => {
        const result = spawnSync(resolve(root, 'apps/db-ops-api/node_modules/.bin/tsx'), [resolve(root, 'scripts/recovery/rotate-lost-encryption-key.ts'), '--env-file', selectedEnv], {
          cwd: directory, encoding: 'utf8', timeout: 30000,
          env: { PATH: process.env.PATH ?? '', HOME: directory, DB_HOST: connection.host, DB_PORT: String(connection.port), DB_USER: credentials.user,
            DB_PASSWORD: credentials.password, DB_NAME: name, ENCRYPTION_KEY: key,
            SLIDE_ROTATE_LOST_ENCRYPTION_KEY: 'CONFIRM_LOST_KEY_ROTATION', SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH: audit },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output.includes(key)).toBe(false);
        if (connection.password) expect(output.includes(connection.password)).toBe(false);
        if (credentials.password) expect(output.includes(credentials.password)).toBe(false);
        return { status: result.status, output, audit };
      };
      await check(db, run);
      // For successful recovery, prove the stored network marker is encrypted
      // under the invocation's actual new key, not a usable old credential.
      const [network] = await db.query<RowDataPacket[]>('SELECT credential_encrypted FROM network_device_credentials LIMIT 1');
      if (network[0].credential_encrypted !== 'credential-cipher') {
        const [, , nonce, tag, ciphertext] = network[0].credential_encrypted.split(':');
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(nonce, 'hex'));
        decipher.setAuthTag(Buffer.from(tag, 'hex'));
        expect(decipher.update(ciphertext, 'hex', 'utf8') + decipher.final('utf8')).toBe(LOST_KEY_ROTATION_SENTINEL);
      }
    } finally {
      await db?.end();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  // Chief review: information_schema hides an existing table when this real
  // account has no privilege on it. That must never authorize skipping cleanup.
  it('refuses a real account with core permissions but no historical-table privileges', async () => {
    await fixture(true, async (db, run) => {
      const user = `m316_${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');
      const [database] = await db.query<RowDataPacket[]>('SELECT DATABASE() name');
      const schema = database[0].name;
      const config = parse(readFileSync(envFile!, 'utf8'));
      await db.query("CREATE USER ?@'%' IDENTIFIED BY ?", [user, password]);
      try {
        for (const table of tables) await db.query(`GRANT SELECT, UPDATE ON \`${schema}\`.\`${table}\` TO ?@'%'`, [user]);
        const restricted = await mysql.createConnection({ host: config.DB_HOST, port: Number(config.DB_PORT), user, password, database: schema });
        try {
          const [visible] = await restricted.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_providers_backup'");
          expect(visible).toHaveLength(0);
          console.log(JSON.stringify({ restrictedAccount: user, metadataVisible: visible.length, historicalTableExists: true }));
        } finally { await restricted.end(); }
        const before = await snapshot(db, true);
        const result = run({ user, password });
        expect(result.status, result.output).toBe(1);
        expect(result.output).toContain('denied');
        expect(result.output).not.toContain('"rotated":true');
        expect(await snapshot(db, true)).toBe(before);
      } finally {
        await db.query("DROP USER ?@'%'", [user]);
      }
    });
  }, 60000);

  async function snapshot(db: mysql.Connection, backup: boolean) {
    const rows = [];
    for (const table of [...tables, ...(backup ? ['llm_providers_backup'] : [])]) {
      const order = table === 'agent_credential_references' ? 'ref_id' : 'id';
      rows.push((await db.query(`SELECT * FROM \`${table}\` ORDER BY ${order}`))[0]);
    }
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  it.each([false, true])('commits full recovery on a migrated fresh database with historical backup=%s', async (backup) => {
    await fixture(backup, async (db, run) => {
      const result = run();
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain('"rotated":true');
      expect(statSync(result.audit).mode & 0o777).toBe(0o600);
      const audit = JSON.parse(readFileSync(result.audit, 'utf8'));
      expect(audit.entries.instances[0].ciphertextFingerprint).toBe(createHash('sha256').update('instance-cipher').digest('hex'));
      expect(audit.entries.networkCredentials).toHaveLength(3);
      const [instances] = await db.query<RowDataPacket[]>('SELECT connection_string,status,health_status FROM database_instances');
      expect(instances[0]).toMatchObject({ connection_string: null, status: 'inactive', health_status: 'unknown' });
      const [servers] = await db.query<RowDataPacket[]>('SELECT collection_enabled,status FROM servers');
      expect(servers[0]).toMatchObject({ collection_enabled: 0, status: 'offline' });
      const [providers] = await db.query<RowDataPacket[]>('SELECT deployment_type,api_key_encrypted,enabled,is_default FROM llm_providers ORDER BY name');
      expect(providers).toEqual([{ deployment_type: 'cloud', api_key_encrypted: null, enabled: 0, is_default: 0 }, { deployment_type: 'local', api_key_encrypted: null, enabled: 1, is_default: 1 }]);
      const [channels] = await db.query<RowDataPacket[]>('SELECT enabled,config FROM notification_channels');
      expect(channels[0]).toMatchObject({ enabled: 0, config: { name: 'ops' } });
      const [devices] = await db.query<RowDataPacket[]>('SELECT collection_enabled,status FROM network_devices');
      expect(devices[0]).toMatchObject({ collection_enabled: 0, status: 'unknown' });
      const [credentials] = await db.query<RowDataPacket[]>('SELECT auth_secret_encrypted,privacy_secret_encrypted,community_encrypted,host_key_fingerprint FROM network_device_credentials');
      expect(credentials).toHaveLength(3);
      for (const row of credentials) expect(row).toEqual({ auth_secret_encrypted: null, privacy_secret_encrypted: null, community_encrypted: null, host_key_fingerprint: 'SHA256:keep' });
      const [references] = await db.query<RowDataPacket[]>('SELECT ref_id,status,secret_encrypted FROM agent_credential_references ORDER BY ref_id');
      expect(references.map(row => row.status)).toEqual(['revoked', 'consumed', 'expired', 'revoked']);
      expect(references.every(row => row.secret_encrypted === 'reference-cipher')).toBe(true);
      if (backup) {
        const [rows] = await db.query<RowDataPacket[]>('SELECT api_key_encrypted FROM llm_providers_backup');
        expect(rows).toHaveLength(2);
        expect(rows.every(row => row.api_key_encrypted === null)).toBe(true);
      }
    });
  }, 60000);

  it.each(['bad column', 'trigger missing table', 'trigger denied', 'late failure without backup', 'late failure with backup'])('rolls back all SQL changes on %s', async (mode) => {
    const backup = mode !== 'late failure without backup';
    await fixture(backup, async (db, run) => {
      if (mode === 'bad column') await db.query('ALTER TABLE llm_providers_backup DROP COLUMN api_key_encrypted');
      if (mode === 'trigger missing table') await db.query('CREATE TRIGGER max316_missing BEFORE UPDATE ON llm_providers_backup FOR EACH ROW INSERT INTO max316_nonexistent VALUES (1)');
      if (mode === 'trigger denied') await db.query("CREATE TRIGGER max316_denied BEFORE UPDATE ON llm_providers_backup FOR EACH ROW SIGNAL SQLSTATE '42000' SET MESSAGE_TEXT = 'max316-denied'");
      if (mode.startsWith('late failure')) await db.query("CREATE TRIGGER max316_late BEFORE UPDATE ON network_device_credentials FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'max316-late'");
      const before = await snapshot(db, backup);
      const result = run();
      expect(result.status, result.output).toBe(1);
      expect(result.output).not.toContain('"rotated":true');
      expect(result.output).toContain(mode === 'bad column' ? 'Unknown column' : mode === 'trigger missing table' ? "doesn't exist" : mode === 'trigger denied' ? 'max316-denied' : 'max316-late');
      expect(await snapshot(db, backup)).toBe(before);
    });
  }, 60000);
});
