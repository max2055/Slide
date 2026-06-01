import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FaultDiagnosisService } from './fault-diagnosis-service.js';

describe('FaultDiagnosisService', () => {
  let service: FaultDiagnosisService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new FaultDiagnosisService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buildCacheKey', () => {
    it('should use hour-level granularity', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T14:30:00Z'));
      const key = service['buildCacheKey'](10);
      expect(key).toBe('fault:10:2026-04-25T14');
    });

    it('should produce same key within same hour', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
      const key1 = service['buildCacheKey'](10);
      vi.setSystemTime(new Date('2026-04-25T14:59:59Z'));
      const key2 = service['buildCacheKey'](10);
      expect(key1).toBe(key2);
    });

    it('should produce different key in different hour', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T14:59:59Z'));
      const key1 = service['buildCacheKey'](10);
      vi.setSystemTime(new Date('2026-04-25T15:00:00Z'));
      const key2 = service['buildCacheKey'](10);
      expect(key1).not.toBe(key2);
    });
  });

  describe('buildFaultDiagnosisPrompt', () => {
    it('should include all required sections', () => {
      const instanceInfo = {
        name: 'prod-db-01',
        db_type: 'mysql',
        environment: 'production',
      };
      const prompt = (service as any).buildFaultDiagnosisPrompt(
        instanceInfo,
        'score: 65',
        'metrics trend data',
        'sessions data',
        'slow queries data',
        'recent alerts data',
        'index status data',
        'replication status data'
      );
      expect(prompt).toContain('实例信息');
      expect(prompt).toContain('健康评分');
      expect(prompt).toContain('指标趋势');
      expect(prompt).toContain('活跃会话');
      expect(prompt).toContain('慢查询');
      expect(prompt).toContain('最近告警');
      expect(prompt).toContain('索引状态');
      expect(prompt).toContain('复制状态');
    });

    it('should include instance details', () => {
      const instanceInfo = {
        name: 'test-db',
        db_type: 'mysql',
        environment: 'staging',
      };
      const prompt = (service as any).buildFaultDiagnosisPrompt(
        instanceInfo, '', '', '', '', '', '', ''
      );
      expect(prompt).toContain('test-db');
      expect(prompt).toContain('mysql');
      expect(prompt).toContain('staging');
    });
  });
});
