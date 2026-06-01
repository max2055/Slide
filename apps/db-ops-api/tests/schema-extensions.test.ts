/**
 * Schema 扩展测试 - 验证 Phase 06 新增表和列
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Phase 06 Schema Extensions', () => {
  let schemaContent: string;

  beforeAll(() => {
    const schemaPath = join(__dirname, '..', 'sql', 'schema.sql');
    schemaContent = readFileSync(schemaPath, 'utf-8');
  });

  describe('8 个新表', () => {
    it('应包含 metric_definitions 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `metric_definitions`");
    });

    it('应包含 alert_events 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `alert_events`");
    });

    it('应包含 alert_event_members 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `alert_event_members`");
    });

    it('应包含 escalation_rules 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `escalation_rules`");
    });

    it('应包含 maintenance_windows 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `maintenance_windows`");
    });

    it('应包含 silence_periods 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `silence_periods`");
    });

    it('应包含 alert_event_logs 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `alert_event_logs`");
    });

    it('应包含 metric_baselines 表', () => {
      expect(schemaContent).toContain("CREATE TABLE IF NOT EXISTS `metric_baselines`");
    });
  });

  describe('ALTER TABLE 语句', () => {
    it('alert_rules 应有 threshold_type 列', () => {
      expect(schemaContent).toContain("threshold_type");
      expect(schemaContent).toMatch(/'static',\s*'dynamic'/);
    });

    it('alert_rules 应有 dynamic_config 列', () => {
      expect(schemaContent).toContain("dynamic_config");
    });

    it('alerts level ENUM 应包含 p0', () => {
      // 匹配 MODIFY COLUMN level ENUM 包含 p0
      const alertLevelMatch = schemaContent.match(/alerts.*level.*ENUM\([^)]*'p0'[^)]*\)/s);
      expect(alertLevelMatch).not.toBeNull();
    });
  });

  describe('表结构验证', () => {
    it('alert_events 应有正确的 status ENUM', () => {
      expect(schemaContent).toMatch(/'open',\s*'investigating',\s*'handled',\s*'resolved',\s*'closed'/);
    });

    it('alert_event_logs 应有 action ENUM 包含 9 种操作', () => {
      expect(schemaContent).toMatch(/'escalated',\s*'assigned',\s*'unassigned',\s*'acknowledged',\s*'note_added',\s*'status_changed',\s*'resolved',\s*'closed',\s*'silenced'/);
    });

    it('metric_baselines 应有 uk_instance_metric 唯一索引', () => {
      expect(schemaContent).toContain("uk_instance_metric");
    });

    it('silence_periods 应有 silenced_until 列', () => {
      expect(schemaContent).toContain("silenced_until");
    });
  });
});
