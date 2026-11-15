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

it('does not queue an RCA after workflow cancellation during evidence loading', async () => {
  const { workflowExecution } = await import('./workflows/execution-context.js');
  const service = new AlertRCAService(); const controller = new AbortController();
  vi.spyOn(service as any, '_getAlertById').mockImplementation(async () => { controller.abort(new Error('WORKFLOW_LEASE_LOST')); return { id: 991, instance_id: 7, level: 'warning' }; });
  try { await expect(workflowExecution.run({ signal: controller.signal, workerId: 'a', fencingToken: 1 }, () => service.analyzeAlert(991))).rejects.toThrow('WORKFLOW_LEASE_LOST'); }
  finally { vi.restoreAllMocks(); }
});

// #485: infrastructure faults must never masquerade as a missing alert.
it.each(['no-pool', 'ECONNREFUSED', 'ETIMEDOUT', 'ER_BAD_FIELD_ERROR'])('reports unavailable for %s and retains a server log', async fault => {
  const { dbConnection } = await import('./db-connection.js');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(dbConnection, 'getPool').mockReturnValue(fault === 'no-pool' ? null : { execute: vi.fn().mockRejectedValue(new Error(fault)) } as any);
  try {
    await expect(new AlertRCAService().analyzeAlert(123)).rejects.toThrow('ALERT_RCA_SERVICE_UNAVAILABLE');
    expect(log).toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
