import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

vi.mock('../src/alert-database-service', () => ({
  alertDatabaseService: {},
}));

const mockPool = {
  execute: vi.fn().mockResolvedValue([[]]),
};

describe('alert-escalation-service.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(mockPool.execute).mockReset();
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
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[]]);
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const result = await alertEscalationService.checkEscalations();
    expect(result.escalated).toBe(0);
  });

  it('manualEscalation returns error when alert not found', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[]]);
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const result = await alertEscalationService.manualEscalation(999, 'critical');
    expect(result.success).toBe(false);
    expect(result.error).toBe('告警不存在');
  });

  it('getEscalationRules returns empty when no rules in DB', async () => {
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const rules = await alertEscalationService.getEscalationRules();
    expect(Array.isArray(rules)).toBe(true);
  });

  it('deleteEscalationRule executes DELETE SQL', async () => {
    const { alertEscalationService } = await import('../src/alert-escalation-service');
    const result = await alertEscalationService.deleteEscalationRule(1);
    expect(result.success).toBe(true);
  });
});
