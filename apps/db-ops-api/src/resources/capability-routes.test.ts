import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { registerNetworkDeviceRoutes } from '../network-devices/network-device-routes.js';
import { registerCapabilityRoutes } from '../../tests/fixtures/capability-routes.js';
import type { ActorContext } from '../auth/actor-context.js';

const actor: ActorContext = { userId: 1, username: 'fixture', roles: [], permissions: ['*'], sessionVersion: 1, instanceScopes: {}, requestId: 'fixture' };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
async function setup(current = actor) {
  const app = Fastify(); apps.push(app);
  const verify = async (request: any) => { request.user = current; };
  const row = { resource_type: 'network_device', resource_id: 7, capability_key: 'metrics.core', state: 'verified', evidence: '{"probe":"collector"}', reason: null, checked_at: new Date(0), valid_until: new Date(1) };
  const execute = vi.fn(async () => [[row], []]);
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  await registerNetworkDeviceRoutes(app, verify); registerCapabilityRoutes(app, verify);
  return { app, execute };
}
describe('GitHub #549/#550 production capability HTTP registrations', () => {
  it('reproduces the expired list/detail mismatch and keeps SQL read-only', async () => {
    const { app, execute } = await setup();
    const list = await app.inject('/api/network-devices/7/capabilities');
    const key = await app.inject('/api/network-devices/7/capabilities?key=metrics.core');
    const generic = await app.inject('/api/resources/network_device/7/capabilities/metrics.core');
    expect(list.statusCode).toBe(200); expect(key.statusCode).toBe(200); expect(generic.statusCode).toBe(200);
    expect(list.json()).toEqual(key.json());
    expect(list.json().capabilities[0]).toMatchObject({ state: 'configured', reason: 'capability_verification_expired' });
    expect(generic.json().capability).toMatchObject({ state: 'configured', reason: 'capability_verification_expired' });
    expect(execute.mock.calls.every(([sql]: any) => sql.trim().startsWith('SELECT'))).toBe(true);
  });
  it.each(['checkedAt', 'validUntil'])('rejects malformed %s with HTTP400 before SQL', async field => {
    const { app, execute } = await setup();
    const response = await app.inject({ method: 'PUT', url: '/api/resources/network_device/7/capabilities/metrics.core', payload: { state: 'configured', checkedAt: '2026-11-13T00:00:00Z', [field]: 'abc' } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toBe('CAPABILITY_TIME_INVALID');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects ungranted access on list, key and update before SQL', async () => {
    const { app, execute } = await setup({ ...actor, permissions: [] });
    for (const url of ['/api/network-devices/7/capabilities', '/api/network-devices/7/capabilities?key=metrics.core']) {
      expect((await app.inject(url)).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/resources/network_device/7/capabilities/metrics.core', payload: { state: 'configured' } })).statusCode).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });
});
