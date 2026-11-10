import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection.js';

const enabled = process.env.MAX364_DB_INIT_MYSQL === '1';
const profilePath = '/Users/max/.config/slide-test-access/connection-profiles.json';

interface MysqlTestProfile {
  host: string;
  port: number;
  user: string;
  password: string;
}

describe.skipIf(!enabled)('MAX-364 real mysql2 initialization on the 3308 test instance', () => {
  const database = `max364_db_init_${Date.now()}`;
  let profile: MysqlTestProfile | null = null;
  let admin: mysql.Pool | null = null;
  const codes: string[] = [];

  afterAll(async () => {
    await dbConnection.close().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  });

  it('recovers from a failed configuration, reuses the successful pool, and closes it', async () => {
    const parsed = JSON.parse(await readFile(profilePath, 'utf8')) as { 'mysql-test'?: MysqlTestProfile };
    profile = parsed['mysql-test'] ?? null;
    expect(profile).toBeTruthy();
    if (!profile) return;
    expect(profile.host).toBe('127.0.0.1');
    expect(Number(profile.port)).toBe(3308);
    expect(profile.user).toBe('root');
    expect(profile.password.length).toBeGreaterThan(0);

    const secret = profile.password;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const error = args.find((item) => item && typeof item === 'object' && 'code' in (item as object)) as { code?: string } | undefined;
      if (error?.code) codes.push(error.code);
      const text = args.map((item) => {
        if (typeof item === 'string') return item;
        if (item instanceof Error) return `${item.name}:${item.message}`;
        return '';
      }).join(' ');
      const passwordAssignment = text.includes(`password=${secret}`)
        || text.includes(`"password":"${secret}"`)
        || text.includes(`password: '${secret}'`);
      const distinctSecret = secret !== profile?.user && text.includes(secret);
      if (passwordAssignment || distinctSecret) throw new Error('credential leaked to console output');
    });

    admin = mysql.createPool({
      host: profile.host,
      port: Number(profile.port),
      user: profile.user,
      password: profile.password,
      connectionLimit: 2,
      connectTimeout: 3_000,
    });
    const [beforeRows] = await admin.query<mysql.RowDataPacket[]>('SHOW DATABASES');
    const before = new Set(beforeRows.map((row) => String(row.Database)));
    expect(before.has(database)).toBe(false);
    await admin.query(`CREATE DATABASE \`${database}\``);

    const bad = {
      host: profile.host,
      port: Number(profile.port),
      user: profile.user,
      password: 'max364-invalid',
      database,
    };
    const good = { ...bad, password: profile.password };

    expect(await dbConnection.initialize(bad)).toBe(false);
    expect(dbConnection.getPool()).toBeNull();
    expect(dbConnection.isConnected()).toBe(false);

    expect(await dbConnection.initialize({ ...good, database: `${database}_missing` })).toBe(false);
    expect(dbConnection.getPool()).toBeNull();

    expect(await dbConnection.initialize(good)).toBe(true);
    const pool = dbConnection.getPool();
    expect(pool).toBeTruthy();
    const rows = await dbConnection.query<Array<{ current_database: string; ok: number }>>(
      'SELECT DATABASE() AS current_database, ? AS ok',
      [1],
    );
    expect(rows).toEqual([{ current_database: database, ok: 1 }]);

    expect(await dbConnection.initialize(good)).toBe(true);
    expect(dbConnection.getPool()).toBe(pool);

    await dbConnection.close();
    expect(dbConnection.getPool()).toBeNull();
    expect(dbConnection.isConnected()).toBe(false);
    expect(await dbConnection.initialize(good)).toBe(true);
    expect(dbConnection.getPool()).not.toBe(pool);
    await dbConnection.close();

    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    const [afterRows] = await admin.query<mysql.RowDataPacket[]>('SHOW DATABASES');
    const after = afterRows.map((row) => String(row.Database)).sort();
    expect(after).toEqual([...before].sort());
    expect(codes).toEqual(expect.arrayContaining(['ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR']));
    expect(codes.some((code) => code.includes(secret))).toBe(false);
  });
});
