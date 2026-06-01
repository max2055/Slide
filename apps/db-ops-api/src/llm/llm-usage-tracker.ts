/**
 * LLM Token 用量追踪和 Cost 计算
 *
 * 复用 OpenClaw models-config 机制
 */

import type { LLMUsageRecord } from './types.js';

/**
 * 计算单次调用的成本
 */
export function calculateCost(params: {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costRates: {
    input: number;    // USD / 1K tokens
    output: number;   // USD / 1K tokens
  };
}): number {
  const { inputTokens, outputTokens, costRates } = params;

  const inputCost = (inputTokens / 1000) * costRates.input;
  const outputCost = (outputTokens / 1000) * costRates.output;

  return inputCost + outputCost;
}

/**
 * 创建用量记录
 */
export function createUsageRecord(params: {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costRates: {
    input: number;
    output: number;
  };
  purpose?: string;
  userId?: string;
  sessionId?: string;
}): LLMUsageRecord {
  const cost = calculateCost({
    providerId: params.providerId,
    modelId: params.modelId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    costRates: params.costRates,
  });

  return {
    providerId: params.providerId,
    modelId: params.modelId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    totalTokens: params.inputTokens + params.outputTokens,
    costUsd: cost,
    timestamp: Date.now(),
    purpose: params.purpose,
    userId: params.userId,
    sessionId: params.sessionId,
  };
}

/**
 * 聚合用量统计
 */
export interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  requestCount: number;
  byProvider: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    requestCount: number;
  }>;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    requestCount: number;
  }>;
  byUser?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    requestCount: number;
  }>;
}

/**
 * 聚合用量记录生成统计
 */
export function aggregateUsageStats(records: LLMUsageRecord[]): UsageStats {
  const stats: UsageStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    requestCount: records.length,
    byProvider: {},
    byModel: {},
    byUser: {},
  };

  for (const record of records) {
    // 总计
    stats.totalInputTokens += record.inputTokens;
    stats.totalOutputTokens += record.outputTokens;
    stats.totalTokens += record.totalTokens;
    stats.totalCostUsd += record.costUsd;

    // 按提供商统计
    if (!stats.byProvider[record.providerId]) {
      stats.byProvider[record.providerId] = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        requestCount: 0,
      };
    }
    const providerStats = stats.byProvider[record.providerId];
    providerStats.inputTokens += record.inputTokens;
    providerStats.outputTokens += record.outputTokens;
    providerStats.totalTokens += record.totalTokens;
    providerStats.costUsd += record.costUsd;
    providerStats.requestCount++;

    // 按模型统计
    if (!stats.byModel[record.modelId]) {
      stats.byModel[record.modelId] = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        requestCount: 0,
      };
    }
    const modelStats = stats.byModel[record.modelId];
    modelStats.inputTokens += record.inputTokens;
    modelStats.outputTokens += record.outputTokens;
    modelStats.totalTokens += record.totalTokens;
    modelStats.costUsd += record.costUsd;
    modelStats.requestCount++;

    // 按用户统计
    if (record.userId) {
      if (!stats.byUser![record.userId]) {
        stats.byUser![record.userId] = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          requestCount: 0,
        };
      }
      const userStats = stats.byUser![record.userId];
      userStats.inputTokens += record.inputTokens;
      userStats.outputTokens += record.outputTokens;
      userStats.totalTokens += record.totalTokens;
      userStats.costUsd += record.costUsd;
      userStats.requestCount++;
    }
  }

  return stats;
}

/**
 * 按日期聚合用量
 */
export function aggregateUsageByDate(records: LLMUsageRecord[]): Record<string, UsageStats> {
  const byDate: Record<string, LLMUsageRecord[]> = {};

  for (const record of records) {
    const date = new Date(record.timestamp).toISOString().split('T')[0];
    if (!byDate[date]) {
      byDate[date] = [];
    }
    byDate[date].push(record);
  }

  const result: Record<string, UsageStats> = {};
  for (const [date, dateRecords] of Object.entries(byDate)) {
    result[date] = aggregateUsageStats(dateRecords);
  }

  return result;
}

/**
 * 内存用量存储（用于测试和原型）
 */
export class MemoryUsageStore {
  private records: LLMUsageRecord[] = [];

  /**
   * 记录用量
   */
  record(record: LLMUsageRecord): void {
    this.records.push(record);
  }

  /**
   * 查询用量记录
   */
  query(params?: {
    providerId?: string;
    modelId?: string;
    userId?: string;
    sessionId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): LLMUsageRecord[] {
    let filtered = [...this.records];

    if (params?.providerId) {
      filtered = filtered.filter(r => r.providerId === params.providerId);
    }

    if (params?.modelId) {
      filtered = filtered.filter(r => r.modelId === params.modelId);
    }

    if (params?.userId) {
      filtered = filtered.filter(r => r.userId === params.userId);
    }

    if (params?.sessionId) {
      filtered = filtered.filter(r => r.sessionId === params.sessionId);
    }

    if (params?.startTime) {
      filtered = filtered.filter(r => r.timestamp >= params.startTime);
    }

    if (params?.endTime) {
      filtered = filtered.filter(r => r.timestamp <= params.endTime);
    }

    filtered.sort((a, b) => b.timestamp - a.timestamp);

    if (params?.limit) {
      filtered = filtered.slice(0, params.limit);
    }

    return filtered;
  }

  /**
   * 获取统计
   */
  getStats(params?: {
    providerId?: string;
    modelId?: string;
    userId?: string;
    startTime?: number;
    endTime?: number;
  }): UsageStats {
    const records = this.query(params);
    return aggregateUsageStats(records);
  }

  /**
   * 清除所有记录
   */
  clear(): void {
    this.records = [];
  }

  /**
   * 获取记录数
   */
  getCount(): number {
    return this.records.length;
  }
}

// 全局单例
export const memoryUsageStore = new MemoryUsageStore();

/**
 * 记录 LLM 调用用量
 */
export function recordUsage(params: {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costRates: {
    input: number;
    output: number;
  };
  purpose?: string;
  userId?: string;
  sessionId?: string;
}): LLMUsageRecord {
  const record = createUsageRecord(params);
  memoryUsageStore.record(record);
  return record;
}

/**
 * 查询用量记录
 */
export function queryUsage(params?: {
  providerId?: string;
  modelId?: string;
  userId?: string;
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}): LLMUsageRecord[] {
  return memoryUsageStore.query(params);
}

/**
 * 获取用量统计
 */
export function getUsageStats(params?: {
  providerId?: string;
  modelId?: string;
  userId?: string;
  startTime?: number;
  endTime?: number;
}): UsageStats {
  return memoryUsageStore.getStats(params);
}
