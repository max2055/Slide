import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import {
  applyLegacyAlertMigration,
  buildLegacyAlertMigrationPlan,
  readLegacyAlertMigrationState,
} from './legacy-alert-migration.js';

const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value as any;
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);

describe.skipIf(!port)('legacy alert migration (MAX-243)', () => {
  const database = `max243_alerts_${process.pid}`;
  let root: Pool, pool: Pool;

  const seed = async () => {
    await pool.execute(`INSERT INTO database_instances
      (id, name, host, port, username, password_encrypted, db_type, db_version, status)
      VALUES (1, 'MAX-243 fixture', '127.0.0.1', 3306, 'fixture', '', 'mysql', '9.6.0', 'active')`);
    await pool.execute(`INSERT INTO metric_templates (id, name, db_type, macro_defaults, enabled)
      VALUES (1, 'MySQL-生产模板', 'mysql', ?, TRUE)`, [JSON.stringify({ qps_warning: 3000, qps_error: 8000,
        qps_critical: 15000, disk_warning: 80, disk_error: 90, disk_critical: 95 })]);
    await pool.execute('INSERT INTO instance_templates (instance_id, template_id, macro_overrides) VALUES (1, 1, ?)',
      [JSON.stringify({ qps_warning: 3500 })]);
    await pool.execute(`INSERT INTO alert_rules
      (id, name, metric_name, operator, threshold, threshold_template, duration_seconds, severity, enabled, db_types, target_type, silence_minutes)
      VALUES (104, 'QPS 过高', 'qps', '>=', 30000, ?, 60, 'warning', TRUE, ?, 'instance', 5),
             (85, '磁盘使用率过高', 'disk_usage', '>=', 80, ?, 300, 'warning', TRUE, ?, 'instance', 5),
             (120, '服务器磁盘旧规则', 'disk_usage', '>=', 80, ?, 300, 'warning', TRUE, NULL, 'server', 5)`,
      [JSON.stringify({ warning: 30000, error: 100000, critical: 200000 }), JSON.stringify(['mysql']),
        JSON.stringify({ warning: 80, error: 90, critical: 95 }), JSON.stringify(['mysql']),
        JSON.stringify({ warning: 80, error: 90, critical: 95 })]);
  };

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 120000);

  afterAll(async () => {
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });

  beforeEach(async () => {
    for (const table of ['alert_rules', 'instance_templates', 'metric_templates', 'database_instances', 'audit_log_entries']) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await seed();
  });

  it('disables, then deletes, with one audit row per mutation and no renamed legacy definition', async () => {
    const plan = buildLegacyAlertMigrationPlan(await readLegacyAlertMigrationState(pool));
    expect(plan.retire.map(item => item.rule_id)).toEqual([85, 104, 120]);
    expect(plan.replacements.map(item => item.definition.metric_name)).toEqual([
      'mysql.queries.per_second', 'linux.filesystem.used_ratio', 'mysql.tables.estimated_allocated_bytes',
    ]);
    expect(plan.macros.find(item => item.scope === 'instance')!.qps.qps_warning).toBe(3500);

    const disabled = await applyLegacyAlertMigration(pool, 'disable', { actor: { userId: '0', username: 'max243-test' } });
    expect(disabled.created_rule_ids).toHaveLength(3);
    expect([...disabled.disabled_rule_ids].sort((a, b) => a - b)).toEqual([85, 104, 120]);
    expect(disabled.audit_entries).toHaveLength(6);

    const [oldRules] = await pool.query<any[]>('SELECT id, enabled FROM alert_rules WHERE id IN (85,104,120) ORDER BY id');
    expect(oldRules.map(row => [row.id, Boolean(row.enabled)])).toEqual([[85, false], [104, false], [120, false]]);
    const [newRules] = await pool.query<any[]>(`SELECT id, metric_name, enabled, threshold_template FROM alert_rules
      WHERE description LIKE '%[MAX-243:%' ORDER BY metric_name`);
    expect(newRules).toHaveLength(3);
    expect(newRules.every(row => Boolean(row.enabled))).toBe(true);
    expect(json(newRules.find(row => row.metric_name === 'linux.filesystem.used_ratio').threshold_template))
      .toEqual({ warning: 0.8, error: 0.9, critical: 0.95 });

    const [beforeDelete] = await pool.query<any[]>(`SELECT action, resource_id, details_json FROM audit_log_entries
      WHERE resource_id IN ('85','104','120') ORDER BY resource_id, action`);
    expect(beforeDelete.filter(row => row.action === 'disable_legacy_alert_rule').map(row => row.resource_id).sort())
      .toEqual(['104', '120', '85']);
    expect(beforeDelete.some(row => row.action === 'delete_legacy_alert_rule')).toBe(false);

    // Re-enable one rule: deletion must refuse to remove an active legacy rule.
    await pool.execute('UPDATE alert_rules SET enabled = TRUE WHERE id = 104');
    await expect(applyLegacyAlertMigration(pool, 'delete')).rejects.toThrow('LEGACY_RULE_NOT_DISABLED');
    await pool.execute('UPDATE alert_rules SET enabled = FALSE WHERE id = 104');

    const deleted = await applyLegacyAlertMigration(pool, 'delete', { actor: { userId: '0', username: 'max243-test' } });
    expect([...deleted.deleted_rule_ids].sort((a, b) => a - b)).toEqual([85, 104, 120]);
    expect(deleted.audit_entries).toHaveLength(3);
    const [remaining] = await pool.query<any[]>('SELECT id FROM alert_rules WHERE id IN (85,104,120)');
    expect(remaining).toHaveLength(0);

    const [audit] = await pool.query<any[]>(`SELECT action, details_json FROM audit_log_entries
      WHERE action LIKE '%legacy_alert_rule%' ORDER BY action, resource_id`);
    expect(audit.filter(row => row.action === 'disable_legacy_alert_rule')).toHaveLength(3);
    expect(audit.filter(row => row.action === 'delete_legacy_alert_rule')).toHaveLength(3);
    const deletedQps = audit.find(row => row.action === 'delete_legacy_alert_rule'
      && json(row.details_json).before.id === 104);
    expect(json(deletedQps.details_json)).toMatchObject({
      migration: 'MAX-243', phase: 'delete',
      before: { name: 'QPS 过高', metric_name: 'qps', threshold: 30000 },
      replacement_keys: ['qps'],
    });

    const again = await applyLegacyAlertMigration(pool, 'delete');
    expect(again.deleted_rule_ids).toEqual([]);
    expect(again.audit_entries).toEqual([]);
  }, 120000);

  it('refuses to delete before replacements exist and stays idempotent when disabled twice', async () => {
    await applyLegacyAlertMigration(pool, 'disable');
    const second = await applyLegacyAlertMigration(pool, 'disable');
    expect(second.created_rule_ids).toEqual([]);
    expect(second.reused_rule_ids).toHaveLength(3);
    const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM alert_rules WHERE description LIKE '%[MAX-243:%'`);
    expect(Number(count[0].n)).toBe(3);

    await pool.query(`DELETE FROM alert_rules WHERE description LIKE '%[MAX-243:%'`);
    await expect(applyLegacyAlertMigration(pool, 'delete')).rejects.toThrow('LEGACY_MIGRATION_REPLACEMENTS_MISSING');
    const [oldRules] = await pool.query<any[]>('SELECT id FROM alert_rules WHERE id IN (85,104,120)');
    expect(oldRules).toHaveLength(3);
  }, 120000);
});
