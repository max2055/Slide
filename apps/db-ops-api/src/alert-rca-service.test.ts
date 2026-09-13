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
