import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertRCAService } from './alert-rca-service.js';

describe('AlertRCAService', () => {
  let service: AlertRCAService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AlertRCAService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('shouldTriggerRCA', () => {
    it('should return true for warning level', () => {
      expect(service.shouldTriggerRCA('warning')).toBe(true);
    });

    it('should return true for error level', () => {
      expect(service.shouldTriggerRCA('error')).toBe(true);
    });

    it('should return true for critical level', () => {
      expect(service.shouldTriggerRCA('critical')).toBe(true);
    });

    it('should return false for info level', () => {
      expect(service.shouldTriggerRCA('info')).toBe(false);
    });

    it('should return false for unknown level', () => {
      expect(service.shouldTriggerRCA('unknown')).toBe(false);
    });
  });

  it('rejects analysis of a missing alert through the public entry point', async () => {
    const { dbConnection } = await import('./db-connection.js');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[]]) } as any);
    expect(await service.analyzeAlert(123)).toMatchObject({ success: false });
  });
});

it('releases the RCA lock when workflow cancellation interrupts an awaited step', async () => {
  const { workflowExecution } = await import('./workflows/execution-context.js');
  const { aiAnalysisDatabaseService } = await import('./ai-analysis-database-service.js');
  const service = new AlertRCAService();
  const controller = new AbortController();
  vi.spyOn(service as any, '_getAlertById').mockResolvedValue({ id: 991, instance_id: 7, level: 'warning' });
  const lookup = vi.spyOn(aiAnalysisDatabaseService, 'getAnalysisList').mockImplementation(async () => {
    controller.abort(new Error('WORKFLOW_LEASE_LOST'));
    return [];
  });
  try {
    await expect(workflowExecution.run({ signal: controller.signal, workerId: 'a', fencingToken: 1 }, () => service.analyzeAlert(991))).rejects.toThrow('WORKFLOW_LEASE_LOST');
    lookup.mockRejectedValue(new Error('RECOVERY_PROBE'));
    await expect(service.analyzeAlert(991)).rejects.toThrow('RECOVERY_PROBE');
  } finally {
    vi.restoreAllMocks();
  }
});
