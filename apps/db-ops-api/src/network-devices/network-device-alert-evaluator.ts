import { dbConnection } from '../db-connection.js';
import { alertDatabaseService, type AlertRule } from '../alert-database-service.js';
import { metricRegistry } from '../metric-registry.js';
import { compileAlertRule, evaluateCompiledRule, type AlertLevel } from '../alerts/compiled-rule.js';
import { canonicalDimensions, type ObservationQuality } from '../resources/types.js';

export interface NetworkDeviceAlertObservation {
  metricId: string;
  value: number | null;
  dimensions?: Record<string, string>;
  quality: ObservationQuality;
  observedAt: Date | null;
  validUntil: Date | null;
  reason?: string;
  /** Synthetic status evidence is derived from the persisted device state. */
  synthetic?: boolean;
}

export interface NetworkDeviceAlertDevice {
  id: number;
  name?: string | null;
  label?: string | null;
  host?: string | null;
  status?: string | null;
  collectionEnabled?: boolean;
}

export interface NetworkDeviceAlertRule extends AlertRule {
  target_type?: 'network_device';
  network_device_id?: number | null;
  recovery_seconds?: number;
}

export interface NetworkDeviceAlertStore {
  getCollectionEnabledDevices(): Promise<NetworkDeviceAlertDevice[]>;
  getLatestObservations(deviceId: number): Promise<NetworkDeviceAlertObservation[]>;
  getObservationHistory(deviceId: number, metricId: string, dimensions: Record<string, string> | undefined, from: Date, limit: number): Promise<NetworkDeviceAlertObservation[]>;
}

export interface NetworkDeviceAlertEvaluatorOptions {
  store?: NetworkDeviceAlertStore;
  clock?: () => Date;
  historyLimit?: number;
}

type AlertRuleLike = AlertRule & { target_type?: 'network_device' | 'instance' | 'server'; network_device_id?: number | null };

function parseDimensions(value: unknown): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const dimensions = Object.fromEntries(Object.entries(parsed).filter(([, item]) => typeof item === 'string')) as Record<string, string>;
    return canonicalDimensions(dimensions);
  } catch {
    return undefined;
  }
}

function sameDimensions(left?: Record<string, string>, right?: Record<string, string>): boolean {
  let a: Record<string, string>;
  let b: Record<string, string>;
  try {
    a = canonicalDimensions(left) ?? {};
    b = canonicalDimensions(right) ?? {};
  } catch {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

function isFreshObservation(observation: NetworkDeviceAlertObservation, now: Date): boolean {
  if (observation.quality !== 'good' || observation.value == null || !Number.isFinite(Number(observation.value))) return false;
  if (!observation.observedAt || !Number.isFinite(observation.observedAt.getTime()) || observation.observedAt.getTime() > now.getTime()) return false;
  if (observation.validUntil && (!Number.isFinite(observation.validUntil.getTime()) || observation.validUntil.getTime() <= now.getTime())) return false;
  return true;
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

function evaluateLevel(rule: NetworkDeviceAlertRule, compiled: ReturnType<typeof compileAlertRule>, value: number): AlertLevel | null {
  const level = evaluateCompiledRule(compiled, value);
  if (!level || rule.severity === 'info') return level;
  const thresholds = Object.values(compiled.thresholds).filter((threshold): threshold is number => threshold !== undefined);
  // A binary state rule commonly uses the same sentinel for every level. In
  // that case the rule's declared severity is the intended level; selecting
  // `critical` solely because it is checked first would silently escalate it.
  if (thresholds.length > 1 && thresholds.every((threshold) => threshold === thresholds[0])) return rule.severity;
  return level;
}

function observationIdentity(observation: NetworkDeviceAlertObservation): string {
  return `${observation.metricId}:${JSON.stringify(canonicalDimensions(observation.dimensions) ?? {})}`;
}

function latestObservations(observations: NetworkDeviceAlertObservation[]): NetworkDeviceAlertObservation[] {
  const latest = new Map<string, NetworkDeviceAlertObservation>();
  for (const observation of observations) {
    let key: string;
    try { key = observationIdentity(observation); } catch { continue; }
    const previous = latest.get(key);
    if (!previous) {
      latest.set(key, observation);
      continue;
    }
    const previousTime = previous.observedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const currentTime = observation.observedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (currentTime >= previousTime) latest.set(key, observation);
  }
  return [...latest.values()];
}

/**
 * Evaluates only evidence-backed network-device rules. Missing, stale, invalid,
 * or non-finite observations are skipped instead of being interpreted as zero.
 */
export class NetworkDeviceAlertEvaluator {
  private readonly store: NetworkDeviceAlertStore;
  private readonly clock: () => Date;
  private readonly historyLimit: number;

  constructor(options?: NetworkDeviceAlertEvaluatorOptions | NetworkDeviceAlertStore) {
    if (options && typeof (options as NetworkDeviceAlertStore).getLatestObservations === 'function') {
      this.store = options as NetworkDeviceAlertStore;
      this.clock = () => new Date();
      this.historyLimit = 200;
    } else {
      const config = options as NetworkDeviceAlertEvaluatorOptions | undefined;
      this.store = config?.store ?? new MysqlNetworkDeviceAlertStore();
      this.clock = config?.clock ?? (() => new Date());
      this.historyLimit = Math.max(1, Math.min(config?.historyLimit ?? 200, 1_000));
    }
  }

  async evaluateNetworkDeviceRules(): Promise<{ evaluated: number; triggered: number; skipped: number }> {
    let evaluated = 0;
    let triggered = 0;
    let skipped = 0;
    const firingKeys = new Set<string>();
    const freshKeys = new Set<string>();
    try {
      const allRules = await alertDatabaseService.getAlertRules(true) as AlertRuleLike[];
      const rules = allRules.filter((rule) => rule.enabled && rule.target_type === 'network_device') as NetworkDeviceAlertRule[];
      if (rules.length === 0) return { evaluated, triggered, skipped };
      const devices = await this.store.getCollectionEnabledDevices();
      for (const device of devices) {
        if (device.collectionEnabled === false) continue;
        const observations = latestObservations(this.withReachabilityObservation(device, await this.store.getLatestObservations(device.id)));
        for (const rule of rules) {
          if (rule.network_device_id != null && Number(rule.network_device_id) !== device.id) continue;
          const candidates = observations.filter((observation) => observation.metricId === rule.metric_name);
          for (const observation of candidates) {
            if (!isFreshObservation(observation, this.clock())) { skipped++; continue; }
            evaluated++;
            let compiled;
            try {
              compiled = compileAlertRule(rule, 'network_device', macroContext(rule.metric_name));
            } catch {
              skipped++;
              continue;
            }
            let identity: string;
            try { identity = alertIdentity(device.id, rule, observation.dimensions); } catch { skipped++; continue; }
            freshKeys.add(identity);
            const currentValue = Number(observation.value);
            const level = evaluateLevel(rule, compiled, currentValue);
            if (!level) continue;
            if (!(await this.durationMet(device.id, rule, observation, compiled))) continue;
            triggered++;
            firingKeys.add(identity);
            await this.persistAlert(device, rule, observation, level, currentValue, compiled);
          }
        }
      }
      await this.resolveRecoveredAlerts(firingKeys, freshKeys);
    } catch (error) {
      // A failed query must never be converted into an alert. Keep the
      // evaluator available for the next cycle and expose only a stable count.
      console.error('[NetworkDeviceAlertEvaluator] evaluation failed:', error instanceof Error ? error.message : String(error));
    }
    return { evaluated, triggered, skipped };
  }

  /** Short alias used by lifecycle integrations. */
  evaluate(): Promise<{ evaluated: number; triggered: number; skipped: number }> {
    return this.evaluateNetworkDeviceRules();
  }

  private withReachabilityObservation(device: NetworkDeviceAlertDevice, observations: NetworkDeviceAlertObservation[]): NetworkDeviceAlertObservation[] {
    const now = this.clock();
    const status = String(device.status);
    const failed = ['error', 'unreachable', 'offline'].includes(status);
    if (!failed && status !== 'online') return observations;
    return [
      ...observations,
      {
        metricId: 'device_reachability', value: failed ? 0 : 1, quality: 'good', observedAt: now,
        validUntil: new Date(now.getTime() + 5 * 60_000), reason: `device_status_${status}`,
        synthetic: true,
      },
    ];
  }

  private async durationMet(
    deviceId: number,
    rule: NetworkDeviceAlertRule,
    current: NetworkDeviceAlertObservation,
    compiled: ReturnType<typeof compileAlertRule>,
  ): Promise<boolean> {
    const duration = Math.max(0, Number(rule.duration_seconds ?? 0));
    if (duration === 0 || current.synthetic) return true;
    const now = this.clock();
    const from = new Date(now.getTime() - duration * 1_000);
    const history = await this.store.getObservationHistory(deviceId, rule.metric_name, current.dimensions, from, this.historyLimit);
    if (history.length === 0) return false;
    const valid = history.filter((observation) => isFreshObservation(observation, now));
    if (valid.length !== history.length) return false;
    if (valid[0]!.observedAt!.getTime() > from.getTime()) return false;
    return valid.every((observation) => evaluateLevel(rule, compiled, Number(observation.value)) !== null)
      && evaluateLevel(rule, compiled, Number(current.value)) !== null;
  }

  private async resolveRecoveredAlerts(firingKeys: Set<string>, freshKeys: Set<string>): Promise<void> {
    const listActive = (alertDatabaseService as any).getActiveAlerts as undefined | (() => Promise<any[]>);
    const resolve = (alertDatabaseService as any).resolveAlert as undefined | ((alertId: number) => Promise<unknown>);
    if (!listActive || !resolve) return;
    const active = await listActive();
    for (const alert of active ?? []) {
      if (alert?.target_type !== 'network_device' || alert?.network_device_id == null) continue;
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
      const key = `${Number(alert.network_device_id)}:${ruleId}:${alert.metric_name}:${JSON.stringify(canonicalDimensions(dimensions) ?? {})}`;
      // Unknown or stale evidence must not resolve an alert. Only a fresh
      // sample that no longer matches the rule is sufficient.
      if (freshKeys.has(key) && !firingKeys.has(key)) await resolve(Number(alert.id));
    }
  }

  private async persistAlert(device: NetworkDeviceAlertDevice, rule: NetworkDeviceAlertRule, observation: NetworkDeviceAlertObservation, level: AlertLevel, currentValue: number, compiled: ReturnType<typeof compileAlertRule>): Promise<void> {
    let dimensions: Record<string, string> | undefined;
    try { dimensions = canonicalDimensions(observation.dimensions); } catch { return; }
    const finder = (alertDatabaseService as any).findActiveNetworkDeviceAlert as undefined | ((deviceId: number, metricId: string, ruleId: number, dimensions?: Record<string, string>) => Promise<unknown>);
    const existing = finder ? await finder(device.id, rule.metric_name, rule.id, dimensions) : null;
    if (existing && typeof (alertDatabaseService as any).touchAlert === 'function') {
      await alertDatabaseService.touchAlert((existing as any).id, currentValue);
      return;
    }
    await (alertDatabaseService as any).createAlert({
      target_type: 'network_device',
      network_device_id: device.id,
      alert_type: alertTypeForMetric(rule.metric_name),
      level,
      title: `[${level.toUpperCase()}] ${rule.name} - ${stableDeviceName(device)}`,
      message: `网络设备指标 "${rule.metric_name}" 当前值为 ${currentValue}，超过阈值 (${rule.operator})`,
      description: rule.description || `网络设备告警规则：${rule.name}`,
      source: 'network-device-monitor',
      metric_name: rule.metric_name,
      metric_value: String(currentValue),
      threshold_value: String(compiled.thresholds[level] ?? rule.threshold),
      tags: {
        rule_id: rule.id,
        rule_name: rule.name,
        target_type: 'network_device',
        auto_generated: true,
        ...(dimensions ? { dimensions } : {}),
      },
    });
  }
}

function alertIdentity(deviceId: number, rule: NetworkDeviceAlertRule, dimensions?: Record<string, string>): string {
  return `${deviceId}:${rule.id}:${rule.metric_name}:${JSON.stringify(canonicalDimensions(dimensions) ?? {})}`;
}

export class MysqlNetworkDeviceAlertStore implements NetworkDeviceAlertStore {
  constructor(private readonly poolProvider: () => any = () => dbConnection.getPool()) {}

  async getCollectionEnabledDevices(): Promise<NetworkDeviceAlertDevice[]> {
    const pool = this.pool();
    const [rows] = await pool.execute(
      'SELECT id, name, label, host, status, collection_enabled AS collectionEnabled FROM network_devices WHERE collection_enabled = 1 ORDER BY id',
    );
    return (rows as any[]).map((row) => ({ ...row, id: Number(row.id), collectionEnabled: Boolean(row.collectionEnabled) }));
  }

  async getLatestObservations(deviceId: number): Promise<NetworkDeviceAlertObservation[]> {
    const pool = this.pool();
    const [rows] = await pool.execute(
      `SELECT metric_id AS metricId, metric_value AS value, dimensions, observed_at AS observedAt,
              valid_until AS validUntil, quality, reason
       FROM network_device_observations WHERE device_id = ?
       ORDER BY observed_at DESC, id DESC LIMIT 2000`, [deviceId],
    );
    return (rows as any[]).map((row) => this.row(row));
  }

  async getObservationHistory(deviceId: number, metricId: string, dimensions: Record<string, string> | undefined, from: Date, limit: number): Promise<NetworkDeviceAlertObservation[]> {
    const pool = this.pool();
    const [rows] = await pool.execute(
      `SELECT metric_id AS metricId, metric_value AS value, dimensions, observed_at AS observedAt,
              valid_until AS validUntil, quality, reason
       FROM network_device_observations WHERE device_id = ? AND metric_id = ? AND observed_at >= ?
       ORDER BY observed_at ASC, id ASC LIMIT ${limit}`, [deviceId, metricId, from],
    );
    return (rows as any[]).map((row) => this.row(row)).filter((row) => sameDimensions(row.dimensions, dimensions));
  }

  private row(row: any): NetworkDeviceAlertObservation {
    return {
      metricId: String(row.metricId),
      value: row.value == null ? null : Number(row.value),
      dimensions: parseDimensions(row.dimensions),
      quality: row.quality as ObservationQuality,
      observedAt: row.observedAt ? new Date(row.observedAt) : null,
      validUntil: row.validUntil ? new Date(row.validUntil) : null,
      reason: row.reason == null ? undefined : String(row.reason),
    };
  }

  private pool(): any {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

export const networkDeviceAlertEvaluator = new NetworkDeviceAlertEvaluator();
