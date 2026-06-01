/**
 * 评分服务 — 多维度加权评分
 *
 * 实例健康评分通过 4 个加权维度（availability, performance, capacity, security）计算，
 * 权重在运行时从 scoring-config-service 读取。
 */

import { HealthCheckResult } from './database-service.js';

export interface DimensionScores {
  dimensions: Record<string, number>;
  total: number;
  checks: { name: string; status: string; score: number; message?: string; dimension: string | null }[];
}

/**
 * 每个检查项到维度的映射（按 DB 类型）
 *
 * 格式: checkName → dimension
 * 同一个检查名在不同 DB 类型下映射到同一维度（保持意图一致）
 */
export const DIMENSION_MAP: Record<string, Record<string, string>> = {
  mysql: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '慢查询': 'performance',
  },
  postgresql: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '缓存命中率': 'performance',
    '死锁检测': 'security',
  },
  oracle: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '表空间使用率': 'capacity',
    '库缓存命中率': 'performance',
    '死锁检测': 'security',
  },
  dameng: {
    '连接状态': 'availability',
    '连接数使用率': 'capacity',
    '缓冲池命中率': 'performance',
    '锁等待检测': 'performance',
    '死锁检测': 'security',
  },
};

const DIMENSION_NAMES = ['availability', 'performance', 'capacity', 'security'];

/**
 * 计算维度评分和加权总分
 *
 * @param checks - 健康检查条目列表
 * @param dbType - 数据库类型（mysql|postgresql|oracle|dameng）
 * @param weights - 四维度权重（availability, performance, capacity, security）
 * @returns 各维度分数和加权总分
 */
export function calculateDimensionScores(
  checks: HealthCheckResult['checks'],
  dbType: string,
  weights: Record<string, number>,
): DimensionScores {
  const dimensionMap = DIMENSION_MAP[dbType] || DIMENSION_MAP['mysql'];

  // 初始化各维度的分数列表
  const dimensionScores: Record<string, number[]> = {
    availability: [],
    performance: [],
    capacity: [],
    security: [],
  };

  // 为每个 check 添加 dimension 字段
  const checksWithDimension = checks.map((check) => {
    const dimension = dimensionMap[check.name] || null;
    if (dimension && dimensionScores[dimension]) {
      dimensionScores[dimension].push(check.score);
    }
    return { ...check, dimension };
  });

  // 计算结果中的检查列表包含 dimension 字段

  // 计算各维度平均分
  const dimensions: Record<string, number> = {};
  for (const dim of DIMENSION_NAMES) {
    const scores = dimensionScores[dim];
    if (scores.length > 0) {
      dimensions[dim] = Math.round(
        scores.reduce((sum, s) => sum + s, 0) / scores.length,
      );
    } else {
      // 该维度无对应检查项，赋中性值 100（RESEARCH.md Pitfall 1）
      dimensions[dim] = 100;
    }
  }

  // 加权总分
  const total = Math.round(
    DIMENSION_NAMES.reduce((sum, dim) => {
      return sum + (dimensions[dim] || 100) * (weights[dim] || 0);
    }, 0),
  );

  return { dimensions, total, checks: checksWithDimension };
}
