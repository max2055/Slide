import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { DEFAULT_CONFIG, type AiAnalysisConfig } from '../ai-analysis-config-service.js';
import type { DatabaseAlertSource } from './alert-bridge.js';

/** Same persisted master settings for immediate, cron and recovery entrances.
 * Read on the admission connection: no nested pool acquisition or fail-open. */
export async function automaticAlertSuppression(c: PoolConnection, alert: DatabaseAlertSource, now = new Date()): Promise<string | undefined> {
  let config: AiAnalysisConfig;
  try {
    const [rows] = await c.execute<RowDataPacket[]>('SELECT config_value FROM system_config WHERE config_key=?', ['auto_analysis_config']);
    const raw = rows[0]?.config_value;
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) return 'AUTO_ANALYSIS_CONFIG_INVALID';
    config = {...DEFAULT_CONFIG, ...value};
  } catch { return 'AUTO_ANALYSIS_CONFIG_UNAVAILABLE'; }
  return automaticAlertConfigurationSuppression(config, alert, now);
}

export function automaticAlertConfigurationSuppression(config: AiAnalysisConfig, alert: DatabaseAlertSource, now: Date): string | undefined {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof config.enabled !== 'boolean' || !Array.isArray(config.severityLevels)
    || !config.severityLevels.length || config.severityLevels.some(level => !['info','warning','error','critical'].includes(level))
    || !Array.isArray(config.instanceWhitelist) || config.instanceWhitelist.some(id => !Number.isSafeInteger(id) || id <= 0)
    || typeof config.timeWindowStart !== 'string' || !hhmm.test(config.timeWindowStart)
    || typeof config.timeWindowEnd !== 'string' || !hhmm.test(config.timeWindowEnd)) return 'AUTO_ANALYSIS_CONFIG_INVALID';
  if (!config.enabled) return 'AUTO_ANALYSIS_DISABLED';
  if (!config.severityLevels.includes(alert.level)) return 'AUTO_ANALYSIS_SEVERITY_EXCLUDED';
  // Historical whitelist is database-only. Server/network scope comes from
  // the dedicated service principal's explicit resource lists, never numeric overlap.
  if (alert.instance_id != null && config.instanceWhitelist.length && !config.instanceWhitelist.includes(alert.instance_id))
    return 'AUTO_ANALYSIS_RESOURCE_EXCLUDED';
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const {timeWindowStart:start, timeWindowEnd:end} = config;
  if (!(start <= end ? time >= start && time <= end : time >= start || time <= end)) return 'AUTO_ANALYSIS_OUTSIDE_WINDOW';
  return undefined;
}
