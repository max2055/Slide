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

interface ServerMetricRow {
  server_id: number;
  metric_name: string;
  metric_value: number;
  recorded_at: Date;
}

interface ServerAlertRuleRaw {
  id: number;
  name: string;
  description: string | null;
  metric_name: string;
  operator: string;
  threshold: number;
  threshold_template: any;
  duration_seconds: number;
  severity: string;
  enabled: boolean;
  silence_minutes: number;
  notification_channels: any;
  server_id: number | null;
  target_type: string;
  db_types: string | null;
  instance_ids: string | null;
  template_id: number | null;
}

class ServerAlertEvaluator {
  /**
   * Evaluate server metric threshold rules.
   *
   * For each collection-enabled server with active server alert rules,
   * checks latest metrics against rule thresholds and creates alerts
   * when thresholds are breached.
   */
  async evaluateServerRules(): Promise<void> {
    const pool = dbConnection.getPool();
    if (!pool) {
      console.warn('[ServerAlertEvaluator] database not connected, skipping server rule evaluation');
      return;
    }

    try {
      // 1. Fetch enabled server alert rules (target_type='server')
      const [rules] = await pool.execute(
        `SELECT id, name, description, metric_name, operator, threshold,
                threshold_template, duration_seconds, severity, enabled,
                silence_minutes, notification_channels,
                server_id, target_type, db_types, instance_ids, template_id
         FROM alert_rules
         WHERE enabled = 1 AND target_type = 'server'`,
      ) as any;

      if (!rules || rules.length === 0) {
        return; // No server rules configured
      }

      const serverRules = rules as ServerAlertRuleRaw[];

      // 2. Get all collection-enabled servers
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

        const latestMetrics = await this._getLatestMetrics(serverId);
        if (latestMetrics.length === 0) {
          continue; // No metrics yet for this server, skip
        }

        // Build metric lookup map
        const metricMap = new Map<string, number>();
        for (const m of latestMetrics) {
          metricMap.set(m.metric_name, m.metric_value);
        }

        for (const rule of rules) {
          try {
            const currentValue = metricMap.get(rule.metric_name);
            if (currentValue === undefined) {
              continue; // Metric not collected for this server
            }

            const triggered = this._evaluateThreshold(rule, currentValue);
            if (!triggered) continue;

            // Check for existing active alert (dedup)
            const existing = await alertDatabaseService.findActiveServerAlert(
              serverId, rule.metric_name, rule.id,
            );
            if (existing) {
              // Touch existing alert with updated value
              try {
                await alertDatabaseService.touchAlert(existing.id, currentValue);
              } catch {
                // Non-critical: touch failures are logged internally
              }
              continue;
            }

            // Create alert
            const level = this._mapSeverity(rule.severity);
            const title = `[${rule.severity.toUpperCase()}] ${rule.name} - ${server.label || server.host}`;
            const message = `服务器指标 "${rule.metric_name}" 当前值为 ${currentValue}，超过阈值 ${rule.threshold}`;

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
                rule_id: rule.id,
                rule_name: rule.name,
                target_type: 'server',
                auto_generated: true,
              },
            });

            console.log(`[ServerAlertEvaluator] Created alert: ${title} (server #${serverId})`);
          } catch (ruleErr) {
            console.error(`[ServerAlertEvaluator] Error evaluating rule #${rule.id} for server #${serverId}:`, ruleErr);
          }
        }
      }
    } catch (error) {
      console.error('[ServerAlertEvaluator] evaluateServerRules failed:', error);
    }
  }

  /**
   * Check for servers that have been unreachable for more than 10 minutes
   * and create "服务器不可达" alerts if there are active server alert rules.
   *
   * Only triggers once per unreachable episode (dedup via findActiveServerAlert).
   */
  async checkUnreachable(): Promise<void> {
    const pool = dbConnection.getPool();
    if (!pool) {
      return;
    }

    try {
      // 1. Check if any server alert rules exist
      const [ruleCount] = await pool.execute(
        `SELECT COUNT(*) AS cnt FROM alert_rules WHERE enabled = 1 AND target_type = 'server'`,
      ) as any;
      if (!ruleCount || ruleCount[0]?.cnt === 0) {
        return; // No server rules, no need to check unreachable
      }

      // 2. Find servers unreachable for more than 10 minutes
      const [servers] = await pool.execute(
        `SELECT id, host, label, status, last_check_at
         FROM servers
         WHERE status = 'unreachable'
           AND last_check_at IS NOT NULL
           AND last_check_at < NOW() - INTERVAL 10 MINUTE
         ORDER BY host`,
      ) as any;

      if (!servers || servers.length === 0) {
        return;
      }

      for (const server of servers) {
        try {
          // 3. Check for existing active unreachable alert (dedup)
          const existing = await alertDatabaseService.findActiveServerAlert(
            server.id, 'unreachable', 0,
          );
          if (existing) {
            continue; // Already alerted for this unreachable episode
          }

          // 4. Create "服务器不可达" alert
          const label = server.label || server.host || `#${server.id}`;
          const title = `[ERROR] 服务器不可达 - ${label}`;
          const message = `服务器 ${server.host} (${label}) 已超过 10 分钟不可达，请检查网络连接或服务器状态。`;

          await alertDatabaseService.createAlert({
            server_id: server.id,
            alert_type: 'availability',
            level: 'error',
            title,
            message,
            description: `服务器 ${server.host} 自动检测为不可达状态`,
            source: 'server-monitor',
            metric_name: 'unreachable',
            metric_value: '0',
            threshold_value: '1',
            tags: {
              rule_id: 0,
              rule_name: '服务器不可达检测',
              target_type: 'server',
              auto_generated: true,
              unreachable_episode: true,
            },
          });

          console.log(`[ServerAlertEvaluator] Created unreachable alert for server #${server.id} (${server.host})`);
        } catch (serverErr) {
          console.error(`[ServerAlertEvaluator] Error checking unreachable for server #${server.id}:`, serverErr);
        }
      }
    } catch (error) {
      console.error('[ServerAlertEvaluator] checkUnreachable failed:', error);
    }
  }

  /**
   * Get the latest metric values for a server.
   */
  private async _getLatestMetrics(serverId: number): Promise<ServerMetricRow[]> {
    const pool = dbConnection.getPool();
    if (!pool) return [];

    try {
      const [rows] = await pool.execute(
        `SELECT sm.server_id, sm.metric_name, sm.metric_value, sm.recorded_at
         FROM server_metrics sm
         INNER JOIN (
           SELECT metric_name, MAX(recorded_at) AS max_time
           FROM server_metrics
           WHERE server_id = ?
           GROUP BY metric_name
         ) latest ON sm.metric_name = latest.metric_name AND sm.recorded_at = latest.max_time
         WHERE sm.server_id = ?`,
        [serverId, serverId],
      ) as any;

      return rows as ServerMetricRow[];
    } catch (error) {
      console.error(`[ServerAlertEvaluator] Failed to get latest metrics for server #${serverId}:`, error);
      return [];
    }
  }

  /**
   * Evaluate a single threshold rule against a current value.
   */
  private _evaluateThreshold(rule: ServerAlertRuleRaw, currentValue: number): boolean {
    const numericValue = Number(currentValue);
    const numericThreshold = Number(rule.threshold);

    switch (rule.operator) {
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
   * Map rule severity to alert level.
   */
  private _mapSeverity(severity: string): 'info' | 'warning' | 'error' | 'critical' {
    const map: Record<string, 'info' | 'warning' | 'error' | 'critical'> = {
      info: 'info',
      warning: 'warning',
      error: 'error',
      critical: 'critical',
    };
    return map[severity] || 'warning';
  }
}

// Singleton
export const serverAlertEvaluator = new ServerAlertEvaluator();
