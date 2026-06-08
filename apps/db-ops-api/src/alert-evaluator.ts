/**
 * 告警规则评估器
 * 支持静态阈值、动态基线阈值、参数化宏变量（${var}），真实持续时间检查，动态实例发现。
 */
import { alertDatabaseService, AlertRule } from './alert-database-service';
import { metricsDatabaseService } from './metrics-database-service';
import { instanceDatabaseService } from './instance-database-service';
import { baselineCalculator } from './baseline-calculator';

export interface AlertRuleExtended extends AlertRule {
  dynamic_config?: {
    sigma?: number;
    lookback_days?: number;
  };
}

/**
 * 参数化阈值 — 解析 threshold_template 中的 ${var} 占位符
 *
 * 示例:
 *   template:  { warning: "${tps_warning}", error: 2000, critical: "${tps_critical}" }
 *   macros:    { tps_warning: 500, tps_critical: 5000 }
 *   结果:      { warning: 500, error: 2000, critical: 5000 }
 *
 * 未在 macros 中找到的变量返回 NaN，评估时跳过该级别。
 */
export function resolveThresholdTemplate(
  template: { warning?: number | string | null; error?: number | string | null; critical?: number | string | null } | null | undefined,
  macros: Record<string, number> = {}
): { warning: number; error: number; critical: number } | null {
  if (!template) return null;

  const resolve = (val: number | string | null | undefined): number => {
    if (val == null) return NaN;
    if (typeof val === 'number') return val;
    // 支持 ${VAR_NAME} 占位符
    const match = String(val).match(/^\$\{(\w+)\}$/);
    if (match) {
      const resolved = macros[match[1]];
      return resolved != null ? Number(resolved) : NaN;
    }
    return parseFloat(String(val));
  };

  const warning = resolve(template.warning);
  const error = resolve(template.error);
  const critical = resolve(template.critical);

  if (isNaN(warning) && isNaN(error) && isNaN(critical)) return null;
  return { warning, error, critical };
}

/**
 * 评估单个规则
 */
export function evaluateRule(rule: AlertRule, currentValue: number): boolean {
  const { operator, threshold } = rule;
  const numericValue = Number(currentValue);
  const numericThreshold = Number(threshold);

  switch (operator) {
    case '>': return numericValue > numericThreshold;
    case '<': return numericValue < numericThreshold;
    case '>=': return numericValue >= numericThreshold;
    case '<=': return numericValue <= numericThreshold;
    case '=': return numericValue === numericThreshold;
    case '!=': return numericValue !== numericThreshold;
    default: return false;
  }
}

/**
 * 获取指标值（所有值均用 Number 强制转换，数据缺失时返回 null）
 */
export function getMetricValue(metricName: string, metrics: any): number | null {
  if (!metrics) return null;
  // 1. Check fixed columns first (fast path, type-safe)
  if (metricName in metrics && typeof metrics[metricName] === 'number') {
    return metrics[metricName];
  }
  // 2. Fallback: check JSON-extracted metrics_data (D-15)
  if (metrics.metrics_data && typeof metrics.metrics_data === 'object') {
    const val = metrics.metrics_data[metricName];
    if (val != null) return Number(val);
  }
  // 3. Last resort: direct property access (catches any string-value cases)
  const val = metrics[metricName];
  return val != null ? Number(val) : null;
}

/**
 * 评估规则（三级阈值）— 返回触发的最高级别
 */
export function evaluateRuleWithLevels(
  rule: AlertRuleExtended,
  currentValue: number,
  macros?: Record<string, number>
): 'warning' | 'error' | 'critical' | null {
  // 阈值优先级：
  //   1. 规则显式 threshold（threshold_type='static' 且 threshold > 0）→ 单阈值评估
  //   2. 规则 threshold_template → 多级别模板评估（macros 解析 ${var} 占位符）
  //   3. metric_definition.threshold_template → 仅作为 macro 默认值，不覆盖规则阈值

  // static 规则有显式阈值时，直接使用单阈值评估，避免 threshold_template 覆盖
  if (rule.threshold_type !== 'dynamic' && rule.threshold > 0 && rule.threshold_template) {
    // 规则同时有显式 threshold 和 threshold_template，优先使用显式 threshold
    const triggered = evaluateRule(rule, currentValue);
    if (!triggered) return null;
    return rule.severity === 'critical' ? 'critical'
      : rule.severity === 'error' ? 'error'
      : 'warning';
  }

  // 先用 macros 解析阈值模板中的 ${var} 占位符
  const resolved = resolveThresholdTemplate(rule.threshold_template, macros);
  if (!resolved) {
    // Fallback to old single-threshold logic
    const triggered = evaluateRule(rule, currentValue);
    if (!triggered) return null;
    return rule.severity === 'critical' ? 'critical'
      : rule.severity === 'error' ? 'error'
      : 'warning';
  }

  const { warning: w, error: e, critical: c } = resolved;

  // Support both directions: >= (higher is worse) and <= (lower is worse)
  const isInverted = rule.operator === '<' || rule.operator === '<=' || rule.operator === '!=';
  const exceeds = isInverted
    ? (t: number) => currentValue <= t
    : (t: number) => currentValue >= t;

  if (!isNaN(c) && exceeds(c)) return 'critical';
  if (!isNaN(e) && exceeds(e)) return 'error';
  if (!isNaN(w) && exceeds(w)) return 'warning';
  return null;
}

/**
 * 检查持续时间 — 查询 metrics_history 最近 N 秒数据，验证所有数据点都满足条件
 */
export async function checkDuration(
  instanceId: number,
  rule: AlertRule,
  seconds: number = 60
): Promise<boolean> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - seconds * 1000);

  try {
    const history = await metricsDatabaseService.getHistoricalMetrics(instanceId, startTime, endTime);

    if (history.length === 0) {
      // 无历史数据，退化为检查当前值
      const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);
      if (!metrics) return false;
      const current = getMetricValue(rule.metric_name, metrics);
      if (current === null) return false;
      return evaluateRule(rule, current);
    }

    // 所有历史数据点都满足阈值条件才返回 true
    for (const record of history) {
      const value = getMetricValue(rule.metric_name, record);
      if (value === null) continue; // 缺失数据点跳过
      if (!evaluateRule(rule, value)) {
        return false;
      }
    }
    return true;
  } catch (error) {
    console.error(`检查持续时间失败 [实例 ${instanceId}]:`, error);
    // 降级：检查当前值
    const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);
    if (!metrics) return false;
    const current = getMetricValue(rule.metric_name, metrics);
    if (current === null) return false;
    return evaluateRule(rule, current);
  }
}

/**
 * 检查恢复持续时间 — 查询 metrics_history 最近 N 秒数据，验证所有数据点都处于健康范围
 * 与触发对称：触发需要持续超标，恢复也需要持续健康
 */
export async function checkRecoveryDuration(
  instanceId: number,
  rule: AlertRule,
  seconds: number = 60,
  macros?: Record<string, number>
): Promise<boolean> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - seconds * 1000);

  try {
    const history = await metricsDatabaseService.getHistoricalMetrics(instanceId, startTime, endTime);

    if (history.length === 0) {
      // 无历史数据，退化为检查当前值
      const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);
      if (!metrics) return false;
      const current = getMetricValue(rule.metric_name, metrics);
      if (current === null) return false;
      return isValueHealthy(current, rule, macros);
    }

    // 所有历史数据点都健康才返回 true
    for (const record of history) {
      const value = getMetricValue(rule.metric_name, record);
      if (value === null) continue;
      if (!isValueHealthy(value, rule, macros)) {
        return false;
      }
    }
    return true;
  } catch (error) {
    console.error(`检查恢复持续时间失败 [实例 ${instanceId}]:`, error);
    // 降级：检查当前值
    const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);
    if (!metrics) return false;
    const current = getMetricValue(rule.metric_name, metrics);
    if (current === null) return false;
    return isValueHealthy(current, rule, macros);
  }
}

/**
 * 获取动态阈值（如果规则为 dynamic 类型）
 * 返回 null 表示使用静态阈值
 */
async function resolveDynamicThreshold(
  instanceId: number,
  rule: AlertRuleExtended
): Promise<{ effectiveRule: AlertRule; threshold: number } | null> {
  if (rule.threshold_type !== 'dynamic') {
    return null;
  }

  try {
    const baseline = await baselineCalculator.getCachedBaseline(instanceId, rule.metric_name);
    if (baseline) {
      // 使用基线上界作为动态阈值
      const effectiveRule: AlertRule = {
        ...rule,
        operator: '>',
        threshold: baseline.upperBound,
      };
      return { effectiveRule, threshold: baseline.upperBound };
    }
  } catch (error) {
    console.error(`获取动态阈值失败 [${rule.metric_name} 实例 ${instanceId}]:`, error);
  }

  // 无缓存基线，退化为静态阈值
  return null;
}

/**
 * 检查指标值是否处于健康范围（未触发任何阈值级别）
 */
export function isValueHealthy(value: number, rule: AlertRule, macros?: Record<string, number>): boolean {
  const resolved = resolveThresholdTemplate(rule.threshold_template, macros);
  if (!resolved) return true; // no threshold = always healthy

  const { warning, error, critical } = resolved;
  const checkValue = (threshold: number): boolean => {
    if (isNaN(threshold)) return true;

    const op = rule.operator ?? '>=';
    switch (op) {
      case '>=': return value >= threshold;
      case '>': return value > threshold;
      case '<=': return value <= threshold;
      case '<': return value < threshold;
      case '=': return value === threshold;
      default: return true;
    }
  };

  // Healthy = does NOT trigger any level
  return !checkValue(critical) && !checkValue(error) && !checkValue(warning);
}

/**
 * 评估所有实例的所有规则
 */
export async function evaluateAllRules(): Promise<
  Array<{
    rule: AlertRule;
    instanceId: number;
    instanceName: string;
    currentValue: number;
    thresholdUsed: number;
  }>
> {
  const triggeredAlerts: Array<{
    rule: AlertRule;
    instanceId: number;
    instanceName: string;
    currentValue: number;
    thresholdUsed: number;
    triggeredLevel?: 'warning' | 'error' | 'critical';
  }> = [];

  try {
    const rules = await alertDatabaseService.getAlertRules(true) as AlertRuleExtended[];
    if (rules.length === 0) {
      return [];
    }

    // 动态发现所有活跃实例
    const instances = await instanceDatabaseService.getAllInstances();
    if (instances.length === 0) {
      console.warn('⚠️ 未找到任何活跃的数据库实例');
      return [];
    }

    for (const instance of instances) {
      const metrics = await metricsDatabaseService.getRealtimeMetrics(instance.id);

      // 检测指标是否过期：超过 10 分钟未更新视为不可达
      const STALE_THRESHOLD_MS = 10 * 60 * 1000;
      const isStale = metrics && (
        !metrics.recorded_at ||
        (Date.now() - new Date(metrics.recorded_at).getTime()) > STALE_THRESHOLD_MS
      );

      // 仅当实例 health_status='critical' 且指标过期 > 10min（或完全缺失）才创建可用性告警
      // 避免健康实例因采集间隔差异被误报（monitor-collector 心跳 10s + 定时采集 5min）
      if ((!metrics || isStale) && instance.health_status === 'critical') {
        const availabilityRule: AlertRule = {
          id: 0,
          name: 'Instance Availability',
          description: 'Auto-detected: instance is unreachable',
          metric_name: '_availability',
          operator: '>=',
          threshold: 1,
          severity: 'critical',
          enabled: true,
          duration_seconds: 0,
          silence_minutes: 5,
          threshold_template: null,
          threshold_type: 'static',
          notification_channels: null,
          dynamic_config: null,
          created_by: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        triggeredAlerts.push({
          rule: availabilityRule,
          instanceId: instance.id,
          instanceName: instance.name,
          currentValue: 0,
          thresholdUsed: 1,
          triggeredLevel: 'critical',
        });
        continue;
      }

      for (const rule of rules) {
        // Pre-filter: skip disabled rules
        if (!rule.enabled) continue;
        // Pre-filter: skip if rule is scoped to specific db_types and instance type doesn't match
        if (rule.db_types && rule.db_types.length > 0) {
          const instanceDbType = (instance as any).db_type;
          if (instanceDbType && !rule.db_types.includes(instanceDbType)) {
            continue;
          }
        }
        // Pre-filter: skip if rule is scoped to specific instances
        if (rule.instance_ids && rule.instance_ids.length > 0) {
          if (!rule.instance_ids.includes(instance.id)) {
            continue;
          }
        }

        const currentValue = getMetricValue(rule.metric_name, metrics);
        if (currentValue === null) continue; // 指标未采集，跳过此规则

        // 解析阈值（静态或动态）
        let effectiveRule = rule;
        let thresholdUsed = rule.threshold;
        const dynamicResult = await resolveDynamicThreshold(instance.id, rule);
        if (dynamicResult) {
          effectiveRule = dynamicResult.effectiveRule;
          thresholdUsed = dynamicResult.threshold;
        }

        // 解析 macros: 从指标定义的 threshold_template 取默认值（可被模板/实例覆盖）
        // 示例: metric_definition.threshold_template = {warning: 500, error: 2000, critical: 5000}
        //       → macros = { warning: 500, error: 2000, critical: 5000 }
        //       规则 threshold_template = {warning: "${warning}", error: "${error}", critical: 10000}
        //       → 解析后 {warning: 500, error: 2000, critical: 10000}
        const macroCtx = await resolveMacrosForRule(rule, instance.id);

        const triggeredLevel = evaluateRuleWithLevels(effectiveRule, currentValue, macroCtx);
        if (triggeredLevel) {
          const durationMet = await checkDuration(instance.id, rule, rule.duration_seconds);
          if (durationMet) {
            triggeredAlerts.push({
              rule: effectiveRule,
              instanceId: instance.id,
              instanceName: instance.name,
              currentValue,
              thresholdUsed,
              triggeredLevel,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('评估告警规则失败:', error);
  }

  return triggeredAlerts;
}

/**
 * 为规则解析 macros 上下文
 *
 * 优先级（由低到高）：
 *   1. metric_definition.threshold_template  → 指标默认值（示例: {warning: 500, error: 2000, critical: 5000}）
 *   2. metric_templates.macro_defaults       → 模板宏变量（示例: {tps_warning: 5000}）
 *   3. instance_templates.macro_overrides    → 实例覆盖（示例: {tps_warning: 100000}）
 *
 * 指标默认值的键自动作为 ${warning}, ${error}, ${critical} macro 变量可用。
 */
export async function resolveMacrosForRule(rule: AlertRule, instanceId: number): Promise<Record<string, number>> {
  const macros: Record<string, number> = {};

  // 1. 从 metric_definition 的 threshold_template 提取默认值
  try {
    const { metricRegistry } = require('./metric-registry');
    const def = metricRegistry.getById(rule.metric_name);
    if (def?.threshold_template) {
      const tt = def.threshold_template;
      if (tt.warning != null) macros.warning = Number(tt.warning);
      if (tt.error != null) macros.error = Number(tt.error);
      if (tt.critical != null) macros.critical = Number(tt.critical);
    }
  } catch { /* skip */ }

  // 2. 从模板 macro_defaults 加载（按规则所属模板，或实例关联的模板）
  try {
    const { templateDatabaseService } = require('./template-database-service');

    // 2a. 如果规则有 template_id，加载该模板的宏
    if (rule.template_id) {
      const tpl = await templateDatabaseService.getTemplate(rule.template_id);
      if (tpl?.macro_defaults) {
        Object.assign(macros, tpl.macro_defaults);
      }
    }

    // 2b. 加载实例关联的所有模板的宏（实例级绑定独立于规则级绑定）
    const links = await templateDatabaseService.getInstanceTemplates(instanceId);
    for (const link of links) {
      if (link.template?.macro_defaults) {
        Object.assign(macros, link.template.macro_defaults);
      }
    }

    // 3. 实例 macro_overrides（最高优先级）— 必须在模板 macro_defaults 之后
    for (const link of links) {
      if (link.macro_overrides) {
        Object.assign(macros, link.macro_overrides);
      }
    }
  } catch { /* template service not available, skip */ }

  return macros;
}

/** 从 metric_definition 的 threshold_template 加载默认 macros（供外部使用） */
export function loadMetricDefaultMacros(metricName: string, thresholdTemplate: { warning?: number; error?: number; critical?: number } | null): Record<string, number> {
  const macros: Record<string, number> = {};
  if (thresholdTemplate) {
    if (thresholdTemplate.warning != null) macros.warning = Number(thresholdTemplate.warning);
    if (thresholdTemplate.error != null) macros.error = Number(thresholdTemplate.error);
    if (thresholdTemplate.critical != null) macros.critical = Number(thresholdTemplate.critical);
  }
  return macros;
}
