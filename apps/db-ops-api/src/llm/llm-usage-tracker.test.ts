/**
 * LLM Token 用量追踪单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateCost,
  createUsageRecord,
  aggregateUsageStats,
  aggregateUsageByDate,
  MemoryUsageStore,
  memoryUsageStore,
  recordUsage,
  queryUsage,
  getUsageStats,
} from './llm-usage-tracker.js';

describe('calculateCost', () => {
  it('应该计算正确的成本', () => {
    const cost = calculateCost({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: {
        input: 0.0005,
        output: 0.002,
      },
    });

    expect(cost).toBeCloseTo(0.0015, 5); // (1000/1000)*0.0005 + (500/1000)*0.002 = 0.0005 + 0.001 = 0.0015
  });

  it('应该处理 0 tokens', () => {
    const cost = calculateCost({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 0,
      outputTokens: 0,
      costRates: {
        input: 0.0005,
        output: 0.002,
      },
    });

    expect(cost).toBe(0);
  });

  it('应该处理不同费率', () => {
    const cost = calculateCost({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      inputTokens: 2000,
      outputTokens: 1000,
      costRates: {
        input: 0.00039,
        output: 0.0016,
      },
    });

    expect(cost).toBeCloseTo(0.00238, 5); // 2*0.00039 + 1*0.0016 = 0.00238
  });
});

describe('createUsageRecord', () => {
  it('应该创建用量记录', () => {
    const record = createUsageRecord({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: {
        input: 0.0005,
        output: 0.002,
      },
      purpose: 'sql_optimize',
      userId: 'user123',
    });

    expect(record.providerId).toBe('bailian');
    expect(record.modelId).toBe('qwen-plus');
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(500);
    expect(record.totalTokens).toBe(1500);
    expect(record.costUsd).toBeGreaterThan(0);
    expect(record.purpose).toBe('sql_optimize');
    expect(record.userId).toBe('user123');
    expect(record.timestamp).toBeDefined();
  });
});

describe('aggregateUsageStats', () => {
  const records: LLMUsageRecord[] = [
    {
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      costUsd: 0.0015,
      timestamp: Date.now(),
      purpose: 'sql_optimize',
      userId: 'user1',
      sessionId: 'session1',
    },
    {
      providerId: 'bailian',
      modelId: 'qwen-max',
      inputTokens: 2000,
      outputTokens: 1000,
      totalTokens: 3000,
      costUsd: 0.02,
      timestamp: Date.now(),
      purpose: 'fault_diagnosis',
      userId: 'user1',
      sessionId: 'session1',
    },
    {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      inputTokens: 500,
      outputTokens: 250,
      totalTokens: 750,
      costUsd: 0.0006,
      timestamp: Date.now(),
      purpose: 'sql_optimize',
      userId: 'user2',
      sessionId: 'session2',
    },
  ];

  it('应该聚合总量', () => {
    const stats = aggregateUsageStats(records);

    expect(stats.totalInputTokens).toBe(3500);
    expect(stats.totalOutputTokens).toBe(1750);
    expect(stats.totalTokens).toBe(5250);
    expect(stats.requestCount).toBe(3);
    expect(stats.totalCostUsd).toBeGreaterThan(0);
  });

  it('应该按提供商聚合', () => {
    const stats = aggregateUsageStats(records);

    expect(stats.byProvider['bailian']).toBeDefined();
    expect(stats.byProvider['bailian'].requestCount).toBe(2);
    expect(stats.byProvider['deepseek'].requestCount).toBe(1);
  });

  it('应该按模型聚合', () => {
    const stats = aggregateUsageStats(records);

    expect(stats.byModel['qwen-plus']).toBeDefined();
    expect(stats.byModel['qwen-max']).toBeDefined();
    expect(stats.byModel['deepseek-chat']).toBeDefined();
  });

  it('应该按用户聚合', () => {
    const stats = aggregateUsageStats(records);

    expect(stats.byUser!['user1']).toBeDefined();
    expect(stats.byUser!['user1'].requestCount).toBe(2);
    expect(stats.byUser!['user2']).toBeDefined();
    expect(stats.byUser!['user2'].requestCount).toBe(1);
  });
});

describe('aggregateUsageByDate', () => {
  it('应该按日期聚合', () => {
    const now = Date.now();
    const records: LLMUsageRecord[] = [
      {
        providerId: 'bailian',
        modelId: 'qwen-plus',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: 0.0015,
        timestamp: now,
      },
      {
        providerId: 'bailian',
        modelId: 'qwen-plus',
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
        costUsd: 0.003,
        timestamp: now - 86400000, // 前一天
      },
    ];

    const byDate = aggregateUsageByDate(records);
    const dates = Object.keys(byDate);

    expect(dates.length).toBe(2);
  });
});

describe('MemoryUsageStore', () => {
  let store: MemoryUsageStore;

  beforeEach(() => {
    store = new MemoryUsageStore();
  });

  describe('record', () => {
    it('应该记录用量', () => {
      const record = {
        providerId: 'bailian',
        modelId: 'qwen-plus',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: 0.0015,
        timestamp: Date.now(),
      };

      store.record(record);
      expect(store.getCount()).toBe(1);
    });
  });

  describe('query', () => {
    beforeEach(() => {
      const now = Date.now();
      store.record({
        providerId: 'bailian',
        modelId: 'qwen-plus',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: 0.0015,
        timestamp: now,
        userId: 'user1',
        sessionId: 'session1',
      });

      store.record({
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        inputTokens: 500,
        outputTokens: 250,
        totalTokens: 750,
        costUsd: 0.0006,
        timestamp: now,
        userId: 'user2',
        sessionId: 'session2',
      });
    });

    it('应该查询所有记录', () => {
      const records = store.query();
      expect(records).toHaveLength(2);
    });

    it('应该按提供商过滤', () => {
      const records = store.query({ providerId: 'bailian' });
      expect(records).toHaveLength(1);
      expect(records[0].providerId).toBe('bailian');
    });

    it('应该按模型过滤', () => {
      const records = store.query({ modelId: 'qwen-plus' });
      expect(records).toHaveLength(1);
    });

    it('应该按用户过滤', () => {
      const records = store.query({ userId: 'user1' });
      expect(records).toHaveLength(1);
    });

    it('应该按会话过滤', () => {
      const records = store.query({ sessionId: 'session1' });
      expect(records).toHaveLength(1);
    });

    it('应该限制返回数量', () => {
      const records = store.query({ limit: 1 });
      expect(records).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      const now = Date.now();
      store.record({
        providerId: 'bailian',
        modelId: 'qwen-plus',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: 0.0015,
        timestamp: now,
        userId: 'user1',
      });

      store.record({
        providerId: 'bailian',
        modelId: 'qwen-max',
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
        costUsd: 0.02,
        timestamp: now,
        userId: 'user1',
      });
    });

    it('应该获取统计', () => {
      const stats = store.getStats();

      expect(stats.totalTokens).toBe(4500);
      expect(stats.requestCount).toBe(2);
    });

    it('应该按提供商过滤统计', () => {
      const stats = store.getStats({ providerId: 'bailian' });

      expect(stats.requestCount).toBe(2);
    });
  });

  describe('clear', () => {
    it('应该清除所有记录', () => {
      store.record({
        providerId: 'bailian',
        modelId: 'qwen-plus',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: 0.0015,
        timestamp: Date.now(),
      });

      expect(store.getCount()).toBe(1);
      store.clear();
      expect(store.getCount()).toBe(0);
    });
  });
});

describe('recordUsage', () => {
  beforeEach(() => {
    memoryUsageStore.clear();
  });

  it('应该记录用量到全局存储', () => {
    const record = recordUsage({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: {
        input: 0.0005,
        output: 0.002,
      },
      userId: 'user123',
    });

    expect(record.providerId).toBe('bailian');

    const records = queryUsage();
    expect(records).toHaveLength(1);
  });
});

describe('queryUsage', () => {
  beforeEach(() => {
    memoryUsageStore.clear();
  });

  it('应该查询用量记录', () => {
    recordUsage({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: {
        input: 0.0005,
        output: 0.002,
      },
    });

    const records = queryUsage();
    expect(records).toHaveLength(1);
  });
});

describe('getUsageStats', () => {
  beforeEach(() => {
    memoryUsageStore.clear();
  });

  it('应该获取统计', () => {
    recordUsage({
      providerId: 'bailian',
      modelId: 'qwen-plus',
      inputTokens: 1000,
      outputTokens: 500,
      costRates: {
        input: 0.0005,
        output: 0.002,
      },
    });

    const stats = getUsageStats();
    expect(stats.requestCount).toBe(1);
    expect(stats.totalTokens).toBe(1500);
  });
});
