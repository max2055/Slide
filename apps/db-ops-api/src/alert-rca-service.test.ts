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

  describe('buildRCAPrompt', () => {
    it('should generate prompt with alert overview section', () => {
      const alert = {
        id: 1,
        title: 'CPU High',
        level: 'critical' as const,
        alert_type: 'performance' as const,
        instance_id: 10,
        metric_name: 'cpu_usage',
        metric_value: '95.5',
        threshold_value: '90',
        created_at: new Date('2026-04-25T10:00:00Z'),
      };
      const prompt = (service as any).buildRCAPrompt(alert, [], [], [], [], [], []);
      expect(prompt).toContain('告警ID');
      expect(prompt).toContain('CPU High');
      expect(prompt).toContain('critical');
      expect(prompt).toContain('cpu_usage');
    });

    it('should include all data sections', () => {
      const alert = {
        id: 1,
        title: 'Test Alert',
        level: 'warning' as const,
        alert_type: 'performance' as const,
        instance_id: 10,
        metric_name: null,
        metric_value: null,
        threshold_value: null,
        created_at: new Date('2026-04-25T10:00:00Z'),
      };
      const prompt = (service as any).buildRCAPrompt(
        alert,
        ['metrics data'],
        ['session data'],
        ['slow query data'],
        ['lock wait data'],
        ['recent alerts'],
        []
      );
      expect(prompt).toContain('指标趋势');
      expect(prompt).toContain('活跃会话');
      expect(prompt).toContain('慢查询');
      expect(prompt).toContain('锁等待');
      expect(prompt).toContain('最近告警');
    });
  });
});
