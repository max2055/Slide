import { describe, expect, it } from 'vitest';
import {
  buildLegacyAlertMigrationPlan,
  LEGACY_REPLACEMENTS,
  validateReplacementDefinition,
  type LegacyAlertRuleRow,
  type LegacyMigrationState,
} from './legacy-alert-migration.js';

const GIB = 1_024 ** 3;

function rule(overrides: Partial<LegacyAlertRuleRow> & Pick<LegacyAlertRuleRow, 'id' | 'name' | 'metric_name'>): LegacyAlertRuleRow {
  return {
    description: null, operator: '>=', threshold: 1, threshold_template: null, duration_seconds: 60,
    severity: 'warning', enabled: true, db_types: ['mysql'], instance_ids: null, target_type: 'instance',
    server_id: null, network_device_id: null, template_id: 1, silence_minutes: 5, ...overrides,
  };
}

function state(overrides: Partial<LegacyMigrationState> = {}): LegacyMigrationState {
  return {
    rules: [
      rule({ id: 104, name: 'QPS 过高', metric_name: 'qps', threshold_template: { warning: 30000, error: 100000, critical: 200000 } }),
      rule({ id: 85, name: '磁盘使用率过高', metric_name: 'disk_usage', threshold_template: { warning: 80, error: 90, critical: 95 } }),
      rule({ id: 103, name: 'TPS 过高', metric_name: 'tps' }),
    ],
    templates: [
      { id: 1, name: 'MySQL-生产模板', db_type: 'mysql', enabled: true,
        macro_defaults: { qps_warning: 3000, qps_error: 8000, qps_critical: 15000, disk_warning: 80, disk_error: 90, disk_critical: 95, cpu_warning: 85 } },
      { id: 2, name: '只有 CPU', db_type: 'mysql', enabled: true, macro_defaults: { cpu_warning: 80 } },
    ],
    instance_templates: [{ instance_id: 1, template_id: 1, macro_overrides: { qps_warning: 3500 } }],
    ...overrides,
  };
}

describe('legacy alert migration plan (MAX-243)', () => {
  it('retires only qps/disk_usage and replaces them with the reviewed semantic metrics', () => {
    const plan = buildLegacyAlertMigrationPlan(state(), '2026-10-25T00:00:00.000Z');
    expect(plan.retire.map(item => item.rule_id)).toEqual([104, 85]);
    expect(plan.retire.find(item => item.rule_id === 103)).toBeUndefined();
    expect(plan.replacements.map(item => item.key)).toEqual(['qps', 'filesystem', 'database_size']);
    expect(plan.blockers).toEqual([]);

    const qps = plan.replacements.find(item => item.key === 'qps')!;
    expect(qps.action).toBe('create');
    expect(qps.definition).toMatchObject({
      metric_name: 'mysql.queries.per_second', unit: 'count/s', target_type: 'instance', db_types: ['mysql'],
      threshold_template: { warning: 2_000, error: 5_000, critical: 8_000 },
    });

    const filesystem = plan.replacements.find(item => item.key === 'filesystem')!;
    expect(filesystem.definition).toMatchObject({
      metric_name: 'linux.filesystem.used_ratio', unit: '1', target_type: 'server',
      threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 },
    });

    const size = plan.replacements.find(item => item.key === 'database_size')!;
    expect(size.definition).toMatchObject({
      metric_name: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 100 * GIB, error: 500 * GIB, critical: 1_000 * GIB },
    });
  });

  it('keeps the ratio and byte thresholds in their own units', () => {
    expect(LEGACY_REPLACEMENTS.filesystem.threshold_template).toEqual({ warning: 0.8, error: 0.9, critical: 0.95 });
    expect(LEGACY_REPLACEMENTS.database_size.threshold_template.warning).toBe(100 * GIB);
    expect(() => validateReplacementDefinition({
      ...LEGACY_REPLACEMENTS.filesystem,
      threshold: 80,
      threshold_template: { warning: 80, error: 90, critical: 95 },
    })).toThrow('RATIO_THRESHOLD_RANGE');
    expect(() => validateReplacementDefinition({
      ...LEGACY_REPLACEMENTS.database_size,
      threshold: 100.5,
      threshold_template: { warning: 100.5, error: 500, critical: 1_000 },
    })).toThrow('ABSOLUTE_THRESHOLD_INVALID');
    expect(() => validateReplacementDefinition(LEGACY_REPLACEMENTS.qps)).not.toThrow();
  });

  it('captures old template macros and instance overrides without treating them as new thresholds', () => {
    const plan = buildLegacyAlertMigrationPlan(state());
    const template = plan.macros.find(item => item.scope === 'template' && item.template_id === 1)!;
    expect(template.qps).toEqual({ qps_warning: 3_000, qps_error: 8_000, qps_critical: 15_000 });
    expect(template.disk).toEqual({ disk_warning: 80, disk_error: 90, disk_critical: 95 });
    expect(plan.macros.some(item => item.template_id === 2)).toBe(false);
    expect(plan.macros.find(item => item.scope === 'instance' && item.instance_id === 1)).toMatchObject({
      qps: { qps_warning: 3_500, qps_error: 8_000, qps_critical: 15_000 },
      overrides: { qps_warning: 3_500 },
    });
  });

  it('reuses an already marked replacement and refuses to create a second one for the same metric', () => {
    const marked = rule({ id: 200, name: 'QPS 过高 (mysql.queries.per_second)', metric_name: 'mysql.queries.per_second',
      description: '[MAX-243:qps] baseline 2026-10-25', threshold: 2_000,
      threshold_template: { warning: 2_000, error: 5_000, critical: 8_000 } });
    const plan = buildLegacyAlertMigrationPlan(state({ rules: [...state().rules, marked] }));
    const qps = plan.replacements.find(item => item.key === 'qps')!;
    expect(qps).toMatchObject({ action: 'reuse', existing_rule_id: 200, thresholds_match: true });
    expect(plan.blockers).toEqual([]);
  });

  it('blocks an unmarked same-metric rule and a marked rule with different thresholds', () => {
    const unmarked = rule({ id: 201, name: '自定义 QPS', metric_name: 'mysql.queries.per_second',
      threshold_template: { warning: 1, error: 2, critical: 3 } });
    const blocked = buildLegacyAlertMigrationPlan(state({ rules: [...state().rules, unmarked] }));
    expect(blocked.blockers).toContain('REPLACEMENT_METRIC_ALREADY_CONFIGURED:qps:201');

    const marked = rule({ id: 202, name: 'QPS 过高 (mysql.queries.per_second)', metric_name: 'mysql.queries.per_second',
      description: '[MAX-243:qps]', threshold_template: { warning: 1, error: 2, critical: 3 } });
    const divergent = buildLegacyAlertMigrationPlan(state({ rules: [...state().rules, marked] }));
    expect(divergent.blockers).toContain('REPLACEMENT_THRESHOLDS_DIFFER:qps:202');
  });

  it('only plans qps when no disk_usage rule exists and vice versa', () => {
    const qpsOnly = buildLegacyAlertMigrationPlan(state({ rules: [state().rules[0]] }));
    expect(qpsOnly.replacements.map(item => item.key)).toEqual(['qps']);
    const diskOnly = buildLegacyAlertMigrationPlan(state({ rules: [state().rules[1]] }));
    expect(diskOnly.replacements.map(item => item.key)).toEqual(['filesystem', 'database_size']);
  });
});
