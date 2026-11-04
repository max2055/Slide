import { randomUUID } from 'node:crypto';
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
      for (const name of ['admin', 'user', 'operator']) expect(await auth.verifyPassword(name, 'Tpam1234')).toBe(false);
      expect(await bcrypt.compare('synthetic-bootstrap-password', fresh[0].password_hash)).toBe(true);
      expect(await bcrypt.compare('Tpam1234', fresh[0].password_hash)).toBe(false);
      const [roles] = await pool.query<any[]>("SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE u.username='operator'");
      expect(roles.map(row => row.name)).toContain('admin');
      const before = await runner.inspect();
      await runner.run();
      expect(await runner.inspect()).toEqual(before);
      expect((await pool.query<any[]>('SELECT password_hash FROM users'))[0][0].password_hash).toBe(fresh[0].password_hash);
      // Simulate deployed seed accounts, including a default migrated to bcrypt.
      const changed = await bcrypt.hash('changed-real-account-password', 12);
      const migratedDefault = await bcrypt.hash('Tpam1234', 12);
      await pool.query("INSERT INTO users(username,password_hash) VALUES ('admin',?),('user',?),('retained',?)", [migratedDefault, changed, changed]);
      await runner.run();
      const [upgraded] = await pool.query<any[]>('SELECT username,password_hash,status FROM users ORDER BY username');
      expect(upgraded.find(row => row.username === 'admin').status).toBe('inactive');
      expect(await auth.verifyPassword('admin', 'Tpam1234')).toBe(false);
      expect(await auth.verifyPassword('user', 'changed-real-account-password')).toBe(true);
      expect(upgraded.find(row => row.username === 'user')).toMatchObject({ status: 'active', password_hash: changed });
      expect(upgraded.find(row => row.username === 'retained')).toMatchObject({ status: 'active', password_hash: changed });
      expect(await runner.inspect()).toEqual(before);
      await runner.run();
      expect((await pool.query<any[]>('SELECT username,password_hash,status FROM users ORDER BY username'))[0]).toEqual(upgraded);
      // Configured identity collisions fail closed without elevating an existing viewer.
      vi.stubEnv('INITIAL_ADMIN_USERNAME', 'retained');
      await expect(runner.run()).rejects.toThrow('conflicts');
      expect((await pool.query<any[]>("SELECT COUNT(*) n FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.username='retained'"))[0][0].n).toBe(0);
      production();
      // Recreate a complete historical development install, then upgrade under production.
      await pool.query('DELETE FROM user_roles');
      await pool.query('DELETE FROM users');
      vi.stubEnv('NODE_ENV', 'development');
      const legacyHash = '4f32fc2ba7f8dfa43328d1ee7e5eb7607c78ab2e73c5cd001979aeaf5532c817';
      await pool.query("INSERT INTO users(username,password_hash) VALUES ('admin',?),('user',?)", [legacyHash, legacyHash]);
      production();
      await runner.run();
      expect((await pool.query<any[]>("SELECT status FROM users WHERE username IN ('admin','user')"))[0].map(row => row.status)).toEqual(['inactive', 'inactive']);
      expect(await runner.inspect()).toEqual(before);
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
      const before = await runner.inspect();
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('JWT_SECRET_KEY', 'j'.repeat(32));
      vi.stubEnv('ENCRYPTION_KEY', 'e'.repeat(32));
      vi.stubEnv('INITIAL_ADMIN_USERNAME', 'operator');
      vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'synthetic-bootstrap-password');
      await runner.run();
      const [rows] = await pool.query<any[]>('SELECT username,status FROM users ORDER BY username');
      expect(rows).toEqual([{username:'admin',status:'inactive'}, {username:'operator',status:'active'}, {username:'user',status:'inactive'}]);
      expect(await runner.inspect()).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
      await pool.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  }, 300_000);

});
