/**
 * Unit tests for ConsistencyChecker — verifies checkSafe wrapping,
 * notification closure, overview caching, and response shape for key check methods.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock state ───────────────────────────────────
const mockExecute = vi.fn();

vi.mock('./db-connection', () => ({
  dbConnection: {
    getPool: () => ({ execute: mockExecute }),
    isConnected: () => true,
  },
}));

import { ConsistencyChecker } from './consistency-checker';

describe('ConsistencyChecker', () => {
  let checker: ConsistencyChecker;

  beforeEach(() => {
    checker = new ConsistencyChecker();
    vi.clearAllMocks();
  });

  // ── checkSafe wrapper ─────────────────────────────────

  describe('_checkSafe', () => {
    it('returns the check result when fn succeeds', async () => {
      const check: any = { id: 'test', label: 'Test', category: 'test', status: 'pass', severity: 'info', summary: 'ok' };
      const result = await checker._checkSafe(() => Promise.resolve(check), 'test', 'Test', 'test');
      expect(result).toEqual(check);
    });

    it('catches errors and returns fail without throwing', async () => {
      const result = await checker._checkSafe(() => Promise.reject(new Error('Connection refused')), 'test_crash', '崩溃测试', 'test');
      expect(result.id).toBe('test_crash');
      expect(result.status).toBe('fail');
      expect(result.severity).toBe('critical');
      expect(result.summary).toContain('Connection refused');
    });
  });

  describe('resourceHealthTruth', () => {
    it('keeps four unhealthy instances visible in the managed-resource denominator', async () => {
      mockExecute.mockResolvedValueOnce([[
        { id: 1, health_status: 'healthy', latest_metric: new Date() },
        { id: 2, health_status: 'critical', latest_metric: new Date() },
        { id: 3, health_status: 'critical', latest_metric: new Date() },
        { id: 4, health_status: 'critical', latest_metric: new Date() },
        { id: 5, health_status: 'critical', latest_metric: new Date() },
      ], []]);
      mockExecute.mockResolvedValueOnce([[], []]);
      const result = await checker.resourceHealthTruth();
      expect(result.overall).toBe('critical');
      expect(result.managedAvailability).toMatchObject({ numerator: 1, denominator: 5 });
    });

    it('marks per-resource stale metrics degraded even when the resource is healthy', async () => {
      mockExecute.mockResolvedValueOnce([[
        { id: 1, health_status: 'healthy', latest_metric: new Date(Date.now() - 11 * 60_000) },
      ], []]);
      mockExecute.mockResolvedValueOnce([[], []]);
      const result = await checker.resourceHealthTruth();
      expect(result.dataFreshness).toMatchObject({ status: 'critical', numerator: 0, denominator: 1 });
      expect(result.overall).toBe('critical');
    });
  });

  // ── runAllChecks ──────────────────────────────────────

  describe('runAllChecks', () => {
    beforeEach(() => {
      // Default mock: all queries resolve to empty results for deterministic tests
      mockExecute.mockResolvedValue([[], []]);
    });

    it('returns ConsistencyResponse with timestamp, summary, checks, readiness', async () => {
      const result = await checker.runAllChecks();
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('readiness');
      expect(result.checks.length).toBe(10);
      expect(result.summary.total).toBe(10);
      const { pass, warn, fail, deferred } = result.summary;
      expect(pass + warn + fail + deferred).toBe(10);
    });

    it('each check has required fields', async () => {
      const result = await checker.runAllChecks();
      for (const check of result.checks) {
        expect(check).toHaveProperty('id');
        expect(check).toHaveProperty('label');
        expect(check).toHaveProperty('category');
        expect(check).toHaveProperty('status');
        expect(check).toHaveProperty('severity');
        expect(check).toHaveProperty('summary');
        expect(['pass', 'warn', 'fail', 'deferred']).toContain(check.status);
        expect(['info', 'minor', 'major', 'critical']).toContain(check.severity);
      }
    });
  });

  // ── _checkNotificationClosure ─────────────────────────

  describe('_checkNotificationClosure', () => {
    it('passes when persisted notification delivery has no open closure issue', async () => {
      mockExecute.mockResolvedValue([[{
        enabled_channels: 1,
        invalid_channels: 0,
        stuck_jobs: 0,
        dead_letter_jobs: 0,
        stale_attempts: 0,
        unpersisted_sent: 0,
      }], []]);

      const result = await checker._checkNotificationClosure();
      expect(result.id).toBe('notification_closure');
      expect(result.status).toBe('pass');
      expect(result.category).toBe('notification');
      expect(result.severity).toBe('info');
      expect(result.summary).toContain('闭环正常');
    });

    it('fails when delivery jobs or persisted results are not closed', async () => {
      mockExecute.mockResolvedValue([[{
        enabled_channels: 1,
        invalid_channels: 0,
        stuck_jobs: 2,
        dead_letter_jobs: 1,
        stale_attempts: 1,
        unpersisted_sent: 1,
      }], []]);

      const result = await checker._checkNotificationClosure();
      expect(result.status).toBe('fail');
      expect(result.severity).toBe('critical');
      expect(result.details).toMatchObject({ stuck_jobs: 2, dead_letter_jobs: 1, stale_attempts: 1, unpersisted_sent: 1 });
      expect(result.recommendation).toContain('死信');
    });
  });

  describe('healthOverview', () => {
    it('coalesces and caches consistency and resource-health queries', async () => {
      const consistency = { timestamp: '2026-08-06T00:00:00.000Z', summary: { pass: 1, warn: 0, fail: 0, deferred: 0, total: 1 }, checks: [], readiness: {} } as any;
      const truth = { overall: 'healthy' } as any;
      const runAllChecks = vi.spyOn(checker, 'runAllChecks').mockResolvedValue(consistency);
      const resourceHealthTruth = vi.spyOn(checker, 'resourceHealthTruth').mockResolvedValue(truth);

      const [first, second] = await Promise.all([checker.healthOverview(), checker.healthOverview()]);
      const cached = await checker.healthOverview();

      expect(first).toEqual({ ...consistency, truth });
      expect(second).toBe(first);
      expect(cached).toBe(first);
      expect(runAllChecks).toHaveBeenCalledTimes(1);
      expect(resourceHealthTruth).toHaveBeenCalledTimes(1);
    });

    it('bypasses the cache on forced refresh', async () => {
      vi.spyOn(checker, 'runAllChecks').mockResolvedValue({ timestamp: '', summary: {}, checks: [], readiness: {} } as any);
      vi.spyOn(checker, 'resourceHealthTruth').mockResolvedValue({ overall: 'healthy' } as any);

      await checker.healthOverview();
      await checker.healthOverview(true);

      expect(checker.runAllChecks).toHaveBeenCalledTimes(2);
      expect(checker.resourceHealthTruth).toHaveBeenCalledTimes(2);
    });
  });

  // ── _checkInstanceCountMatch ──────────────────────────

  describe('_checkInstanceCountMatch', () => {
    it('returns pass when active instances exist', async () => {
      mockExecute.mockResolvedValue([[{ active_count: 5, total_data_size: 100 }], []]);
      const result = await checker._checkInstanceCountMatch();
      expect(result.status).toBe('pass');
      expect(result.summary).toContain('5');
    });

    it('returns fail when no active instances', async () => {
      mockExecute.mockResolvedValue([[{ active_count: 0, total_data_size: 0 }], []]);
      const result = await checker._checkInstanceCountMatch();
      expect(result.status).toBe('fail');
      expect(result.severity).toBe('critical');
    });
  });

  describe('_checkCapacitySumMatch', () => {
    it('checks every managed instance, including inactive instances shown in instance management', async () => {
      mockExecute
        .mockResolvedValueOnce([[{ inst_total: 2.71 }], []])
        .mockResolvedValueOnce([[
          { id: 1, name: 'active-db', inst_size: 0.86, cap_size: 0.86, cap_ts: new Date() },
          { id: 2, name: 'inactive-db', inst_size: 1.85, cap_size: 1.85, cap_ts: new Date() },
        ], []]);

      const result = await checker._checkCapacitySumMatch();

      expect(result.status).toBe('pass');
      expect(mockExecute.mock.calls[0][0]).not.toContain('WHERE status =');
      expect(mockExecute.mock.calls[1][0]).not.toContain("WHERE di.status = 'active'");
    });

    it('warns when a sub-gigabyte difference exceeds stored capacity precision', async () => {
      mockExecute
        .mockResolvedValueOnce([[{ inst_total: 0.86 }], []])
        .mockResolvedValueOnce([[
          { id: 1, name: 'mysql3306', inst_size: 0.86, cap_size: 0.4, cap_ts: new Date() },
        ], []]);

      const result = await checker._checkCapacitySumMatch();

      expect(result.status).toBe('warn');
      expect(result.summary).toContain('不一致');
    });

    it('warns when a zero-sized managed instance has no capacity collection record', async () => {
      mockExecute
        .mockResolvedValueOnce([[{ inst_total: 0 }], []])
        .mockResolvedValueOnce([[
          { id: 1, name: 'new-db', inst_size: 0, cap_size: -1, cap_ts: null },
        ], []]);

      const result = await checker._checkCapacitySumMatch();

      expect(result.status).toBe('warn');
      expect(result.details).toEqual([
        expect.objectContaining({ id: 1, name: 'new-db', cap_size: -1 }),
      ]);
    });
  });

  // ── _checkAlertRuleMetricRefs ─────────────────────────

  describe('_checkAlertRuleMetricRefs', () => {
    it('returns pass when no orphan refs', async () => {
      mockExecute.mockResolvedValue([[], []]);
      const result = await checker._checkAlertRuleMetricRefs();
      expect(result.status).toBe('pass');
    });

    it('returns fail when orphan refs exist', async () => {
      mockExecute.mockResolvedValue([[{ id: 1, name: 'broken', metric_name: 'missing_metric' }], []]);
      const result = await checker._checkAlertRuleMetricRefs();
      expect(result.status).toBe('fail');
      expect(result.summary).toContain('1');
    });
  });

  // ── Error isolation ───────────────────────────────────

  describe('error isolation', () => {
    it('_checkSafe catches errors and returns structured fail', async () => {
      const result = await checker._checkSafe(() => Promise.reject(new Error('Boom')), 'crash', '崩溃', 'test');
      expect(result.status).toBe('fail');
      expect(result.severity).toBe('critical');
    });

    it('runAllChecks completes all 10 even when one check method throws', async () => {
      mockExecute.mockResolvedValue([[], []]);
      const original = checker._checkInstanceCountMatch;
      checker._checkInstanceCountMatch = () => Promise.reject(new Error('DB error'));
      try {
        const result = await checker.runAllChecks();
        expect(result.checks.length).toBe(10);
        const failedCheck = result.checks.find((c) => c.id === 'instance_count_match');
        expect(failedCheck).toBeDefined();
        expect(failedCheck!.status).toBe('fail');
        expect(failedCheck!.summary).toContain('DB error');
      } finally {
        checker._checkInstanceCountMatch = original;
      }
    });
  });
});
