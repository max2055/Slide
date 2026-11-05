import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { DeviceAuthService } from './device-auth-service.js';
import { registerDeviceAuthRoutes } from './device-auth-routes.js';

const key = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');

// Real HTTP route/service and InnoDB schema. JWT identity is an explicit fixture,
// not evidence of the full login/permission revalidation chain.
describe.skipIf(!process.env.DEVICE_AUTH_TEST_MYSQL_URL)('MAX-269 real HTTP + MySQL registration', () => {
  it('preserves revoked records and serializes registration against revocation', async () => {
    const url = new URL(process.env.DEVICE_AUTH_TEST_MYSQL_URL!);
    const admin = mysql.createPool(url.toString());
    const schema = `max269_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${schema}`);
    url.pathname = `/${schema}`;
    const pool = mysql.createPool(url.toString());
    const app = Fastify();
    const actor = { userId: 7 } as any;
    const deviceId = 'b'.repeat(64);
    const publicKey = key();
    const replacement = key();
    try {
      await pool.execute('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
      await pool.execute('INSERT INTO users VALUES (7)');
      await pool.query(readFileSync(new URL('../../sql/migrations/067_device_registrations.sql', import.meta.url), 'utf8'));
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
      await registerDeviceAuthRoutes(app, async request => { request.user = actor; });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address() as { port: number };
      const register = async (publicKey: string) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/device/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, publicKey }),
        });
        return { status: response.status, body: await response.json() };
      };
      const row = async () => (await pool.query<any[]>('SELECT * FROM device_registrations'))[0][0];
      expect(await register(publicKey)).toEqual({ status: 200, body: { deviceId, status: 'paired' } });
      expect(await register(publicKey)).toEqual({ status: 200, body: { deviceId, status: 'paired' } });
      expect(await register(replacement)).toEqual({ status: 200, body: { deviceId, status: 'paired' } });
      expect((await row()).public_key).toBe(replacement);
      await pool.execute("UPDATE device_registrations SET status='revoked', challenge_hash=REPEAT('c',64), challenge_expires_at=DATE_ADD(NOW(), INTERVAL 60 SECOND), updated_at='2020-01-01'");
      const revoked = await row();
      for (const candidate of [replacement, publicKey]) {
        expect(await register(candidate)).toEqual({ status: 403, body: { reasonCode: 'DEVICE_AUTH_REVOKED' } });
        expect(await row()).toEqual(revoked);
      }
      console.log('HTTP first/repeat/key rotation 200; revoked same/new key 403; entire revoked row unchanged');

      // Revoker owns the InnoDB row lock before registration reaches its write.
      await pool.execute("UPDATE device_registrations SET status='paired', public_key=?", [publicKey]);
      const lock = await pool.getConnection();
      try {
        await lock.beginTransaction();
        await lock.query('SELECT id FROM device_registrations FOR UPDATE');
        await lock.execute("UPDATE device_registrations SET status='revoked'");
        let entered!: () => void;
        const entering = new Promise<void>(resolve => { entered = resolve; });
        const service = new DeviceAuthService(() => ({ execute: async (sql, values) => {
          if (sql.startsWith('INSERT')) entered();
          return pool.execute(sql, values as any) as any;
        } }));
        const outcome = service.register(actor, deviceId, replacement).then(() => 'accepted', error => error.message);
        await entering;
        await lock.commit();
        expect(await outcome).toBe('DEVICE_AUTH_REVOKED');
        expect((await row()).status).toBe('revoked');
        expect((await row()).public_key).toBe(publicKey);
      } finally { await lock.rollback(); lock.release(); }

      // Registration writes first; a later revocation must survive its readback.
      await pool.execute("UPDATE device_registrations SET status='paired'");
      const service = new DeviceAuthService(() => ({ execute: async (sql, values) => {
        const result = await pool.execute(sql, values as any);
        if (sql.startsWith('INSERT')) await pool.execute("UPDATE device_registrations SET status='revoked'");
        return result as any;
      } }));
      await expect(service.register(actor, deviceId, replacement)).rejects.toThrow('DEVICE_AUTH_REVOKED');
      expect((await row()).status).toBe('revoked');
      expect((await row()).public_key).toBe(replacement);
      console.log('Both registration/revocation orderings preserve revocation; no read-before-write restoration');
    } finally {
      await app.close();
      vi.restoreAllMocks();
      await pool.end();
      await admin.query(`DROP DATABASE ${schema}`);
      await admin.end();
    }
  }, 30000);
});
