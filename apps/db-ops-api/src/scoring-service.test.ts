/**
 * scoring-service 单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  calculateDimensionScores,
  DIMENSION_MAP,
} from './scoring-service.js';

const DEFAULT_WEIGHTS = {
  availability: 0.35,
  performance: 0.35,
  capacity: 0.20,
  security: 0.10,
};

describe('calculateDimensionScores', () => {
  it('should calculate correct dimension scores and total for MySQL checks', () => {
    const checks = [
      { name: '连接状态', status: 'ok', score: 100, message: '连接正常' },
      { name: '连接数使用率', status: 'warning', score: 70, message: '连接数使用率较高：65.2%' },
      { name: '慢查询', status: 'ok', score: 100, message: '无慢查询' },
    ];

    const result = calculateDimensionScores(checks, 'mysql', DEFAULT_WEIGHTS);

    // availability=100 (only 连接状态)
    expect(result.dimensions.availability).toBe(100);
    // capacity=70 (only 连接数使用率)
    expect(result.dimensions.capacity).toBe(70);
    // performance=100 (only 慢查询)
    expect(result.dimensions.performance).toBe(100);
    // security — no checks for mysql, neutral 100
    expect(result.dimensions.security).toBe(100);

    // total = (100*0.35 + 70*0.20 + 100*0.35 + 100*0.10)
    //       = 35 + 14 + 35 + 10 = 94
    expect(result.total).toBe(94);
  });

  it('should reflect correct total with custom weights', () => {
    const checks = [
      { name: '连接状态', status: 'ok', score: 100 },
      { name: '连接数使用率', status: 'warning', score: 70 },
      { name: '慢查询', status: 'ok', score: 100 },
    ];

    const customWeights = {
      availability: 0.50,
      performance: 0.30,
      capacity: 0.15,
      security: 0.05,
    };

    const result = calculateDimensionScores(checks, 'mysql', customWeights);

    // total = (100*0.50 + 70*0.15 + 100*0.30 + 100*0.05)
    //       = 50 + 10.5 + 30 + 5 = 95.5 → round to 96
    expect(result.total).toBe(96);
  });

  it('should add dimension field to each check output', () => {
    const checks = [
      { name: '连接状态', status: 'ok', score: 100, message: '连接正常' },
      { name: '连接数使用率', status: 'warning', score: 70 },
      { name: '慢查询', status: 'ok', score: 100 },
    ];

    const result = calculateDimensionScores(checks, 'mysql', DEFAULT_WEIGHTS);

    // 验证返回的 checks 数组中每个 check 带有正确的 dimension 字段
    expect(result.checks).toHaveLength(3);
    expect(result.checks[0].dimension).toBe('availability');
    expect(result.checks[1].dimension).toBe('capacity');
    expect(result.checks[2].dimension).toBe('performance');

    // 原始 check 字段保持不变
    expect(result.checks[0].name).toBe('连接状态');
    expect(result.checks[1].score).toBe(70);

    // DIMENSION_MAP 常量映射也应正确
    expect(DIMENSION_MAP.mysql['连接状态']).toBe('availability');
    expect(DIMENSION_MAP.mysql['连接数使用率']).toBe('capacity');
    expect(DIMENSION_MAP.mysql['慢查询']).toBe('performance');
  });

  it('should return neutral 100 for missing dimension in DB type', () => {
    // MySQL has no checks that map to 'security'
    const checks = [
      { name: '连接状态', status: 'ok', score: 100 },
    ];

    const result = calculateDimensionScores(checks, 'mysql', DEFAULT_WEIGHTS);

    // Only availability has a check, all others get neutral 100
    expect(result.dimensions.availability).toBe(100);
    expect(result.dimensions.performance).toBe(100);
    expect(result.dimensions.capacity).toBe(100);
    expect(result.dimensions.security).toBe(100);
  });

  it('should handle PostgreSQL checks correctly with security dimension', () => {
    const checks = [
      { name: '连接状态', status: 'ok', score: 100 },
      { name: '连接数使用率', status: 'warning', score: 70 },
      { name: '缓存命中率', status: 'warning', score: 70 },
      { name: '死锁检测', status: 'ok', score: 100 },
    ];

    const result = calculateDimensionScores(checks, 'postgresql', DEFAULT_WEIGHTS);

    expect(result.dimensions.availability).toBe(100);
    expect(result.dimensions.capacity).toBe(70);
    expect(result.dimensions.performance).toBe(70);
    expect(result.dimensions.security).toBe(100);
  });

  it('should export DIMENSION_MAP with all expected DB types', () => {
    expect(DIMENSION_MAP.mysql).toBeDefined();
    expect(DIMENSION_MAP.postgresql).toBeDefined();
    expect(DIMENSION_MAP.oracle).toBeDefined();
    expect(DIMENSION_MAP.dameng).toBeDefined();
  });
});
