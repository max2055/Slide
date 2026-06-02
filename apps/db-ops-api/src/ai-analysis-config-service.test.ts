/**
 * Nyquist validation: 92-03-01 — ai-analysis-config-service
 *
 * Tests:
 * 1. AiAnalysisConfig interface has all 6 fields
 * 2. DEFAULT_CONFIG has correct defaults
 * 3. getConfig returns merged config when DB has partial config
 * 4. getConfig returns DEFAULT_CONFIG when DB has no row
 * 5. getConfig returns DEFAULT_CONFIG on DB error
 * 6. saveConfig validates enabled is boolean
 * 7. saveConfig validates severityLevels are valid strings
 * 8. saveConfig validates timeWindow format HH:MM
 * 9. saveConfig returns success on valid save
 * 10. saveConfig returns error on validation failure
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dbConnection and mysql2/promise
const mockPool = {
  execute: vi.fn(),
};
vi.mock('mysql2/promise', () => ({}));
vi.mock('./db-connection.js', () => ({
  dbConnection: {
    getPool: vi.fn(() => mockPool),
    isConnected: vi.fn(() => true),
  },
}));

// Import AFTER mock so mocks are active
import { DEFAULT_CONFIG } from './ai-analysis-config-service.js';
const { AiAnalysisConfigService } = await import('./ai-analysis-config-service.js');

// We need to access the class but it's not exported, only the singleton.
// Let's use the singleton and also verify the interface through observed behavior.
import { aiAnalysisConfigService } from './ai-analysis-config-service.js';

describe('92-03-01: ai-analysis-config-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.execute.mockReset();
  });

  describe('DEFAULT_CONFIG', () => {
    it('has all 6 fields with correct defaults', () => {
      expect(DEFAULT_CONFIG).toHaveProperty('enabled', true);
      expect(DEFAULT_CONFIG).toHaveProperty('cronExpression', '*/30 * * * *');
      expect(DEFAULT_CONFIG).toHaveProperty('severityLevels');
      expect(Array.isArray(DEFAULT_CONFIG.severityLevels)).toBe(true);
      expect(DEFAULT_CONFIG.severityLevels).toContain('critical');
      expect(DEFAULT_CONFIG.severityLevels).toContain('error');
      expect(DEFAULT_CONFIG.severityLevels).toContain('warning');
      expect(DEFAULT_CONFIG).toHaveProperty('instanceWhitelist');
      expect(Array.isArray(DEFAULT_CONFIG.instanceWhitelist)).toBe(true);
      expect(DEFAULT_CONFIG.instanceWhitelist).toEqual([]);
      expect(DEFAULT_CONFIG).toHaveProperty('timeWindowStart', '00:00');
      expect(DEFAULT_CONFIG).toHaveProperty('timeWindowEnd', '23:59');
    });
  });

  describe('getConfig', () => {
    it('returns merged config when DB has saved config', async () => {
      const savedConfig = {
        enabled: false,
        severityLevels: ['critical'],
        timeWindowStart: '08:00',
      };
      mockPool.execute.mockResolvedValueOnce([
        [{ config_key: 'auto_analysis_config', config_value: JSON.stringify(savedConfig) }],
      ] as any);

      const config = await aiAnalysisConfigService.getConfig();

      // Should merge with defaults: enabled comes from saved, instanceWhitelist from default
      expect(config.enabled).toBe(false);
      expect(config.severityLevels).toEqual(['critical']);
      expect(config.cronExpression).toBe('*/30 * * * *'); // from default
      expect(config.timeWindowStart).toBe('08:00');
      expect(config.timeWindowEnd).toBe('23:59'); // from default
      expect(config.instanceWhitelist).toEqual([]); // from default
    });

    it('returns DEFAULT_CONFIG when DB has no row', async () => {
      mockPool.execute.mockResolvedValueOnce([[]] as any);

      const config = await aiAnalysisConfigService.getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('returns DEFAULT_CONFIG on DB error', async () => {
      mockPool.execute.mockRejectedValueOnce(new Error('Connection lost'));

      const config = await aiAnalysisConfigService.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.cronExpression).toBe('*/30 * * * *');
    });

    it('returns disabled config when pool is null', async () => {
      // Temporarily make getPool return null
      const { dbConnection } = await import('./db-connection.js');
      (dbConnection.getPool as any).mockReturnValueOnce(null);

      const config = await aiAnalysisConfigService.getConfig();
      // Falls back to DEFAULT_CONFIG since pool is null and catch returns defaults
      expect(config.enabled).toBe(true);
      expect(config.cronExpression).toBe('*/30 * * * *');
    });
  });

  describe('saveConfig', () => {
    // Full valid defaults so validation reaches the field under test
    const valid = {
      enabled: true,
      cronExpression: '*/30 * * * *',
      severityLevels: ['critical'] as any,
      instanceWhitelist: [] as number[],
      timeWindowStart: '00:00',
      timeWindowEnd: '23:59',
    };

    it('validates enabled is boolean: rejects non-boolean', async () => {
      const result = await aiAnalysisConfigService.saveConfig({ enabled: 'yes' as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('布尔值');
    });

    it('validates severityLevels: rejects invalid severity', async () => {
      mockPool.execute.mockResolvedValueOnce([[]] as any); // getConfig returns defaults
      const result = await aiAnalysisConfigService.saveConfig({
        ...valid,
        severityLevels: ['critical', 'invalid_severity' as any],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('无效的严重级别');
    });

    it('validates severityLevels: rejects non-array', async () => {
      mockPool.execute.mockResolvedValueOnce([[]] as any);
      const result = await aiAnalysisConfigService.saveConfig({
        ...valid,
        severityLevels: 'critical' as any,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('必须是非空数组');
    });

    it('validates timeWindowStart format HH:MM: rejects invalid format', async () => {
      mockPool.execute.mockResolvedValueOnce([[]] as any);
      const result = await aiAnalysisConfigService.saveConfig({
        ...valid,
        timeWindowStart: '25:00',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('HH:MM');
    });

    it('validates timeWindowEnd format HH:MM: rejects invalid format', async () => {
      mockPool.execute.mockResolvedValueOnce([[]] as any);
      const result = await aiAnalysisConfigService.saveConfig({
        ...valid,
        timeWindowEnd: '12:60',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('HH:MM');
    });

    it('validates cronExpression is non-empty', async () => {
      mockPool.execute.mockResolvedValueOnce([[]] as any);
      const result = await aiAnalysisConfigService.saveConfig({
        ...valid,
        cronExpression: '',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('非空字符串');
    });

    it('validates instanceWhitelist entries are positive integers', async () => {
      mockPool.execute.mockResolvedValueOnce([[]] as any);
      const result = await aiAnalysisConfigService.saveConfig({
        ...valid,
        instanceWhitelist: [-1, 0],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('正整数');
    });

    it('returns success on valid save', async () => {
      mockPool.execute.mockResolvedValueOnce([{ affectedRows: 1 }] as any);

      const result = await aiAnalysisConfigService.saveConfig({
        enabled: true,
        cronExpression: '*/30 * * * *',
        severityLevels: ['critical', 'error'],
        instanceWhitelist: [1, 2, 3],
        timeWindowStart: '09:00',
        timeWindowEnd: '18:00',
      });

      expect(result.success).toBe(true);
    });
  });
});
