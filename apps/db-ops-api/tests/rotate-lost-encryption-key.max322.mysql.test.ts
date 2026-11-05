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
const envFile = process.env.MAX322_TEST_ENV_FILE;

// Opt in explicitly. Read credentials only from the authorized local file;
// create and drop only this test's randomly named databases, never DB_NAME.
describe.skipIf(!envFile)('MAX-322 real MySQL CLI recovery / GitHub #694', () => {
  async function fixture(backup: boolean, check: (db: mysql.Connection, run: (credentials?: { user: string; password: string }) => { status: number | null; output: string; audit: string }) => Promise<void>) {
    const config = parse(readFileSync(envFile!, 'utf8'));
    if (!config.DB_HOST || !config.DB_PORT || !config.DB_USER) throw new Error('Explicit MySQL endpoint required');
    const connection = { host: config.DB_HOST, port: Number(config.DB_PORT), user: config.DB_USER, password: config.DB_PASSWORD ?? '' };
    const name = `max322_${randomBytes(8).toString('hex')}`;
    const directory = mkdtempSync(join(tmpdir(), 'max322-'));
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
      await db.query("INSERT INTO users (id,username,password_hash) VALUES (316,'max322-fixture','synthetic-hash')");
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

  it.each([false, true])('audits distinct channel content without secrets; rollback=%s', async (rollback) => {
    await fixture(false, async (db, run) => {
      const configs = [
        { token: 'max322-token-one', nested: { z: 1, a: ['x', { b: true, a: null }] } },
        { token: 'max322-token-two', nested: { z: 1, a: ['x', { b: true, a: null }] } },
        { nested: { a: ['x', { a: null, b: true }], z: 1 }, token: 'max322-token-one' },
      ];
      await db.query('DELETE FROM notification_channels');
      for (const [index, config] of configs.entries()) {
        await db.execute("INSERT INTO notification_channels (name,type,config,delivery_start_at) VALUES (?,'webhook',?,NOW())", [`channel-${index}`, JSON.stringify(config)]);
      }
      const [beforeChannels] = await db.query<RowDataPacket[]>('SELECT id, config, enabled FROM notification_channels ORDER BY id');
      expect(typeof beforeChannels[0].config).toBe('object');
      const [beforeInstances] = await db.query('SELECT password_encrypted,status FROM database_instances');
      if (rollback) await db.query("CREATE TRIGGER max322_late BEFORE UPDATE ON network_device_credentials FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'max322-late'");
      const result = run();
      expect(result.status).toBe(rollback ? 1 : 0);
      expect(statSync(result.audit).mode & 0o777).toBe(0o600);
      const text = readFileSync(result.audit, 'utf8');
      const audit = JSON.parse(text);
      const entries = audit.entries.channels;
      expect(entries).toHaveLength(3);
      const expectedOne = createHash('sha256').update('{"nested":{"a":["x",{"a":null,"b":true}],"z":1},"token":"max322-token-one"}').digest('hex');
      expect(entries[0].configFingerprint).toBe(expectedOne);
      expect(entries[0].configFingerprint).not.toBe(entries[1].configFingerprint);
      expect(entries[0].configFingerprint).toBe(entries[2].configFingerprint);
      for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(['configFingerprint', 'enabled', 'id']);
      for (const secret of ['max322-token-one', 'max322-token-two', 'instance-cipher', 'server-cipher', 'provider-cipher', 'credential-cipher', 'reference-cipher']) {
        expect(text.includes(secret)).toBe(false);
        expect(result.output.includes(secret)).toBe(false);
      }
      const [afterChannels] = await db.query<RowDataPacket[]>('SELECT id, config, enabled FROM notification_channels ORDER BY id');
      const [afterInstances] = await db.query('SELECT password_encrypted,status FROM database_instances');
      if (rollback) {
        expect(afterChannels).toEqual(beforeChannels);
        expect(afterInstances).toEqual(beforeInstances);
        expect(result.output).toContain('max322-late');
      } else {
        expect(afterChannels.map(row => row.enabled)).toEqual([0, 0, 0]);
        expect(afterChannels.every(row => !('token' in row.config))).toBe(true);
        expect(audit.entries.instances[0].ciphertextFingerprint).toBe(createHash('sha256').update('instance-cipher').digest('hex'));
      }
      console.log(JSON.stringify({ max322: rollback ? 'rollback' : 'commit', channels: 3, fingerprintsDistinct: true, sameContentStable: true, noSecrets: true, auditMode: '0600', auditSha256: createHash('sha256').update(text).digest('hex') }));
    });
  }, 60000);
});
