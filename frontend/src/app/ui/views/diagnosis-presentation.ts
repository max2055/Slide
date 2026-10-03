// Presentation only: unknown values remain explicit; no health inference from inventory status.
export const diagnosisLabels: Record<string, string> = {
  cpu: 'CPU 使用率', cpu_usage: 'CPU 使用率', memory_usage: '内存使用率', disk_usage: '磁盘使用率',
  observation: '自动观测', invariant: '规则评估', expectation: '统计评估', history: '历史记录',
  inference: '推论（待人工确认）', hypothesis: '假设（待人工确认）',
  pass: '符合配置范围', fail: '超出配置范围', unknown: '无法判断', deviation: '偏离历史基线', 'within-range': '在历史基线范围内',
};
export const diagnosisGaps: Record<string, [string, string]> = {
  NO_EVIDENCE_IN_WINDOW: ['所选时间范围没有证据', '检查采集是否启用，采集后刷新证据'],
  OBSERVATIONS_EMPTY: ['缺少观测数据', '检查采集连接和权限，采集后刷新证据'],
  OBSERVATIONS_UNAVAILABLE: ['观测数据读取失败', '检查采集服务和连接，恢复后刷新证据'],
  EVIDENCE_STALE: ['观测已过期', '采集最新数据后刷新证据'],
  OBSERVATIONS_STALE: ['观测已过期', '采集最新数据后刷新证据'],
  OBSERVATION_TIME_UNKNOWN: ['观测时间无法确认', '检查采集时间和时钟后刷新证据'],
  OBSERVATION_INVALID: ['观测数据不符合要求', '检查采集数据格式后刷新证据'],
  EVIDENCE_QUALITY_UNKNOWN: ['证据质量未知', '检查采集来源和缺失值后刷新证据'],
  EVIDENCE_QUALITY_DEGRADED: ['证据质量降级', '检查采集连接与缺失样本后刷新证据'],
  EVIDENCE_QUALITY_INVALID: ['证据无效', '修复采集数据后刷新证据'],
  RELATIONS_EMPTY: ['尚未建立资源关系', '核对资源关系后重新获取关联证据'],
  ALERTS_EMPTY: ['没有可用告警记录', '结合当前观测核对告警规则'],
  EVIDENCE_PACK_TRUNCATED: ['证据未完整返回', '缩小分析时间或资源范围后重新查询'],
  RELATED_EVIDENCE_UNAVAILABLE: ['关联资源证据不可用', '核对关联资源权限与采集状态'],
  BASELINE_SHORT: ['历史样本不足', '积累更多采集样本后重新评估'],
  INSUFFICIENT_BASELINE: ['历史样本不足或当前观测不可用', '检查当前观测，并积累更多历史样本后重新评估'],
  MISSING_INPUT: ['缺少评估输入', '补充规则需要的指标后重新评估'],
  FRESH_NUMERIC_EVIDENCE_REQUIRED: ['缺少有效期内的数值证据', '采集规则需要的指标后刷新证据'],
  CONSTRAINT_SATISFIED: ['观测值符合配置范围', '持续观测；符合规则不等于业务恢复'],
  CONSTRAINT_VIOLATED: ['观测值超出配置范围', '核对规则上下界和原始观测，再确认处理方案'],
  STATISTICAL_COMPARISON_NOT_BUSINESS_CONSTRAINT: ['仅与历史统计基线比较', '结合业务阈值人工确认；统计偏离不等于故障'],
};
export const gapExplanation = (code: string): [string, string] => diagnosisGaps[code] ?? ['部分证据无法确认', '查看技术详情，核对采集状态和访问权限'];
export const displayTime = (value?: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
export function evidenceFreshness(item: { observedAt: string | null; validUntil: string | null }, now = Date.now()) {
  const observed = Date.parse(item.observedAt ?? '');
  const expiry = Date.parse(item.validUntil ?? '');
  return !Number.isFinite(observed) || observed > now ? '时间未知'
    : !Number.isFinite(expiry) ? '有效期未知' : expiry <= observed ? '有效期无效' : expiry <= now ? '已过期' : '新鲜';
}
