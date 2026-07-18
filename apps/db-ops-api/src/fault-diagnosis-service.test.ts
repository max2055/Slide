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
      const key = service['buildCacheKey'](10, 'auto');
      expect(key).toBe('fault:10:2026-04-25T14:auto');
    });

    it('should produce same key within same hour', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
      const key1 = service['buildCacheKey'](10, 'manual');
      vi.setSystemTime(new Date('2026-04-25T14:59:59Z'));
      const key2 = service['buildCacheKey'](10, 'manual');
      expect(key1).toBe(key2);
    });

    it('should produce different key in different hour', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T14:59:59Z'));
      const key1 = service['buildCacheKey'](10, 'auto');
      vi.setSystemTime(new Date('2026-04-25T15:00:00Z'));
      const key2 = service['buildCacheKey'](10, 'auto');
      expect(key1).not.toBe(key2);
    });
  });
});
