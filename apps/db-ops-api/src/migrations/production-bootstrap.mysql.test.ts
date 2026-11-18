import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { describe, it, expect, vi } from 'vitest';
import { MigrationRunner } from './runner.js';
import { AuthDatabaseService } from '../auth-database-service.js';

const port = Number(process.env.BOOTSTRAP_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('MAX-267 production bootstrap on real MySQL', () => {
  it('isolates seeds, preserves ledger and changed accounts through upgrade and restart', async () => {
    const admin = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.BOOTSTRAP_TEST_MYSQL_PASSWORD ?? '' });
    const database = `max267_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.BOOTSTRAP_TEST_MYSQL_PASSWORD ?? '', database });
    const runner = new MigrationRunner(pool);
    const production = () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('JWT_SECRET_KEY', 'j'.repeat(32));
      vi.stubEnv('ENCRYPTION_KEY', 'e'.repeat(32));
      vi.stubEnv('INITIAL_ADMIN_USERNAME', 'operator');
      vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'synthetic-bootstrap-password');
    };
    try {
      production();
      await runner.run();
      const [fresh] = await pool.query<any[]>('SELECT username,password_hash,status FROM users');
      expect(fresh.map(row => row.username)).toEqual(['operator']);
      const auth = new AuthDatabaseService(() => pool);
      expect(await auth.verifyPassword('operator', 'synthetic-bootstrap-password')).toBe(true);
      for (const name of ['admin', 'user', 'operator']) expect(await auth.verifyPassword(name, 'SlideQa42')).toBe(false);
      expect(await bcrypt.compare('synthetic-bootstrap-password', fresh[0].password_hash)).toBe(true);
      expect(await bcrypt.compare('SlideQa42', fresh[0].password_hash)).toBe(false);
      const [roles] = await pool.query<any[]>("SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE u.username='operator'");
      expect(roles.map(row => row.name)).toContain('admin');
      const before = await runner.inspect();
      await runner.run();
      expect(await runner.inspect()).toEqual(before);
      expect((await pool.query<any[]>('SELECT password_hash FROM users'))[0][0].password_hash).toBe(fresh[0].password_hash);
      const existingPassword = 'SlideQa42';
      const shaHash = createHash('sha256').update(existingPassword).digest('hex');
      const bcryptHash = await bcrypt.hash(existingPassword, 10);
      await pool.query("INSERT INTO users(username,password_hash,status,session_version) VALUES ('admin',?,'active',4),('user',?,'active',7),('retained',?,'inactive',9)", [shaHash, bcryptHash, bcryptHash]);
      await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name=CASE u.username WHEN 'admin' THEN 'admin' ELSE 'viewer' END WHERE u.username IN ('admin','user','retained')");
      const readAccounts = async () => (await pool.query<mysql.RowDataPacket[]>(
        "SELECT u.id,u.username,u.status,u.session_version,u.password_hash,r.name AS role FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id ORDER BY u.id,r.name",
      ))[0];
      const accounts = await readAccounts();
      await runner.run();
      expect(await readAccounts()).toEqual(accounts);
      expect(await runner.inspect()).toEqual(before);
      await runner.run();
      expect(await readAccounts()).toEqual(accounts);
      // Configured identity collisions fail closed without elevating an existing viewer.
      vi.stubEnv('INITIAL_ADMIN_USERNAME', 'user');
      await expect(runner.run()).rejects.toThrow('conflicts');
      expect(await readAccounts()).toEqual(accounts);
      production();
      expect(await auth.verifyPassword('user', existingPassword)).toBe(true);
      expect(await auth.verifyPassword('retained', existingPassword)).toBe(false);
      expect(await readAccounts()).toEqual(accounts);
      expect(await auth.verifyPassword('admin', existingPassword)).toBe(true);
      await expect.poll(async () => (await readAccounts()).find(row => row.username === 'admin')?.password_hash).toMatch(/^\$2/);
      const upgraded = await readAccounts();
      const adminHash = upgraded.find(row => row.username === 'admin')?.password_hash;
      expect(await bcrypt.compare(existingPassword, adminHash)).toBe(true);
      expect(upgraded.map(row => row.username === 'admin' ? { ...row, password_hash: shaHash } : row)).toEqual(accounts);
      // Reinitializing an empty user table uses an independent salt.

      await pool.query('DELETE FROM user_roles');
      await pool.query('DELETE FROM users');
      await runner.run();
      const [second] = await pool.query<any[]>('SELECT password_hash FROM users');
      expect(second[0].password_hash).not.toBe(fresh[0].password_hash);
    } finally {
      vi.unstubAllEnvs();
      await pool.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  }, 300_000);
  it('upgrades an actual development baseline without changing its ledger', async () => {
    const config = { host: '127.0.0.1', port, user: 'root', password: process.env.BOOTSTRAP_TEST_MYSQL_PASSWORD ?? '' };
    const admin = mysql.createPool(config);
    const database = `max267_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const pool = mysql.createPool({ ...config, database });
    try {
      vi.stubEnv('NODE_ENV', 'development');
      const runner = new MigrationRunner(pool);
      await runner.run();
      expect((await pool.query<any[]>('SELECT username FROM users ORDER BY username'))[0].map(row => row.username)).toEqual(['admin', 'user']);
      const currentChecksum = '9f6952edd85f9cff7cd14571a5e70d79acb714ea0f2bd55771b4d52e76a0389a';
      const oldChecksum = '729ec2cce91657443417503a6cf0a1852cb6002885fc6f9f9af5755560cdc2b9';
      expect((await runner.inspect()).find(row => row.migration_id === '000_schema_baseline.sql')?.checksum).toBe(currentChecksum);
      await pool.query("UPDATE app_schema_migrations SET checksum=? WHERE migration_id='000_schema_baseline.sql'", [oldChecksum]);
      const before = await runner.inspect();
      const seedState = async () => (await pool.query<mysql.RowDataPacket[]>(
        'SELECT u.id,u.status,u.session_version FROM users u JOIN development_account_seeds seed ON seed.user_id=u.id ORDER BY u.id',
      ))[0];
      const beforeSeeds = await seedState();
      expect(beforeSeeds).toHaveLength(2);
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('JWT_SECRET_KEY', 'j'.repeat(32));
      vi.stubEnv('ENCRYPTION_KEY', 'e'.repeat(32));
      vi.stubEnv('INITIAL_ADMIN_USERNAME', 'operator');
      vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'synthetic-bootstrap-password');
      await runner.run();
      const [rows] = await pool.query<any[]>('SELECT username,status FROM users ORDER BY username');
      expect(rows).toEqual([{username:'admin',status:'inactive'}, {username:'operator',status:'active'}, {username:'user',status:'inactive'}]);
      const afterSeeds = beforeSeeds.map(row => ({ ...row, status: 'inactive', session_version: Number(row.session_version) + 1 }));
      expect(await seedState()).toEqual(afterSeeds);
      await runner.run();
      expect(await seedState()).toEqual(afterSeeds);
      expect(await runner.inspect()).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
      await pool.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  }, 300_000);

});
