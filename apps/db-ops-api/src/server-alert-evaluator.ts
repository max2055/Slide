import { evaluateOperationalRule } from './metrics/consumers/operational.js';
import { assertWorkflowActive } from './workflows/execution-context.js';
/**
 * Server Alert Evaluator
 *
 * Evaluates server metric thresholds and unreachable detection,
 * creating alerts through the existing alert engine pipeline.
 *
 * Requirements: ALR-01, ALR-02, ALR-03, ALR-04
 */
import { dbConnection } from './db-connection';
import { serverDatabaseService } from './server-database-service';
import { alertDatabaseService } from './alert-database-service';

interface ServerAlertRuleRaw {
  id: number;
  name: string;
  description: string | null;
  metric_name: string;
  operator: string;
  threshold: number;
  threshold_template: any;
  duration_seconds: number;
  recovery_seconds?: number;
  severity: string;
  enabled: boolean;
  silence_minutes: number;
  notification_channels: any;
  server_id: number | null;
  target_type: string;
  db_types: string | null;
  instance_ids: string | null;
  template_id: number | null;
  dimensions?: Record<string, unknown> | null;
}

class ServerAlertEvaluator {
  /**
   * Evaluate server metric threshold rules.
   *
   * For each collection-enabled server with active server alert rules,
   * checks latest metrics against rule thresholds and creates alerts
   * when thresholds are breached.
   */
  async evaluateServerRules(qualificationDimensions?: ReadonlyMap<number, Readonly<Record<string, string>>>): Promise<void> {
    if (!dbConnection.isConnected()) {
      console.warn('[ServerAlertEvaluator] database not connected, skipping server rule evaluation');
      return;
    }

    try {
      // 1. Fetch enabled server alert rules (target_type='server') via shared API
      assertWorkflowActive();
      const allRules = await alertDatabaseService.getAlertRules(true);
      const rules = allRules.filter(r => r.target_type === 'server'
        && (!qualificationDimensions || qualificationDimensions.has(r.id)))
        .map(r => qualificationDimensions ? { ...r, dimensions: qualificationDimensions.get(r.id) } : r);

      if (!rules || rules.length === 0) {
        return; // No server rules configured
      }

      const serverRules = rules as unknown as ServerAlertRuleRaw[];

      // 2. Get all collection-enabled servers
      assertWorkflowActive();
      const servers = await serverDatabaseService.getCollectionEnabledServers();
      if (servers.length === 0) {
        return;
      }

      // 3. Build server -> rule assignments
      // A rule applies to a server if rule.server_id IS NULL (global) or matches server.id
      const serverRuleMap = new Map<number, ServerAlertRuleRaw[]>();
      for (const server of servers) {
        const applicableRules: ServerAlertRuleRaw[] = [];
        for (const rule of serverRules) {
          if (rule.server_id === null || rule.server_id === server.id) {
            applicableRules.push(rule);
          }
        }
        if (applicableRules.length > 0) {
          serverRuleMap.set(server.id, applicableRules);
        }
      }

      if (serverRuleMap.size === 0) {
        return;
      }

      // 4. Evaluate each server's rules against latest metrics
      for (const [serverId, rules] of serverRuleMap) {
        const server = servers.find((s) => s.id === serverId);
        if (!server) continue;

        for (const rule of rules) {
          try {
            // Recovery evidence belongs to the alert's complete dimension set.
            // Check it even when a different dimension is still firing.
            assertWorkflowActive();
            const active = await alertDatabaseService.findActiveServerAlerts(serverId, rule.metric_name, rule.id);
            for (const existing of active) {
              const dimensions = existing.tags?.dimensions ?? {};
              if (rule.dimensions && !Object.entries(rule.dimensions).every(([key, value]) => dimensions[key] === value)) continue;
              const recovery = await evaluateOperationalRule({ type: 'server', id: serverId }, { ...rule, dimensions } as any,
                rule.recovery_seconds ?? rule.duration_seconds);
              if (recovery.recovery) {
                assertWorkflowActive();
                await alertDatabaseService.resolveAlert(existing.id);
              }
            }
            const semantic = await evaluateOperationalRule({ type: 'server', id: serverId }, rule as any, rule.duration_seconds);
            if (!semantic.handled) continue;
            if (!semantic.level || semantic.value === null) continue;
            const currentValue = semantic.value!;
            const selectedDimensions = semantic.dimensions;
            const selectedRecordedAt = semantic.observation?.observedAt ? new Date(semantic.observation.observedAt) : undefined;
            const level = semantic.level;
            if (!level) continue;

            const title = `[${rule.severity.toUpperCase()}] ${rule.name} - ${server.label || server.host}`;
            const dimensions = selectedDimensions;
            const collectedAt = selectedRecordedAt?.toISOString() ?? null;
            const dimensionText = dimensions ? `（${Object.entries(dimensions).map(([key, value]) => `${key}=${value}`).join(', ')}）` : '';
            const message = `服务器指标 "${rule.metric_name}"${dimensionText} 当前值为 ${currentValue}，超过阈值 ${rule.threshold}；采集时间 ${collectedAt ?? 'unknown'}`;

            const observation = { message, thresholdValue: String(rule.threshold), tags: {
              rule_id: rule.id,
              rule_name: rule.name,
              semantic_migration: semantic.migration,
              collected_at: collectedAt,
              observed_from: semantic.observation?.from ?? null,
              observed_to: semantic.observation?.to ?? null,
              rule_window_seconds: rule.duration_seconds,
              quality: semantic.observation?.quality ?? 'unknown',
              dimensions,
            } };

            // Check for existing active alert (dedup)
            assertWorkflowActive();
            const existing = await alertDatabaseService.findActiveServerAlert(
              serverId, rule.metric_name, rule.id, dimensions,
            );
            if (existing) {
              // Touch existing alert with updated value
              try {
                assertWorkflowActive();
                await alertDatabaseService.touchAlert(existing.id, currentValue, observation);
              } catch {
                assertWorkflowActive();
                // Non-critical: touch failures are logged internally
              }
              continue;
            }

            assertWorkflowActive();
            await alertDatabaseService.createAlert({
              server_id: serverId,
              alert_type: 'performance',
              level,
              title,
              message,
              description: rule.description || `服务器告警规则：${rule.name}`,
              source: 'server-monitor',
              metric_name: rule.metric_name,
              metric_value: String(currentValue),
              threshold_value: String(rule.threshold),
              tags: {
                ...observation.tags,
                rule_id: rule.id,
                rule_name: rule.name,
                target_type: 'server',
                auto_generated: true,
              },
            });

            console.log(`[ServerAlertEvaluator] Created alert: ${title} (server #${serverId})`);
          } catch (ruleErr) {
            assertWorkflowActive();
            console.error(`[ServerAlertEvaluator] Error evaluating rule #${rule.id} for server #${serverId}:`, ruleErr);
          }
        }
      }
    } catch (error) {
      assertWorkflowActive();
      console.error('[ServerAlertEvaluator] evaluateServerRules failed:', error);
    }
  }

  /** Compatibility hook. A persisted asset status is not a continuous formal
   * reachability observation and cannot establish a ten-minute outage window. */
  async checkUnreachable(): Promise<void> {
    // Existing alerts/history remain intact. No synthesized metric or recovery.
  }

}

export const serverAlertEvaluator = new ServerAlertEvaluator();
