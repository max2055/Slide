/**
 * Context Manager - 智能上下文管理
 *
 * 支持：
 * 1. 基于 Token 用量的历史截断
 * 2. 会话压缩 (compaction)
 * 3. 上下文窗口管理
 */

import type { SessionManager, SessionEntry } from '../sessions/session-manager.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface ContextConfig {
  maxContextTokens: number;
  maxMessageHistory?: number;
  compressionThreshold?: number; // 达到此阈值时触发压缩
  modelCosts?: {
    inputCostPer1K: number;
    outputCostPer1K: number;
  };
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxContextTokens: 100000, // 默认 100K tokens 上下文窗口
  maxMessageHistory: 50,    // 最多保留 50 条消息
  compressionThreshold: 0.8, // 80% 使用时触发压缩
};

/**
 * 估算文本的 token 数量
 * 简单实现：按字符数估算（英文 ~4 字符/token，中文 ~1.5 字符/token）
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 检测中文字符比例
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalChars = text.length;
  const englishChars = totalChars - chineseChars;

  // 中文约 1.5 字符/token，英文约 4 字符/token
  const chineseTokens = chineseChars / 1.5;
  const englishTokens = englishChars / 4;

  return Math.round(chineseTokens + englishTokens);
}

/**
 * 计算消息的 token 数量
 */
export function estimateMessageTokens(entry: SessionEntry): number {
  let tokens = 0;

  // 内容 tokens
  if (typeof entry.content === 'string') {
    tokens += estimateTokens(entry.content);
  } else if (Array.isArray(entry.content)) {
    for (const item of entry.content) {
      if (typeof item === 'object' && item !== null && 'text' in item) {
        tokens += estimateTokens((item as { text: string }).text);
      }
    }
  }

  // 角色 overhead
  tokens += 4; // system/user/assistant 标记

  // 时间戳 overhead
  tokens += 2;

  return tokens;
}

/**
 * 上下文管理器
 */
export class ContextManager {
  private sessionManager: SessionManager;
  private config: ContextConfig;
  private usageHistory: Map<string, TokenUsage> = new Map();

  constructor(sessionManager: SessionManager, config?: Partial<ContextConfig>) {
    this.sessionManager = sessionManager;
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  }

  /**
   * 构建会话上下文（自动截断以保持 token 限制）
   */
  async buildContext(sessionId: string): Promise<{
    entries: SessionEntry[];
    totalTokens: number;
    wasTruncated: boolean;
    tokenUsage: TokenUsage;
  }> {
    let entries = await this.sessionManager.getMessages(sessionId, {
      limit: this.config.maxMessageHistory,
    });

    // 计算当前 token 数量
    let totalTokens = entries.reduce((sum, entry) => sum + estimateMessageTokens(entry), 0);
    const wasTruncated = totalTokens > this.config.maxContextTokens * this.config.compressionThreshold;

    // 如果超出阈值，从最早的消息开始截断
    if (totalTokens > this.config.maxContextTokens) {
      const targetTokens = Math.floor(this.config.maxContextTokens * 0.7); // 截断到 70%
      entries = this.truncateEntriesByTokens(entries, targetTokens);
      totalTokens = entries.reduce((sum, entry) => sum + estimateMessageTokens(entry), 0);
    }

    // 记录 token 用量
    const usage = this.usageHistory.get(sessionId) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    usage.inputTokens += totalTokens;
    usage.totalTokens += totalTokens;
    this.usageHistory.set(sessionId, usage);

    return {
      entries,
      totalTokens,
      wasTruncated,
      tokenUsage: usage,
    };
  }

  /**
   * 按 token 数量截断条目
   */
  private truncateEntriesByTokens(entries: SessionEntry[], targetTokens: number): SessionEntry[] {
    let currentTokens = 0;
    const result: SessionEntry[] = [];

    // 从后向前遍历（保留最新消息）
    for (let i = entries.length - 1; i >= 0; i--) {
      const entryTokens = estimateMessageTokens(entries[i]);
      if (currentTokens + entryTokens > targetTokens) {
        break;
      }
      currentTokens += entryTokens;
      result.unshift(entries[i]); // 添加到开头保持顺序
    }

    return result;
  }

  /**
   * 记录 LLM 响应 token 用量
   */
  recordUsage(sessionId: string, inputTokens: number, outputTokens: number): void {
    const usage = this.usageHistory.get(sessionId) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    usage.inputTokens += inputTokens;
    usage.outputTokens += outputTokens;
    usage.totalTokens += inputTokens + outputTokens;
    this.usageHistory.set(sessionId, usage);
  }

  /**
   * 获取 token 用量统计
   */
  getUsage(sessionId: string): TokenUsage | null {
    return this.usageHistory.get(sessionId) ?? null;
  }

  /**
   * 计算成本
   */
  calculateCost(sessionId: string): CostBreakdown | null {
    const usage = this.usageHistory.get(sessionId);
    if (!usage || !this.config.modelCosts) {
      return null;
    }

    const { inputCostPer1K, outputCostPer1K } = this.config.modelCosts;
    const inputCost = (usage.inputTokens / 1000) * inputCostPer1K;
    const outputCost = (usage.outputTokens / 1000) * outputCostPer1K;

    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    };
  }

  /**
   * 重置用量记录
   */
  resetUsage(sessionId: string): void {
    this.usageHistory.delete(sessionId);
  }

  /**
   * 获取所有会话的总用量
   */
  getTotalUsage(): TokenUsage {
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const usage of this.usageHistory.values()) {
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.totalTokens += usage.totalTokens;
    }
    return total;
  }

  /**
   * 获取上下文状态
   */
  async getContextStatus(sessionId: string): Promise<{
    currentTokens: number;
    maxTokens: number;
    usagePercent: number;
    messageCount: number;
    needsCompression: boolean;
  }> {
    const { totalTokens } = await this.buildContext(sessionId);
    const usagePercent = (totalTokens / this.config.maxContextTokens) * 100;

    return {
      currentTokens: totalTokens,
      maxTokens: this.config.maxContextTokens,
      usagePercent: Math.round(usagePercent * 100) / 100,
      messageCount: (await this.sessionManager.getMessages(sessionId)).length,
      needsCompression: usagePercent >= this.config.compressionThreshold * 100,
    };
  }
}

// 创建单例
let contextManager: ContextManager | null = null;

export function createContextManager(
  sessionManager: SessionManager,
  config?: Partial<ContextConfig>
): ContextManager {
  contextManager = new ContextManager(sessionManager, config);
  return contextManager;
}

export function getContextManager(): ContextManager | null {
  return contextManager;
}
