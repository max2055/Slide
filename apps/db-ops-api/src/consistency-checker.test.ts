/**
 * Unit tests for ConsistencyChecker — verifies checkSafe wrapping,
 * deferred check, and response shape for key check methods.
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
      const result = await checker.resourceHealthTruth();
      expect(result.overall).toBe('critical');
      expect(result.managedAvailability).toMatchObject({ numerator: 1, denominator: 5 });
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

  // ── _checkNotificationDeferred ────────────────────────

  describe('_checkNotificationDeferred', () => {
    it('returns deferred with no DB queries', async () => {
      const result = await checker._checkNotificationDeferred();
      expect(result.id).toBe('notification_closure');
      expect(result.status).toBe('deferred');
      expect(result.category).toBe('notification');
      expect(result.severity).toBe('info');
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
