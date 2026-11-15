/**
 * scoring-config-service 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scoringConfigService, DEFAULT_WEIGHTS } from './scoring-config-service.js';

// Mock dbConnection
vi.mock('./db-connection.js', () => ({
  dbConnection: {
    getPool: vi.fn(),
    isConnected: vi.fn(),
  },
}));

import { dbConnection } from './db-connection.js';

describe('ScoringConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getWeights', () => {
    it('should return default weights when system_config is empty', async () => {
      const mockPool = {
        execute: vi.fn().mockResolvedValue([[]]),
      };
      (dbConnection.getPool as any).mockReturnValue(mockPool);

      const weights = await scoringConfigService.getWeights();

      expect(weights).toEqual(DEFAULT_WEIGHTS);
      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['scoring.weights'],
      );
    });

    it('should merge stored weights with defaults (partial override)', async () => {
      const storedWeights = { availability: 0.50, performance: 0.30 };
      const mockPool = {
        execute: vi.fn().mockResolvedValue([
          [{ config_key: 'scoring.weights', config_value: JSON.stringify(storedWeights) }],
        ]),
      };
      (dbConnection.getPool as any).mockReturnValue(mockPool);

      const weights = await scoringConfigService.getWeights();

      expect(weights.availability).toBe(0.50);
      expect(weights.performance).toBe(0.30);
      expect(weights.capacity).toBe(DEFAULT_WEIGHTS.capacity); // 0.20 from default
      expect(weights.security).toBe(DEFAULT_WEIGHTS.security); // 0.10 from default
    });

    it('should return defaults when pool is null', async () => {
      (dbConnection.getPool as any).mockReturnValue(null);

      const weights = await scoringConfigService.getWeights();
      expect(weights).toEqual(DEFAULT_WEIGHTS);
    });
  });

  describe('saveWeights', () => {
    it.each([null, undefined, false, 0, 'weights', []])('#369 rejects non-object %j', async input => {
      expect((await scoringConfigService.saveWeights(input)).success).toBe(false);
      expect(dbConnection.getPool).not.toHaveBeenCalled();
    });

    it('#369 requires own dimension fields', async () => {
      expect((await scoringConfigService.saveWeights(Object.create(DEFAULT_WEIGHTS))).success).toBe(false);
    });

    it.each([NaN, Infinity, -Infinity])('rejects invalid numeric value %s', async value => {
      expect((await scoringConfigService.saveWeights({ ...DEFAULT_WEIGHTS, security: value })).success).toBe(false);
    });

    it('should reject invalid weight (>1.0) with error message', async () => {
      const invalidWeights = {
        availability: 1.50,
        performance: 0.20,
        capacity: 0.20,
        security: 0.10,
      };

      const result = await scoringConfigService.saveWeights(invalidWeights);

      expect(result.success).toBe(false);
      expect(result.error).toContain('0.0 到 1.0');
    });

    it('should reject weights that do not sum to ~1.0 with error message', async () => {
      const invalidWeights = {
        availability: 0.80,
        performance: 0.10,
        capacity: 0.05,
        security: 0.02,
      };

      const result = await scoringConfigService.saveWeights(invalidWeights);

      expect(result.success).toBe(false);
      expect(result.error).toContain('约等于 1.0');
    });

    it('should pass valid weights', async () => {
      const validWeights = {
        availability: 0.40,
        performance: 0.30,
        capacity: 0.20,
        security: 0.10,
      };

      const mockPool = {
        execute: vi.fn().mockResolvedValue([{}]),
      };
      (dbConnection.getPool as any).mockReturnValue(mockPool);

      const result = await scoringConfigService.saveWeights(validWeights);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject with error when missing dimensions', async () => {
      const result = await scoringConfigService.saveWeights({
        availability: 0.35,
        performance: 0.35,
        capacity: 0.30,
      } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('security');
    });

    it('should reject non-numeric values', async () => {
      const result = await scoringConfigService.saveWeights({
        availability: 'abc' as any,
        performance: 0.35,
        capacity: 0.20,
        security: 0.10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('数字');
    });
  });
});
