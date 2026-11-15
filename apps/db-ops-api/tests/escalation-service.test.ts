import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

vi.mock('../src/notification-transition.js', () => ({ enqueueNotificationTransition: vi.fn() }));

const mockPool = {
  execute: vi.fn().mockResolvedValue([[]]),
  getConnection: vi.fn(),
  query: vi.fn().mockResolvedValue([[{ started_at: new Date() }]]),
};

describe('alert-escalation-service.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPool.execute.mockReset();
  });

  it('start() creates a CronJob and sets running flag', async () => {
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    alertEscalationService.start();
    const status = alertEscalationService.getStatus();
    expect(status.running).toBe(true);
    alertEscalationService.stop();
  });

  it('stop() sets running flag to false', async () => {
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    alertEscalationService.start();
    alertEscalationService.stop();
    const status = alertEscalationService.getStatus();
    expect(status.running).toBe(false);
  });

  it('checkEscalations returns 0 when no rules', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const result = await alertEscalationService.checkEscalations();
    expect(result.escalated).toBe(0);
  });

  it('manualEscalation returns error when alert not found', async () => {
    const connection = { query: vi.fn().mockResolvedValue([[]]), execute: vi.fn().mockResolvedValue([[]]),
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() };
    mockPool.getConnection.mockResolvedValue(connection);
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const result = await alertEscalationService.manualEscalation(999, 'critical');
    expect(result.success).toBe(false);
    expect(result.error).toBe('ESCALATION_NOT_FOUND');
    expect(connection.execute).toHaveBeenCalledWith('SELECT * FROM alerts WHERE id=? FOR UPDATE', [999]);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('getEscalationRules returns empty when no rules in DB', async () => {
    mockPool.execute.mockResolvedValueOnce([[]]);
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const rules = await alertEscalationService.getEscalationRules();
    expect(Array.isArray(rules)).toBe(true);
  });

  it('deleteEscalationRule executes DELETE SQL', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ affectedRows: 1 }], []]);
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const result = await alertEscalationService.deleteEscalationRule(1);
    expect(result.success).toBe(true);
  });
  it('MAX-574 rejects unsupported conditions on create and update without SQL', async () => {
    const { alertEscalationService: service } = await import('../src/alert-escalation-service');
    expect((await service.createEscalationRule({ name: 'bad', from_level: 'warning',
      to_level: 'error', trigger_condition: 'unsupported_fixture', trigger_value: 30 })).success).toBe(false);
    expect((await service.updateEscalationRule(1, { trigger_condition: 'other' })).success).toBe(false);
    expect(mockPool.execute).not.toHaveBeenCalled();
  });

  it('MAX-574 skips historical unsupported rules', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ id: 1, enabled: 1,
      trigger_condition: 'unsupported_fixture', trigger_value: 30 }]]);
    const { alertEscalationService: service } = await import('../src/alert-escalation-service');
    expect(await service.checkEscalations()).toEqual({ escalated: 0 });
    expect(mockPool.execute).toHaveBeenCalledTimes(1);
  });

  it('MAX-564 only upgrades once per scan despite ordered rules and an old alert', async () => {
    const rules = ['warning', 'error', 'critical'].map((level, i) => ({
      id: i + 1, from_level: level, to_level: ['error', 'critical', 'p0'][i],
      trigger_condition: 'timeout_minutes', trigger_value: 30, enabled: 1,
    }));
    mockPool.execute.mockImplementation(async (sql: string) =>
      [sql.includes('escalation_rules') ? rules : [{ id: 1, level: 'warning' }]]);
    const { alertEscalationService: service } = await import('../src/alert-escalation-service');
    const transition = vi.spyOn(service as any, 'transition').mockResolvedValue({ changed: true });
    expect(await service.checkEscalations()).toEqual({ escalated: 1 });
    expect(transition).toHaveBeenCalledTimes(1);
    transition.mockRestore();
  });

  it.each(['log', 'notification'])('MAX-565 rolls back when %s insertion fails', async (failure) => {
    const { enqueueNotificationTransition } = await import('../src/notification-transition.js');
    vi.mocked(enqueueNotificationTransition).mockImplementation(async () => {
      if (failure === 'notification') throw Error('injected notification failure');
      return 0 as any;
    });
    const connection = {
      query: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(),
      release: vi.fn(), destroy: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) return [[{ id: 1, level: 'warning', status: 'unread' }]];
        if (sql.includes('INSERT INTO alert_event_logs') && failure === 'log') throw Error('injected log failure');
        return [{ affectedRows: 1 }];
      }),
    };
    mockPool.getConnection.mockResolvedValue(connection);
    const { alertEscalationService: service } = await import('../src/alert-escalation-service');
    expect((await service.manualEscalation(1, 'error')).success).toBe(false);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });

});
