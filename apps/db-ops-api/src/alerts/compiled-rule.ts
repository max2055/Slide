export type AlertTargetType = 'instance' | 'server';
export type AlertLevel = 'warning' | 'error' | 'critical';
export type AlertOperator = '>' | '<' | '>=' | '<=' | '=' | '!=';

export interface CompiledAlertRule {
  targetType: AlertTargetType;
  metricId: string;
  operator: AlertOperator;
  thresholds: Partial<Record<AlertLevel, number>>;
  durationSeconds: number;
  recoverySeconds: number;
  silenceMinutes: number;
}

type RawRule = { target_type?: AlertTargetType; metric_name: string; operator: AlertOperator; threshold: number; threshold_template?: Partial<Record<AlertLevel, number | string>> | null; severity: AlertLevel | 'info'; duration_seconds?: number; silence_minutes?: number; recovery_seconds?: number };

export function compileAlertRule(rule: RawRule, targetType: AlertTargetType, macros: Record<string, number> = {}): CompiledAlertRule {
  if (rule.target_type && rule.target_type !== targetType) throw new Error('ALERT_RULE_TARGET_MISMATCH');
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(rule.metric_name)) throw new Error('ALERT_RULE_METRIC_INVALID');
  if (!['>', '<', '>=', '<=', '=', '!='].includes(rule.operator)) throw new Error('ALERT_RULE_OPERATOR_INVALID');
  const thresholds: Partial<Record<AlertLevel, number>> = {};
  for (const level of ['warning', 'error', 'critical'] as const) {
    const source = rule.threshold_template?.[level];
    const macro = typeof source === 'string' && /^\$\{(\w+)\}$/.exec(source);
    const value = macro ? macros[macro[1]] : source === undefined || source === null ? undefined : Number(source);
    if (value !== undefined && Number.isFinite(value)) thresholds[level] = value;
  }
  if (Object.keys(thresholds).length === 0 && Number.isFinite(Number(rule.threshold))) thresholds[rule.severity === 'info' ? 'warning' : rule.severity] = Number(rule.threshold);
  if (Object.keys(thresholds).length === 0) throw new Error('ALERT_RULE_THRESHOLD_INVALID');
  return { targetType, metricId: rule.metric_name, operator: rule.operator, thresholds, durationSeconds: Math.max(0, Number(rule.duration_seconds ?? 0)), recoverySeconds: Math.max(0, Number(rule.recovery_seconds ?? rule.duration_seconds ?? 0)), silenceMinutes: Math.max(0, Number(rule.silence_minutes ?? 0)) };
}

export function evaluateCompiledRule(rule: CompiledAlertRule, value: number): AlertLevel | null {
  const matches = (threshold: number) => {
    switch (rule.operator) {
      case '>': return value > threshold; case '>=': return value >= threshold;
      case '<': return value < threshold; case '<=': return value <= threshold;
      case '=': return value === threshold; case '!=': return value !== threshold;
    }
  };
  for (const level of ['critical', 'error', 'warning'] as const) if (rule.thresholds[level] !== undefined && matches(rule.thresholds[level]!)) return level;
  return null;
}
