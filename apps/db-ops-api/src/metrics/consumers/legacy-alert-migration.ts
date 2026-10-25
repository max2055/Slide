import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/**
 * MAX-243 / issue #6 legacy template migration.
 *
 * The legacy `qps` and `disk_usage` alert rules and template macros cannot be
 * renamed onto the semantic metrics: the old expressions are still blocked
 * with CUSTOM_EXPRESSION_REVIEW_REQUIRED. This module replaces them with
 * explicit rules whose metric identity, unit and thresholds match the
 * reviewed semantic metrics.
 *
 * Rules are disabled first and only deleted after the replacements exist.
 * Every mutation writes an audit_log_entries row in the same transaction, so
 * deleting a rule never deletes the evidence of its original definition.
 */

export const LEGACY_MIGRATION_ID = 'MAX-243';
export type ReplacementKey = 'qps' | 'filesystem' | 'database_size';
export type LegacyMigrationPhase = 'disable' | 'delete';

const GIB = 1_024 ** 3;
const MARKER_PREFIX = `[${LEGACY_MIGRATION_ID}:`;

export interface ReplacementThresholds {
  warning: number;
  error: number;
  critical: number;
}

export interface ReplacementRuleDefinition {
  key: ReplacementKey;
  name: string;
  metric_name: string;
  unit: 'count/s' | '1' | 'By';
  target_type: 'instance' | 'server';
  db_types: string[] | null;
  operator: '>=';
  threshold: number;
  threshold_template: ReplacementThresholds;
  duration_seconds: number;
  severity: 'warning';
  silence_minutes: number;
  description: string;
}

/**
 * Real-baseline thresholds recorded on 2026-10-25 for instance:1 + server:3.
 * - mysql.queries.per_second: 368 valid samples, p99 751.78, max 782.75
 *   (warning 2,000 / error 5,000 / critical 8,000).
 * - linux.filesystem.used_ratio is a 0..1 ratio; the legacy 80/90/95 values
 *   become 0.80/0.90/0.95 (issue #256), never 80/90/95.
 * - mysql.tables.estimated_allocated_bytes keeps absolute byte thresholds;
 *   the existing `data_size_gb` convention (100/500/1000 GiB) is reused.
 */
export const LEGACY_REPLACEMENTS: Readonly<Record<ReplacementKey, ReplacementRuleDefinition>> = Object.freeze({
  qps: {
    key: 'qps',
    name: 'QPS 过高 (mysql.queries.per_second)',
    metric_name: 'mysql.queries.per_second',
    unit: 'count/s',
    target_type: 'instance',
    db_types: ['mysql'],
    operator: '>=',
    threshold: 2_000,
    threshold_template: { warning: 2_000, error: 5_000, critical: 8_000 },
    duration_seconds: 300,
    severity: 'warning',
    silence_minutes: 5,
    description: `${MARKER_PREFIX}qps] 旧 qps 表达式保持 blocked；仅使用带计数器代次的派生速率 mysql.queries.per_second (count/s)。阈值按 2026-10-25 真实基线重定（valid 368, p99 751.78, max 782.75），不是旧的 3000/8000/15000。`,
  },
  filesystem: {
    key: 'filesystem',
    name: '文件系统使用率过高 (linux.filesystem.used_ratio)',
    metric_name: 'linux.filesystem.used_ratio',
    unit: '1',
    target_type: 'server',
    db_types: null,
    operator: '>=',
    threshold: 0.8,
    threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 },
    duration_seconds: 300,
    severity: 'warning',
    silence_minutes: 5,
    description: `${MARKER_PREFIX}filesystem] 旧 disk_usage 百分比规则由文件系统真实 used/size 派生比率替代；unit=1，阈值 0.80/0.90/0.95（不是 80/90/95）。旧 80/90/95 不移动到库大小。`,
  },
  database_size: {
    key: 'database_size',
    name: '数据库大小过高 (mysql.tables.estimated_allocated_bytes)',
    metric_name: 'mysql.tables.estimated_allocated_bytes',
    unit: 'By',
    target_type: 'instance',
    db_types: ['mysql'],
    operator: '>=',
    threshold: 100 * GIB,
    threshold_template: { warning: 100 * GIB, error: 500 * GIB, critical: 1_000 * GIB },
    duration_seconds: 300,
    severity: 'warning',
    silence_minutes: 5,
    description: `${MARKER_PREFIX}database_size] information_schema 估算分配字节（estimated，不是主机磁盘使用率）。绝对字节阈值沿用原有 data_size_gb 的 100/500/1000 GiB 口径，旧 80/90/95 不平移。`,
  },
});

const REPLACEMENT_ORDER: ReplacementKey[] = ['qps', 'filesystem', 'database_size'];

export interface LegacyAlertRuleRow {
  id: number;
  name: string;
  description: string | null;
  metric_name: string;
  operator: string;
  threshold: number;
  threshold_template: unknown;
  duration_seconds: number;
  severity: string;
  enabled: boolean;
  db_types: unknown;
  instance_ids: unknown;
  target_type: string | null;
  server_id: number | null;
  network_device_id: number | null;
  template_id: number | null;
  silence_minutes: number | null;
}

export interface LegacyMetricTemplateRow {
  id: number;
  name: string;
  db_type: string;
  macro_defaults: unknown;
  enabled: boolean;
}

export interface LegacyInstanceTemplateRow {
  instance_id: number;
  template_id: number;
  macro_overrides: unknown;
}

export interface LegacyMigrationState {
  rules: LegacyAlertRuleRow[];
  templates: LegacyMetricTemplateRow[];
  instance_templates: LegacyInstanceTemplateRow[];
}

export interface PlannedReplacement {
  key: ReplacementKey;
  action: 'create' | 'reuse';
  existing_rule_id: number | null;
  thresholds_match: boolean;
  definition: ReplacementRuleDefinition;
}

export interface PlannedRetirement {
  rule_id: number;
  name: string;
  metric_name: string;
  target_type: string | null;
  enabled: boolean;
  reason: string;
  replacement_keys: ReplacementKey[];
}

export interface LegacyMacroSnapshot {
  scope: 'template' | 'instance';
  template_id: number;
  template_name: string | null;
  instance_id: number | null;
  qps: Record<string, number>;
  disk: Record<string, number>;
  overrides: Record<string, number> | null;
}

export interface LegacyAlertMigrationPlan {
  migration: string;
  generated_at: string;
  retire: PlannedRetirement[];
  replacements: PlannedReplacement[];
  macros: LegacyMacroSnapshot[];
  blockers: string[];
}

const LEGACY_METRICS = new Set(['qps', 'disk_usage']);

function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; }
    catch { return {}; }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {};
}

function numericMacros(value: unknown, prefix: 'qps' | 'disk'): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(parseObject(value))) {
    if (!key.startsWith(`${prefix}_`)) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) result[key] = n;
  }
  return result;
}

function replacementMarker(key: ReplacementKey): string {
  return `${MARKER_PREFIX}${key}]`;
}

export function hasReplacementMarker(description: string | null | undefined, key: ReplacementKey): boolean {
  return Boolean(description?.includes(replacementMarker(key)));
}

function sameThresholds(value: unknown, expected: ReplacementThresholds): boolean {
  const parsed = parseObject(value);
  return Number(parsed.warning) === expected.warning
    && Number(parsed.error) === expected.error
    && Number(parsed.critical) === expected.critical;
}

export function validateReplacementDefinition(definition: ReplacementRuleDefinition): void {
  const { warning, error, critical } = definition.threshold_template;
  if (![warning, error, critical].every(Number.isFinite)) throw new Error('LEGACY_REPLACEMENT_THRESHOLD_INVALID');
  if (!(warning < error && error < critical)) throw new Error('LEGACY_REPLACEMENT_THRESHOLD_ORDER');
  if (definition.threshold !== warning) throw new Error('LEGACY_REPLACEMENT_THRESHOLD_BASE');
  if (definition.unit === '1') {
    if (![warning, error, critical].every(value => value > 0 && value <= 1)) throw new Error('RATIO_THRESHOLD_RANGE');
  } else if (![warning, error, critical].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('ABSOLUTE_THRESHOLD_INVALID');
  }
}

const retireReasons: Record<string, { reason: string; keys: ReplacementKey[] }> = {
  qps: {
    reason: '旧 qps 表达式仍为 CUSTOM_EXPRESSION_REVIEW_REQUIRED；不得改名后继续沿用旧阈值',
    keys: ['qps'],
  },
  disk_usage: {
    reason: '旧 disk_usage 把估算分配字节当百分比；拆分为文件系统比率与库大小两个明确指标',
    keys: ['filesystem', 'database_size'],
  },
};

export function buildLegacyAlertMigrationPlan(state: LegacyMigrationState, at = new Date().toISOString()): LegacyAlertMigrationPlan {
  const retire = state.rules
    .filter(rule => LEGACY_METRICS.has(rule.metric_name))
    .map(rule => {
      const mapping = retireReasons[rule.metric_name];
      return {
        rule_id: rule.id,
        name: rule.name,
        metric_name: rule.metric_name,
        target_type: rule.target_type,
        enabled: rule.enabled,
        reason: mapping.reason,
        replacement_keys: mapping.keys,
      };
    });

  const required = new Set<ReplacementKey>();
  for (const item of retire) for (const key of item.replacement_keys) required.add(key);

  const replacements: PlannedReplacement[] = [];
  const blockers: string[] = [];
  for (const key of REPLACEMENT_ORDER) {
    if (!required.has(key)) continue;
    const definition = LEGACY_REPLACEMENTS[key];
    validateReplacementDefinition(definition);
    const sameMetric = state.rules.filter(rule => rule.metric_name === definition.metric_name
      && (rule.target_type ?? 'instance') === definition.target_type);
    const marked = sameMetric.find(rule => hasReplacementMarker(rule.description, key));
    const existing = marked ?? sameMetric[0];
    const thresholdsMatch = existing ? sameThresholds(existing.threshold_template, definition.threshold_template) : false;
    if (!marked && existing) blockers.push(`REPLACEMENT_METRIC_ALREADY_CONFIGURED:${key}:${existing.id}`);
    if (marked && !thresholdsMatch) blockers.push(`REPLACEMENT_THRESHOLDS_DIFFER:${key}:${existing!.id}`);
    replacements.push({ key, action: existing ? 'reuse' : 'create', existing_rule_id: existing?.id ?? null,
      thresholds_match: thresholdsMatch, definition });
  }

  const macros: LegacyMacroSnapshot[] = [];
  for (const template of state.templates) {
    const qps = numericMacros(template.macro_defaults, 'qps');
    const disk = numericMacros(template.macro_defaults, 'disk');
    if (!Object.keys(qps).length && !Object.keys(disk).length) continue;
    macros.push({ scope: 'template', template_id: template.id, template_name: template.name,
      instance_id: null, qps, disk, overrides: null });
  }
  for (const binding of state.instance_templates) {
    const template = state.templates.find(item => item.id === binding.template_id);
    const merged = { ...parseObject(template?.macro_defaults), ...parseObject(binding.macro_overrides) };
    const qps = numericMacros(merged, 'qps');
    const disk = numericMacros(merged, 'disk');
    if (!Object.keys(qps).length && !Object.keys(disk).length) continue;
    const overrides = Object.fromEntries(Object.entries(parseObject(binding.macro_overrides))
      .filter(([key, value]) => /^(qps|disk)_/.test(key) && Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Number(value)]));
    macros.push({ scope: 'instance', template_id: binding.template_id, template_name: template?.name ?? null,
      instance_id: binding.instance_id, qps, disk,
      overrides: Object.keys(overrides).length ? overrides : null });
  }

  return { migration: LEGACY_MIGRATION_ID, generated_at: at, retire, replacements, macros, blockers };
}

type Queryable = Pick<Pool | PoolConnection, 'query' | 'execute'>;

export async function readLegacyAlertMigrationState(db: Queryable, lock = false): Promise<LegacyMigrationState> {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [rules] = await db.query<RowDataPacket[]>(`SELECT id, name, description, metric_name, operator, threshold,
      threshold_template, duration_seconds, severity, enabled, db_types, instance_ids, target_type,
      server_id, network_device_id, template_id, silence_minutes
    FROM alert_rules ORDER BY id${suffix}`);
  const [templates] = await db.query<RowDataPacket[]>(`SELECT id, name, db_type, macro_defaults, enabled
    FROM metric_templates ORDER BY id`);
  const [instanceTemplates] = await db.query<RowDataPacket[]>(`SELECT instance_id, template_id, macro_overrides
    FROM instance_templates ORDER BY instance_id, template_id`);
  return {
    rules: rules.map(row => ({ ...row, threshold: Number(row.threshold), enabled: Boolean(row.enabled) })) as LegacyAlertRuleRow[],
    templates: templates.map(row => ({ ...row, enabled: Boolean(row.enabled) })) as LegacyMetricTemplateRow[],
    instance_templates: instanceTemplates.map(row => ({ ...row,
      macro_overrides: typeof row.macro_overrides === 'string' ? JSON.parse(row.macro_overrides) : row.macro_overrides,
    })) as LegacyInstanceTemplateRow[],
  };
}

export interface LegacyMigrationActor { userId?: string; username?: string }
export interface ApplyLegacyAlertMigrationOptions { actor?: LegacyMigrationActor; at?: Date }
export interface LegacyAlertMigrationResult {
  phase: LegacyMigrationPhase;
  created_rule_ids: number[];
  reused_rule_ids: number[];
  disabled_rule_ids: number[];
  already_disabled_rule_ids: number[];
  deleted_rule_ids: number[];
  audit_entries: string[];
  plan: LegacyAlertMigrationPlan;
}

async function writeAudit(db: Queryable, input: { action: string; ruleId: number; level: 'info' | 'warning';
  actor?: LegacyMigrationActor; details: Record<string, unknown>; at: Date }): Promise<string> {
  const id = `audit_${input.at.getTime().toString(36)}_${randomUUID().slice(0, 8)}`;
  await db.execute(`INSERT INTO audit_log_entries
    (id, event_type, level, user_id, username, user_role, action, resource_type, resource_id,
     details_json, approval_request_id, client_ip, user_agent, result, error_message, timestamp_ms)
    VALUES (?, 'config_change', ?, ?, ?, NULL, ?, 'alert_rule', ?, ?, NULL, NULL, NULL, 'success', NULL, ?)`,
    [id, input.level, input.actor?.userId ?? null, input.actor?.username ?? null, input.action, String(input.ruleId),
      JSON.stringify({ migration: LEGACY_MIGRATION_ID, ...input.details }), input.at.getTime()]);
  return id;
}

async function insertReplacement(db: Queryable, definition: ReplacementRuleDefinition): Promise<number> {
  const [result] = await db.execute<ResultSetHeader>(`INSERT INTO alert_rules
    (name, description, metric_name, operator, threshold, threshold_template, duration_seconds, severity,
     enabled, silence_minutes, db_types, instance_ids, template_id, target_type, server_id, network_device_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, NULL, NULL, ?, NULL, NULL, NULL)`,
    [definition.name, definition.description, definition.metric_name, definition.operator, definition.threshold,
      JSON.stringify(definition.threshold_template), definition.duration_seconds, definition.severity,
      definition.silence_minutes, definition.db_types ? JSON.stringify(definition.db_types) : null,
      definition.target_type]);
  return Number(result.insertId);
}

export async function applyLegacyAlertMigration(pool: Pool, phase: LegacyMigrationPhase,
  options: ApplyLegacyAlertMigrationOptions = {}): Promise<LegacyAlertMigrationResult> {
  const at = options.at ?? new Date();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const state = await readLegacyAlertMigrationState(connection, true);
    const plan = buildLegacyAlertMigrationPlan(state, at.toISOString());
    if (plan.blockers.length) throw new Error(plan.blockers[0].split(':')[0]);
    const result: LegacyAlertMigrationResult = { phase, created_rule_ids: [], reused_rule_ids: [],
      disabled_rule_ids: [], already_disabled_rule_ids: [], deleted_rule_ids: [], audit_entries: [], plan };

    if (phase === 'disable') {
      for (const replacement of plan.replacements) {
        if (replacement.action === 'reuse') { result.reused_rule_ids.push(replacement.existing_rule_id!); continue; }
        const ruleId = await insertReplacement(connection, replacement.definition);
        result.created_rule_ids.push(ruleId);
        result.audit_entries.push(await writeAudit(connection, { action: 'create_legacy_migration_alert_rule',
          ruleId, level: 'info', actor: options.actor, at,
          details: { phase, replacement_key: replacement.key, rule: replacement.definition } }));
      }
      for (const retirement of plan.retire) {
        const current = state.rules.find(rule => rule.id === retirement.rule_id)!;
        if (!current.enabled) { result.already_disabled_rule_ids.push(current.id); continue; }
        await connection.execute('UPDATE alert_rules SET enabled = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [current.id]);
        result.disabled_rule_ids.push(current.id);
        result.audit_entries.push(await writeAudit(connection, { action: 'disable_legacy_alert_rule',
          ruleId: current.id, level: 'warning', actor: options.actor, at,
          details: { phase, before: current, after: { ...current, enabled: false },
            replacement_keys: retirement.replacement_keys, reason: retirement.reason } }));
      }
    } else {
      const missing = plan.replacements.filter(replacement => replacement.action === 'create'
        || !replacement.thresholds_match || !state.rules.find(rule => rule.id === replacement.existing_rule_id)?.enabled);
      if (missing.length) throw new Error('LEGACY_MIGRATION_REPLACEMENTS_MISSING');
      for (const retirement of plan.retire) {
        const current = state.rules.find(rule => rule.id === retirement.rule_id);
        if (!current) continue;
        if (current.enabled) throw new Error('LEGACY_RULE_NOT_DISABLED');
        result.audit_entries.push(await writeAudit(connection, { action: 'delete_legacy_alert_rule',
          ruleId: current.id, level: 'warning', actor: options.actor, at,
          details: { phase, before: current, replacement_keys: retirement.replacement_keys, reason: retirement.reason } }));
        await connection.execute('DELETE FROM alert_rules WHERE id = ? AND enabled = FALSE', [current.id]);
        result.deleted_rule_ids.push(current.id);
      }
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
