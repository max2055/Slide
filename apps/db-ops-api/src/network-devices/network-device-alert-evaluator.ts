import { evaluateOperationalRule } from '../metrics/consumers/operational.js';
import { assertWorkflowActive } from '../workflows/execution-context.js';
import { dbConnection } from '../db-connection.js';
import { alertDatabaseService, type AlertRule } from '../alert-database-service.js';
import { metricRegistry } from '../metric-registry.js';
import { compileAlertRule, type AlertLevel } from '../alerts/compiled-rule.js';
import { canonicalDimensions, type ObservationQuality } from '../resources/types.js';

export interface NetworkDeviceAlertObservation {
  metricId: string;
  value: number | null;
  dimensions?: Record<string, string>;
  quality: ObservationQuality;
  observedAt: Date | null;
  observedFrom?: Date | null;
  observedTo?: Date | null;
  aggregateQuality?: 'good' | 'partial';
  validUntil: Date | null;
  reason?: string;
}

export interface NetworkDeviceAlertDevice {
  id: number;
  name?: string | null;
  label?: string | null;
  host?: string | null;
  status?: string | null;
  collectionEnabled?: boolean;
  lastCheckAt?: Date | null;
}

export interface NetworkDeviceAlertRule extends AlertRule {
  target_type?: 'network_device';
  network_device_id?: number | null;
  recovery_seconds?: number;
}

export interface NetworkDeviceAlertStore {
  getCollectionEnabledDevices(): Promise<NetworkDeviceAlertDevice[]>;
 }

export interface NetworkDeviceAlertEvaluatorOptions { store?: NetworkDeviceAlertStore }

export interface NetworkDeviceAlertEvaluation {
  /** Rules evaluated using known evidence, including failed persistence. */
  evaluated: number;
  /** Firing rules, regardless of persistence outcome. */
  matched: number;
  /** Successfully created or touched alerts. */
  triggered: number;
  skipped: number;
  failed: number;
  status: 'complete' | 'partial' | 'failed';
  failures: { phase: 'setup' | 'evaluation' | 'recovery'; deviceId?: number; ruleId?: number; alertId?: number }[];
}

type AlertRuleLike = AlertRule & { target_type?: 'network_device' | 'instance' | 'server'; network_device_id?: number | null };

function parseDimensions(value: unknown): Record<string, string> | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some(item => typeof item !== 'string')) {
    throw new Error('OBSERVATION_DIMENSIONS_INVALID');
  }
  return canonicalDimensions(parsed);
}

function macroContext(metricId: string): Record<string, number> {
  const definition = metricRegistry.getById(metricId, 'network_device');
  const template = definition?.threshold_template;
  if (!template) return {};
  return Object.fromEntries(Object.entries(template).filter(([, value]) => value != null).map(([key, value]) => [key, Number(value)]));
}

function stableDeviceName(device: NetworkDeviceAlertDevice): string {
  return device.label || device.name || device.host || `#${device.id}`;
}

function alertTypeForMetric(metricId: string): 'performance' | 'availability' {
  return metricId === 'device_reachability' || metricId === 'interface_oper_status' ? 'availability' : 'performance';
}

/**
 * Evaluates only evidence-backed network-device rules. Missing, stale, invalid,
 * or non-finite observations are skipped instead of being interpreted as zero.
 */
export class NetworkDeviceAlertEvaluator {
  private readonly store: NetworkDeviceAlertStore;
  constructor(options?: NetworkDeviceAlertEvaluatorOptions) {
    this.store = options?.store ?? new MysqlNetworkDeviceAlertStore();
  }

  async evaluateNetworkDeviceRules(): Promise<NetworkDeviceAlertEvaluation> {
    const result: NetworkDeviceAlertEvaluation = {
      evaluated: 0, matched: 0, triggered: 0, skipped: 0, failed: 0, status: 'complete', failures: [],
    };
    let setupComplete = false;
    try {
      assertWorkflowActive();
      const allRules = await alertDatabaseService.getAlertRules(true, true) as AlertRuleLike[];
      assertWorkflowActive();
      const rules = allRules.filter((rule) => rule.enabled && rule.target_type === 'network_device') as NetworkDeviceAlertRule[];
      if (rules.length === 0) return result;
      assertWorkflowActive();
      const devices = await this.store.getCollectionEnabledDevices();
      assertWorkflowActive();
      setupComplete = true;
      for (const device of devices) {
        if (device.collectionEnabled === false) continue;
        assertWorkflowActive();
        for (const rule of rules) {
          if (rule.network_device_id != null && Number(rule.network_device_id) !== device.id) continue;
          try {
            assertWorkflowActive();
            const semantic = await evaluateOperationalRule({ type: 'network_device', id: device.id }, rule, rule.duration_seconds, macroContext(rule.metric_name), true);
            if (!semantic.handled) { result.skipped++; continue; }
            {
              if (!['firing','healthy'].includes(semantic.state) || semantic.value === null || !Number.isFinite(semantic.value)) { result.skipped++; continue; }
              result.evaluated++;
              if (semantic.level && semantic.value !== null) {
                result.matched++;
                await this.persistAlert(device, rule, { metricId: rule.metric_name, value: semantic.value, dimensions: semantic.dimensions ?? undefined, quality: semantic.observation?.quality === 'good' ? 'good' : 'unknown',
                  aggregateQuality: semantic.observation?.quality,
                  observedAt: semantic.observation?.observedAt ? new Date(semantic.observation.observedAt) : null,
                  observedFrom: semantic.observation?.from ? new Date(semantic.observation.from) : null,
                  observedTo: semantic.observation?.to ? new Date(semantic.observation.to) : null, validUntil: null, reason: JSON.stringify(semantic.migration) }, semantic.level,
                  semantic.value, compileAlertRule(rule, 'network_device', macroContext(rule.metric_name)));
                result.triggered++;
              } else {
                const recovery = await evaluateOperationalRule({ type: 'network_device', id: device.id }, rule,
                  rule.recovery_seconds ?? rule.duration_seconds, macroContext(rule.metric_name), true);
                if (!recovery.recovery) result.skipped++;
              }
              continue;
            }
          } catch (error) {
            this.recordFailure(result, { phase: 'evaluation', deviceId: device.id, ruleId: rule.id }, error);
          }
        }
      }
      assertWorkflowActive();
      await this.resolveRecoveredAlerts(rules, new Set(devices.filter(d => d.collectionEnabled !== false).map(d => d.id)), result);
    } catch (error) {
      this.recordFailure(result, { phase: setupComplete ? 'recovery' : 'setup' }, error);
      if (!setupComplete) result.status = 'failed';
    }
    assertWorkflowActive();
    return result;
  }

  /** Short alias used by lifecycle integrations. */
  evaluate(): Promise<NetworkDeviceAlertEvaluation> {
    return this.evaluateNetworkDeviceRules();
  }

  private async resolveRecoveredAlerts(rules: NetworkDeviceAlertRule[], enabledDevices: Set<number>, result: NetworkDeviceAlertEvaluation): Promise<void> {
    assertWorkflowActive();
    const active = await alertDatabaseService.getActiveAlerts(true);
    for (const alert of active ?? []) {
      if (alert?.target_type !== 'network_device' || !enabledDevices.has(Number(alert?.network_device_id))) continue;
      try {
        let tags: Record<string, any> = {};
        if (alert.tags && typeof alert.tags === 'object' && !Array.isArray(alert.tags)) tags = alert.tags;
        else if (typeof alert.tags === 'string') {
          try {
            const parsed = JSON.parse(alert.tags);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) tags = parsed;
          } catch { /* malformed tags cannot identify a recovery target */ }
        }
        const ruleId = Number(tags.rule_id);
        if (!Number.isSafeInteger(ruleId) || ruleId <= 0 || !alert.metric_name) continue;
        const dimensions = parseDimensions(tags.dimensions);
        // Unknown or stale evidence must not resolve an alert. Only a fresh
        // sample that no longer matches the rule is sufficient.
        assertWorkflowActive();
        const rule = rules.find(r => r.id === ruleId);
        if (rule) {
          const semantic = await evaluateOperationalRule({ type: 'network_device', id: Number(alert.network_device_id) },
            { ...rule, dimensions }, rule.recovery_seconds ?? rule.duration_seconds, macroContext(rule.metric_name), true);
          if (semantic.handled) {
            if (semantic.state === 'healthy' && semantic.recovery && semantic.value !== null && Number.isFinite(semantic.value)) {
              assertWorkflowActive();
              const resolved = await alertDatabaseService.resolveAlert(Number(alert.id));
              if (!resolved?.success) throw new Error('NETWORK_ALERT_RESOLVE_FAILED');
            }
            continue;
          }
        }
      } catch (error) {
        this.recordFailure(result, { phase: 'recovery', deviceId: Number(alert.network_device_id), alertId: Number(alert.id) }, error);
      }
    }
  }

  private recordFailure(result: NetworkDeviceAlertEvaluation, failure: NetworkDeviceAlertEvaluation['failures'][number], error: unknown): void {
    assertWorkflowActive();
    result.failed++;
    result.status = 'partial';
    result.failures.push(failure);
    console.error('[NetworkDeviceAlertEvaluator] evaluation failed:', failure, error instanceof Error ? error.message : String(error));
  }

  private async persistAlert(device: NetworkDeviceAlertDevice, rule: NetworkDeviceAlertRule, observation: NetworkDeviceAlertObservation, level: AlertLevel, currentValue: number, compiled: ReturnType<typeof compileAlertRule>): Promise<void> {
    const dimensions = canonicalDimensions(observation.dimensions);
    const tags = {
      rule_id: rule.id,
      rule_name: rule.name,
      target_type: 'network_device',
      auto_generated: true,
      observed_at: observation.observedAt?.toISOString() ?? null,
      observed_from: (observation.observedFrom ?? observation.observedAt)?.toISOString() ?? null,
      observed_to: (observation.observedTo ?? observation.observedAt)?.toISOString() ?? null,
      rule_window_seconds: rule.duration_seconds,
      quality: observation.aggregateQuality ?? observation.quality,
      semantic_migration: observation.reason?.startsWith('{"version"') ? observation.reason : null,
      ...(dimensions ? { dimensions } : {}),
    };
    const message = `网络设备指标 "${rule.metric_name}" 当前值为 ${currentValue}，超过阈值 (${rule.operator})`;
    assertWorkflowActive();
    const existing = await alertDatabaseService.findActiveNetworkDeviceAlert(device.id, rule.metric_name, rule.id, dimensions);
    if (existing) {
      assertWorkflowActive();
      await alertDatabaseService.touchAlert(existing.id, currentValue, {tags, message}, true);
      return;
    }
    assertWorkflowActive();
    const created = await alertDatabaseService.createAlert({
      target_type: 'network_device',
      network_device_id: device.id,
      alert_type: alertTypeForMetric(rule.metric_name),
      level,
      title: `[${level.toUpperCase()}] ${rule.name} - ${stableDeviceName(device)}`,
      message,
      description: rule.description || `网络设备告警规则：${rule.name}`,
      source: 'network-device-monitor',
      metric_name: rule.metric_name,
      metric_value: String(currentValue),
      threshold_value: String(compiled.thresholds[level] ?? rule.threshold),
      tags,
    });
    if (!created.success) throw new Error('NETWORK_ALERT_CREATE_FAILED');
  }
}

export class MysqlNetworkDeviceAlertStore implements NetworkDeviceAlertStore {
  constructor(private readonly poolProvider: () => any = () => dbConnection.getPool()) {}

  async getCollectionEnabledDevices(): Promise<NetworkDeviceAlertDevice[]> {
    const pool = this.pool();
    assertWorkflowActive();
    const [rows] = await pool.execute(
      'SELECT id, name, label, host, status, last_check_at AS lastCheckAt, collection_enabled AS collectionEnabled FROM network_devices WHERE collection_enabled = 1 ORDER BY id',
    );
    return (rows as any[]).map((row) => ({ ...row, id: Number(row.id), collectionEnabled: Boolean(row.collectionEnabled),
      lastCheckAt: row.lastCheckAt == null ? null : new Date(row.lastCheckAt) }));
  }

  private pool(): any {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

export const networkDeviceAlertEvaluator = new NetworkDeviceAlertEvaluator();
