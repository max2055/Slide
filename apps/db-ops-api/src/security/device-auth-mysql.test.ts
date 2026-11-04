import Fastify from 'fastify';
import { registerDeviceAuthRoutes } from './device-auth-routes.js';
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '@slide/agent-core';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { DeviceAuthService, deviceSigningPayload } from './device-auth-service.js';
import { DirectAdapter } from '../adapter/direct-adapter.js';
import { dbConnection } from '../db-connection.js';
import { vi } from 'vitest';
import { WebSocket } from 'ws';

// Opt-in real InnoDB qualification; CI's regular unit suite needs no database.
describe.skipIf(!process.env.DEVICE_AUTH_TEST_MYSQL_URL)('MAX-268 real MySQL + Ed25519', () => {
  it('atomically consumes proofs and rejects stale snapshots, replay and faults through WS ingress', async () => {
    const url = new URL(process.env.DEVICE_AUTH_TEST_MYSQL_URL!);
    url.searchParams.set('timezone', 'Z');
    const admin = mysql.createPool(url.toString());
    const schema = `max268_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${schema}`);
    url.pathname = `/${schema}`;
    const pool = mysql.createPool(url.toString());
    const workspace = mkdtempSync(join(tmpdir(), 'max268-'));
    const app = Fastify();
    let adapter: DirectAdapter | undefined;
    const clients: WebSocket[] = [];
    try {
      await pool.execute('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
      await pool.execute('INSERT INTO users VALUES (7)');
      await pool.query(readFileSync(new URL('../../sql/migrations/067_device_registrations.sql', import.meta.url), 'utf8'));
      const actor = { userId: 7 } as any;
      const keys = generateKeyPairSync('ed25519');
      const params = { deviceId: 'a'.repeat(64), publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), timestamp: Date.now(), nonce: 'nonce', method: 'GET', path: '/ws/auth', body: '', signature: '' };
      params.signature = sign(null, Buffer.from(deviceSigningPayload(params)), keys.privateKey).toString('base64url');
      const hash = createHash('sha256').update(params.nonce).digest('hex');
      const service = new DeviceAuthService(() => pool as any);
      await service.register(actor, params.deviceId, params.publicKey);
      const reset = () => pool.execute("UPDATE device_registrations SET status='paired', public_key=?, challenge_hash=?, challenge_expires_at=DATE_ADD(NOW(), INTERVAL 60 SECOND)", [params.publicKey, hash]);
      await reset();
      // Barrier forces all readers to observe the same still-valid snapshot.
      let reads = 0;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const racing = new DeviceAuthService(() => ({ execute: async (sql, values) => {
        const result = await pool.execute(sql, values as any);
        if (sql.startsWith('SELECT')) { if (++reads === 8) release(); await barrier; }
        return result as any;
      } }));
      const results = await Promise.all(Array.from({ length: 8 }, () => racing.verify(actor, params)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await service.verify(actor, params)).toBe(false);
      console.log('real MySQL barrier concurrency:', results, '; replay rejected');
      for (const mutation of ["status='revoked'", "public_key=LOWER(public_key)", "challenge_expires_at=DATE_SUB(NOW(), INTERVAL 1 SECOND)", "challenge_hash=REPEAT('b',64)"]) {
        await reset();
        const stale = new DeviceAuthService(() => ({ execute: async (sql, values) => {
          const result = await pool.execute(sql, values as any);
          if (sql.startsWith('SELECT')) await pool.query(`UPDATE device_registrations SET ${mutation}`);
          return result as any;
        } }));
        expect(await stale.verify(actor, params)).toBe(false);
        console.log('stale snapshot rejected:', mutation);
      }
      await reset();
      expect(await service.verify(actor, { ...params, signature: Buffer.alloc(64).toString('base64url') })).toBe(false);
      // Actual WebSocket transport and actual DeviceAuthService/SQL; token actor
      // lookup is isolated to avoid unrelated platform schema and LLM calls.
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
      await registerDeviceAuthRoutes(app, async request => { request.user = actor; });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const httpPort = (app.server.address() as { port: number }).port;
      const post = async (route: string, body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${httpPort}/api/device/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as any };
      };
      const challenge = await post('challenge', { deviceId: params.deviceId });
      expect(challenge.status).toBe(200);
      const httpProof = { ...params, nonce: challenge.body.nonce, timestamp: Date.now() };
      httpProof.signature = sign(null, Buffer.from(deviceSigningPayload(httpProof)), keys.privateKey).toString('base64url');
      expect((await post('session', { ...httpProof, signature: 'invalid' })).status).toBe(401);
      expect((await post('session', httpProof)).status).toBe(200);
      expect((await post('session', httpProof)).status).toBe(401);
      console.log('real HTTP/MySQL: challenge 200, bad signature 401, valid proof 200, replay 401 (identity fixture)');
      await reset();
      vi.stubEnv('AGENT_WS_PORT', '0');
      vi.stubEnv('JWT_SECRET_KEY', 'max268-isolated-test-secret');
      adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: {} as any, actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async a => a } });
      await adapter.start();
      const server = (adapter as any).wsServer;
      if (!server.address()) await new Promise<void>(resolve => server.once('listening', resolve));
      async function auth() {
        const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
        clients.push(ws);
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WS timeout')), 5000);
          ws.on('error', reject);
          ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'isolated', deviceAuth: params })));
          ws.on('message', data => { if (JSON.parse(data.toString()).type === 'auth_ok') { clearTimeout(timer); resolve('auth_ok'); } });
          ws.on('close', code => { clearTimeout(timer); resolve(String(code)); });
        });
      }
      const wsResults = await Promise.all([auth(), auth()]);
      expect(wsResults.sort()).toEqual(['4001', 'auth_ok']);
      expect(await auth()).toBe('4001');
      await pool.end();
      expect(await auth()).toBe('1013');
      for (const route of ['register', 'challenge', 'session']) {
        const failure = await post(route, params);
        expect(failure.status).toBe(503);
        expect(failure.body.error).toBe('PLATFORM_UNAVAILABLE');
      }
      console.log('real HTTP: closed MySQL pool returns fixed 503 for all three endpoints');
      console.log('real WS: one auth_ok, duplicate/replay 4001, storage offline 1013');
    } finally {
      await app.close();
      for (const client of clients) client.terminate();
      await adapter?.dispose();
      rmSync(workspace, { recursive: true, force: true });
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await pool.end().catch(() => {});
      await admin.query(`DROP DATABASE ${schema}`);
      await admin.end();
    }
  }, 30000);
});
