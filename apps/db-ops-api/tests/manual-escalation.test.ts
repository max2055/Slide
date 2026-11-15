import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const fixture = vi.hoisted(() => ({
  alert: { id: 1, level: 'warning', status: 'unread' },
  connection: { query: vi.fn(), execute: vi.fn(), beginTransaction: vi.fn(),
    commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() },
  getConnection: vi.fn(),
}));
vi.mock('../src/db-connection', () => ({ dbConnection: {
  getPool: () => ({ getConnection: fixture.getConnection }),
} }));
vi.mock('../src/notification-transition.js', () => ({ enqueueNotificationTransition: vi.fn() }));
import { alertEscalationService as service } from '../src/alert-escalation-service.js';
import { enqueueNotificationTransition } from '../src/notification-transition.js';
import { registerAlertEscalationRoute } from '../src/alert-escalation-routes.js';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.alert = { id: 1, level: 'warning', status: 'unread' };
  fixture.getConnection.mockResolvedValue(fixture.connection);
  fixture.connection.execute.mockImplementation(async (sql: string) =>
    sql.includes('FOR UPDATE') ? [[{ ...fixture.alert }]] : [{ affectedRows: 1 }]);
});

describe('MAX-576 manual escalation rejection and side effects', () => {
  it.each(['not-a-level', 'ERROR', ' error ', '', null, {}, 1])('rejects invalid target %j before DB access', async (level) => {
    expect(await service.manualEscalation(1, level as string)).toMatchObject({ success: false, error: 'ESCALATION_LEVEL' });
    expect(fixture.getConnection).not.toHaveBeenCalled();
    expect(enqueueNotificationTransition).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'closed', 'unknown'])('rejects ineligible status %s without writes', async (status) => {
    fixture.alert.status = status;
    expect(await service.manualEscalation(1, 'error')).toMatchObject({ success: false, error: 'ESCALATION_STATUS' });
    expect(fixture.connection.execute).toHaveBeenCalledTimes(1);
    expect(enqueueNotificationTransition).not.toHaveBeenCalled();
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
  });

  it.each(['warning', 'info'])('rejects equal or lower severity %s without writes', async (level) => {
    expect(await service.manualEscalation(1, level)).toMatchObject({ success: false, error: 'ESCALATION_DIRECTION' });
    expect(fixture.connection.execute).toHaveBeenCalledTimes(1);
    expect(enqueueNotificationTransition).not.toHaveBeenCalled();
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
  });

  it.each(['unread', 'read', 'acknowledged'])('allows upward escalation for %s exactly once', async (status) => {
    fixture.alert.status = status;
    expect(await service.manualEscalation(1, 'critical')).toEqual({ success: true, changed: true });
    expect(fixture.connection.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(1);
    expect(fixture.connection.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(1);
    expect(enqueueNotificationTransition).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it('keeps automatic stale candidates as a no-op', async () => {
    fixture.alert.status = 'closed';
    expect(await (service as any).transition(1, 'error', undefined, 'warning', 1)).toEqual({ changed: false });
    expect(fixture.connection.execute).toHaveBeenCalledTimes(1);
    expect(enqueueNotificationTransition).not.toHaveBeenCalled();
  });
});

describe('MAX-576 production HTTP route', () => {
  it('rejects invalid bodies at entry and reports service conflicts as 409', async () => {
    const app = Fastify();
    await registerAlertEscalationRoute(app, async () => {});
    try {
      for (const new_level of ['not-a-level', 'ERROR', '', null, 1, {}]) {
        const result = await app.inject({ method: 'POST', url: '/api/alerts/1/escalate', payload: { new_level } });
        expect(result.statusCode).toBe(400);
      }
      expect(fixture.getConnection).not.toHaveBeenCalled();
      for (const status of ['resolved', 'closed']) {
        fixture.alert.status = status;
        const result = await app.inject({ method: 'POST', url: '/api/alerts/1/escalate', payload: { new_level: 'error' } });
        expect(result.statusCode).toBe(409);
        expect(result.json()).toEqual({ error: 'ESCALATION_STATUS' });
      }
      fixture.alert.status = 'unread';
      const same = await app.inject({ method: 'POST', url: '/api/alerts/1/escalate', payload: { new_level: 'warning' } });
      expect(same.statusCode).toBe(409);
      expect(same.json()).toEqual({ error: 'ESCALATION_DIRECTION' });
      expect(enqueueNotificationTransition).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
