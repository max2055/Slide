/**
 * 从正式指标评估实例规则及其恢复条件。
 */
import { evaluateOperationalRule } from './metrics/consumers/operational.js';
import { alertDatabaseService, type AlertRule } from './alert-database-service';
import { instanceDatabaseService } from './instance-database-service';
import { metricRegistry } from './metric-registry';

/**
 * 使用正式指标评估健康状态是否满足恢复持续时间。
 * 与触发对称：触发需要持续超标，恢复也需要持续健康
 */
export async function checkRecoveryDuration(
  instanceId: number,
  rule: AlertRule,
  seconds: number = 60,
  macros?: Record<string, number>
): Promise<boolean> {
    const result=await evaluateOperationalRule({type:'instance',id:instanceId},rule,seconds,macros);
    return result.recovery === true;
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
    semanticMigration?: unknown;
  }>
> {
  const triggeredAlerts: Array<{
    rule: AlertRule;
    instanceId: number;
    instanceName: string;
    currentValue: number;
    thresholdUsed: number;
    semanticMigration?: unknown;
    triggeredLevel?: 'warning' | 'error' | 'critical';
  }> = [];

  try {
    const rules = (await alertDatabaseService.getAlertRules(true)).filter((rule) => !rule.target_type || rule.target_type === 'instance');
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

        const semantic = await evaluateOperationalRule({ type: 'instance', id: instance.id }, rule, rule.duration_seconds,
          await resolveMacrosForRule(rule));
        if (semantic.level && semantic.value !== null) triggeredAlerts.push({ rule, instanceId:instance.id,
          instanceName:instance.name,currentValue:semantic.value,thresholdUsed:rule.threshold,triggeredLevel:semantic.level,semanticMigration:semantic.migration });
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
 * 从 metric_definition.threshold_template 提取默认值（示例: {warning: 500, error: 2000, critical: 5000}）
 * 指标默认值的键自动作为 ${warning}, ${error}, ${critical} macro 变量可用。
 */
export async function resolveMacrosForRule(rule: AlertRule): Promise<Record<string, number>> {
  const macros: Record<string, number> = {};

  // 从 metric_definition 的 threshold_template 提取默认值
  try {
    const def = metricRegistry.getById(rule.metric_name);
    if (def?.threshold_template) {
      const tt = def.threshold_template;
      if (tt.warning != null) macros.warning = Number(tt.warning);
      if (tt.error != null) macros.error = Number(tt.error);
      if (tt.critical != null) macros.critical = Number(tt.critical);
    }
  } catch { /* skip */ }

  return macros;
}
