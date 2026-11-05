import { readFileSync, mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'dotenv';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { dbConnection } from '../db-connection.js';
import { serverDatabaseService } from '../server-database-service.js';
import { networkDeviceDatabaseService } from '../network-devices/network-device-database-service.js';
import { recordSshTrustRequest } from './ssh-trust-audit.js';
import { createCredentialSshHostVerifier, fingerprintSshHostKey } from './ssh-host-key.js';

describe.skipIf(process.env.MAX308_MYSQL !== '1')('MAX-308 disposable schema migration and audit', () => {
  it('preserves old credentials and password behavior; records explicit key compatibility', async () => {
    // Use authorized connection configuration in memory; never log credentials.
    const env = parse(readFileSync(process.env.MAX308_ENV_FILE || '/Users/max/Coding/40-Slide/apps/db-ops-api/.env'));
    const schema = `max308_${randomBytes(6).toString('hex')}`;
    const config = { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER || 'root', password: env.DB_PASSWORD || '', connectionLimit: 2 };
    const admin = mysql.createPool(config);
    let pool: mysql.Pool | undefined;
    let created = false;
    const migrationDirectory = mkdtempSync(join(tmpdir(), 'max308-migrations-'));
    for (const name of readdirSync('sql/migrations').filter(name => name.endsWith('.sql') && !name.startsWith('150_'))) copyFileSync(join('sql/migrations', name), join(migrationDirectory, name));
    try {
      await admin.query(`CREATE DATABASE ${schema}`);
      created = true;
      pool = mysql.createPool({ ...config, database: schema });
      const runner = new MigrationRunner(pool as unknown as MigrationPool);
      await new MigrationRunner(pool as unknown as MigrationPool, migrationDirectory).run();
      const pin = fingerprintSshHostKey(Buffer.from('fixture'));
      await pool.execute("INSERT INTO servers(host,port,os_type,credential_type,credential_encrypted,host_key_fingerprint) VALUES('192.0.2.30',22,'centos','key','unchanged-key',NULL),('192.0.2.31',22,'centos','password','unchanged-password',NULL),('192.0.2.32',22,'centos','key','unchanged-pinned',?)", [pin]);
      await pool.execute("INSERT INTO network_devices(id,name,host,vendor,collection_enabled) VALUES(1,'key fixture','192.0.2.41','huawei',0),(2,'password fixture','192.0.2.42','huawei',0)");
      await pool.execute("INSERT INTO network_device_credentials(device_id,protocol,username,credential_type,credential_encrypted,host_key_fingerprint) VALUES(1,'ssh','fixture','key','network-key',NULL),(2,'ssh','fixture','password','network-password',?)", [pin]);
      await runner.run();
      const [rows] = await pool.query<any[]>('SELECT credential_type,credential_encrypted,host_key_fingerprint,ssh_trust_mode FROM servers ORDER BY host');
      expect(rows.map(row => row.credential_encrypted)).toEqual(['unchanged-key', 'unchanged-password', 'unchanged-pinned']);
      expect(() => createCredentialSshHostVerifier('key', rows[0].host_key_fingerprint, rows[0].ssh_trust_mode)).toThrow('SSH_TRUST_CONFIRMATION_REQUIRED');
      expect(createCredentialSshHostVerifier('password', rows[1].host_key_fingerprint, rows[1].ssh_trust_mode)).toBeUndefined();
      expect(createCredentialSshHostVerifier('key', rows[2].host_key_fingerprint, rows[2].ssh_trust_mode)!(Buffer.from('fixture'))).toBe(true);
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      const [ids] = await pool.query<any[]>("SELECT id FROM servers WHERE host='192.0.2.30'");
      // Confirm one key object without reading or replacing encrypted credentials.
      expect(await serverDatabaseService.updateServer(ids[0].id, { ssh_trust_mode: 'insecure' })).toEqual({ success: true });
      expect(await networkDeviceDatabaseService.updateDevice(1, { sshTrust: { mode: 'insecure' } })).toEqual({ success: true });
      const [network] = await pool.query<any[]>('SELECT credential_type,credential_encrypted,host_key_fingerprint,ssh_trust_mode FROM network_device_credentials ORDER BY device_id');
      expect(network.map(row => row.credential_encrypted)).toEqual(['network-key', 'network-password']);
      expect(network[0].ssh_trust_mode).toBe('insecure');
      expect(network[1].ssh_trust_mode).toBeNull();
      expect(network[1].host_key_fingerprint).toBe(pin);
      const [confirmed] = await pool.query<any[]>('SELECT credential_encrypted,ssh_trust_mode FROM servers WHERE id=?', [ids[0].id]);
      expect(confirmed).toEqual([{ credential_encrypted: 'unchanged-key', ssh_trust_mode: 'insecure' }]);
      await recordSshTrustRequest(123, 'server', 'fixture', 'insecure');
      const [audit] = await pool.query<any[]>('SELECT actor_id,resource_type,resource_id,mode FROM ssh_trust_decisions');
      expect(audit).toEqual([{ actor_id: 123, resource_type: 'server', resource_id: 'fixture', mode: 'insecure' }]);
      expect(JSON.stringify(audit)).not.toContain('unchanged-key');
      vi.restoreAllMocks();
    } finally {
      vi.restoreAllMocks();
      rmSync(migrationDirectory, { recursive: true, force: true });
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${schema}`);
      await admin.end();
    }
  }, 180000);
});
