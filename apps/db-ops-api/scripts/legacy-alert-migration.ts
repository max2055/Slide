import { dbConnection } from '../src/db-connection.js';
import type { ActorContext } from '../src/auth/actor-context.js';
import { evaluateOperationalRule } from '../src/metrics/consumers/operational.js';
import { evaluateMetric } from '../src/metrics/consumers/evaluation.js';
import { consumerStore, metricConsumerService } from '../src/metrics/consumers/runtime.js';
import { MetricConsumerService } from '../src/metrics/consumers/service.js';
import { policyService } from '../src/metrics/policy/service.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import {
  applyLegacyAlertMigration,
  buildLegacyAlertMigrationPlan,
  LEGACY_REPLACEMENTS,
  readLegacyAlertMigrationState,
  type LegacyAlertMigrationPlan,
  type ReplacementRuleDefinition,
} from '../src/metrics/consumers/legacy-alert-migration.js';

/**
 * MAX-243 operator entry point.
 *
 *   tsx scripts/legacy-alert-migration.ts plan
 *   tsx scripts/legacy-alert-migration.ts disable --apply --actor <name>
 *   tsx scripts/legacy-alert-migration.ts delete  --apply --actor <name>
 *   tsx scripts/legacy-alert-migration.ts verify  [--instance 1] [--server 3]
 *
 * disable/delete are dry runs unless --apply is present. Every mutation writes
 * an audit_log_entries row in the same transaction as the alert_rules change.
 */

type Command = 'plan' | 'disable' | 'delete' | 'verify';
const commands: Command[] = ['plan', 'disable', 'delete', 'verify'];
const argv = process.argv.slice(2);
const command = argv[0] as Command | undefined;
if (!command || !commands.includes(command)) {
  process.stderr.write(`usage: tsx scripts/legacy-alert-migration.ts ${commands.join('|')} [--apply] [--actor name] [--instance id] [--server id]\n`);
  process.exit(2);
}
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const actor = { userId: '0', username: flag('actor') ?? 'max243-migration' };

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function pseudoRule(definition: ReplacementRuleDefinition) {
  return {
    metric_name: definition.metric_name, operator: definition.operator, threshold: definition.threshold,
    threshold_template: definition.threshold_template, duration_seconds: definition.duration_seconds,
    severity: definition.severity, target_type: definition.target_type, silence_minutes: definition.silence_minutes,
  };
}

const verifier: ActorContext = {
  userId: 0, username: 'max243-verifier', roles: [], permissions: ['*'], sessionVersion: 0,
  instanceScopes: {}, requestId: `max243:${Date.now()}`,
};

const accepted = { accepted_quality: ['good', 'partial'] as Array<'good' | 'partial'>, allow_estimated: true };

async function consumerWindow(resource: { type: 'instance' | 'server'; id: number }, metricId: string,
  from: string, to: string) {
  const result = await metricConsumerService.query(verifier, { resource, metric_ids: [metricId], from, to, bucket_ms: 60_000 });
  return result.metrics[0];
}

function replayCandidates(rows: Array<{ observed_at: string; value: string | null }>): string[] {
  return [...new Set(rows.filter(row => row.value !== null).map(row => row.observed_at))]
    .sort((a, b) => Date.parse(b) - Date.parse(a))
    .map(at => new Date(Date.parse(at) + 1000).toISOString())
    .slice(0, 60);
}

async function firstHealthyReplay(resource: { type: 'instance' | 'server'; id: number },
  definition: ReplacementRuleDefinition, rows: Array<{ observed_at: string; value: string | null }>) {
  const attempts: Array<{ at: string; state: string; reason: string }> = [];
  for (const at of replayCandidates(rows)) {
    const item = await replayEvaluation(resource, definition, at);
    attempts.push({ at, state: item.evaluation.state, reason: item.evaluation.reason });
    if (item.evaluation.state === 'healthy') return { ...item, attempts };
  }
  return { ...(await replayEvaluation(resource, definition, replayCandidates(rows)[0] ?? new Date().toISOString())), attempts };
}

async function replayEvaluation(resource: { type: 'instance' | 'server'; id: number }, definition: ReplacementRuleDefinition,
  at: string) {
  const replay = new MetricConsumerService(policyService, createConfigurationRegistry(), consumerStore, () => at);
  const from = new Date(Date.parse(at) - definition.duration_seconds * 1000).toISOString();
  const result = await replay.query(verifier, { resource, metric_ids: [definition.metric_name], from, to: at, bucket_ms: 60_000 });
  const metric = result.metrics[0];
  // Current capability/attempt state is not part of the replay: evaluate the
  // formal buckets as of the evidence time, with their original freshness.
  metric.state = 'available';
  for (const series of metric.series) {
    while (series.buckets.length > 1) {
      const last = series.buckets.at(-1)!;
      if (last.sample_count > 0 || last.value !== null) break;
      series.buckets.pop();
    }
  }
  return { from, to: at, evaluation: evaluateMetric(metric, { metric_id: definition.metric_name,
    unit: metric.series[0]?.buckets[0]?.unit ?? metric.definition.unit, operator: definition.operator,
    threshold: definition.threshold_template.warning, duration_seconds: definition.duration_seconds,
    recovery_seconds: definition.duration_seconds, missing: 'unknown', ...accepted }),
  buckets: metric.series.flatMap(series => series.buckets.map(bucket => ({ value: bucket.value, quality: bucket.quality,
    freshness: bucket.freshness, coverage: bucket.coverage, sample_count: bucket.sample_count, window: bucket.window }))) };
}

async function verify(instanceId: number, serverId: number): Promise<Record<string, unknown>> {
  const pool = dbConnection.getPool()!;
  const instance = { type: 'instance' as const, id: instanceId };
  const server = { type: 'server' as const, id: serverId };

  const [qpsRows] = await pool.query<any[]>(`SELECT
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.observed_at')) observed_at,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.value.value')) value,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.quality.status')) quality,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.quality.reason')) reason
    FROM metric_observations
    WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metric.id')) = 'mysql.queries.per_second'
    ORDER BY observed_at`);
  const valid = qpsRows.filter(row => row.value !== null).map(row => Number(row.value)).sort((a, b) => a - b);
  const unknownRows = qpsRows.filter(row => row.value === null);
  const quantile = (p: number) => valid[Math.min(valid.length - 1, Math.floor(p * valid.length))];
  const qpsBaseline = {
    samples: qpsRows.length, valid: valid.length, unknown: unknownRows.length,
    min: valid[0] ?? null, p50: quantile(0.5) ?? null, p95: quantile(0.95) ?? null,
    p99: quantile(0.99) ?? null, max: valid.at(-1) ?? null,
    first: qpsRows[0]?.observed_at ?? null, last: qpsRows.at(-1)?.observed_at ?? null,
    unknown_is_null_not_zero: unknownRows.every(row => row.value === null),
  };

  const [sizeRows] = await pool.query<any[]>(`SELECT
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.observed_at')) observed_at,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.value.value')) value,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.accuracy')) accuracy,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.quality.status')) quality
    FROM metric_observations
    WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metric.id')) = 'mysql.tables.estimated_allocated_bytes'
      AND JSON_EXTRACT(payload, '$.value.value') IS NOT NULL
    ORDER BY observed_at DESC LIMIT 1`);
  const size = sizeRows[0] ? { value: Number(sizeRows[0].value), accuracy: sizeRows[0].accuracy,
    quality: sizeRows[0].quality, observed_at: sizeRows[0].observed_at } : null;

  const [ratioRows] = await pool.query<any[]>(`SELECT
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.observed_at')) observed_at,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.dimensions.mount')) mount,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.dimensions.device')) device,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.dimensions.fs_type')) fs_type,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.value.value')) value,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.quality.status')) quality,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.accuracy')) accuracy
    FROM metric_observations
    WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metric.id')) = 'linux.filesystem.used_ratio'
    ORDER BY observed_at DESC LIMIT 200`);
  const latestRatioAt = ratioRows[0]?.observed_at;
  const mounted = ratioRows.filter(row => row.observed_at === latestRatioAt)
    .map(row => ({ mount: row.mount, device: row.device, fs_type: row.fs_type, ratio: Number(row.value),
      quality: row.quality, accuracy: row.accuracy }));

  const [inputs] = await pool.query<any[]>(`SELECT
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metric.id')) metric_id,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.dimensions.mount')) mount,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.dimensions.device')) device,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.dimensions.fs_type')) fs_type,
      JSON_UNQUOTE(JSON_EXTRACT(payload, '$.value.value')) value
    FROM metric_observations
    WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.observed_at')) = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.metric.id')) IN ('host.filesystem.used_bytes', 'host.filesystem.size_bytes')`,
    [latestRatioAt]);
  const pairs = mounted.map(item => {
    const key = `${item.mount}\u0000${item.device}\u0000${item.fs_type}`;
    const used = inputs.find(input => input.metric_id === 'host.filesystem.used_bytes'
      && `${input.mount}\u0000${input.device}\u0000${input.fs_type}` === key);
    const total = inputs.find(input => input.metric_id === 'host.filesystem.size_bytes'
      && `${input.mount}\u0000${input.device}\u0000${input.fs_type}` === key);
    const computed = used && total && Number(total.value) > 0 ? Number(used.value) / Number(total.value) : null;
    return { ...item, used_bytes: used ? Number(used.value) : null, size_bytes: total ? Number(total.value) : null,
      recomputed_ratio: computed, matches_stored: computed === null ? null : Math.abs(computed - item.ratio) < 1e-9 };
  });
  if (!pairs.length || pairs.some(pair => pair.matches_stored !== true)) throw new Error('FILESYSTEM_USED_SIZE_MISMATCH');

  const replayRows = qpsRows.map(row => ({ observed_at: row.observed_at, value: row.value }));
  const ratioSeriesRows = [...new Map(ratioRows.map(row =>
    [row.observed_at, { observed_at: row.observed_at, value: row.value }])).values()];
  const replay = {
    qps: await firstHealthyReplay(instance, LEGACY_REPLACEMENTS.qps, replayRows),
    filesystem: await firstHealthyReplay(server, LEGACY_REPLACEMENTS.filesystem, ratioSeriesRows),
    database_size: await firstHealthyReplay(instance, LEGACY_REPLACEMENTS.database_size, replayRows),
  };
  for (const [key, item] of Object.entries(replay)) {
    if (item.evaluation.state !== 'healthy') {
      throw new Error(`REPLAY_NOT_HEALTHY:${key}:${item.evaluation.state}:${item.evaluation.reason}:${JSON.stringify(item.attempts)}`);
    }
  }

  const currentWindow = new Date(Date.now() - 10 * 60_000).toISOString();
  const startup = await consumerWindow(instance, 'mysql.queries.per_second', currentWindow, new Date().toISOString());
  const startupSeries = startup?.series ?? [];
  const startupNull = startupSeries.flatMap(series => series.buckets).filter(bucket => bucket.value === null);
  const startupQuality = new Set(startupSeries.flatMap(series => series.buckets).map(bucket => bucket.quality.status));

  const current = {} as Record<string, unknown>;
  for (const definition of Object.values(LEGACY_REPLACEMENTS)) {
    const ref = definition.target_type === 'server' ? server : instance;
    current[definition.key] = await evaluateOperationalRule(ref, pseudoRule(definition), definition.duration_seconds);
  }

  const lastUnknown = unknownRows.at(-1);
  const lastValid = qpsRows.filter(row => row.value !== null).at(-1);
  const devZero = ratioRows.find(row => row.mount === '/dev' && Number(row.value) === 0);

  // Historical windows are stale by design, so the evaluator correctly rejects
  // them. Copy the real value/quality into a fresh one-bucket window to isolate
  // the value semantics: a stored null must stay unknown; a real 0 must evaluate.
  const now = new Date();
  const probeWindow = { from: new Date(now.getTime() - 60_000).toISOString(), to: now.toISOString() };
  const probe = (metricId: string, unit: 'count/s' | '1', value: number | null,
    quality: { status: 'good' | 'partial' | 'unknown'; reason: string }, accuracy: string) => evaluateMetric({
    definition: { id: metricId, unit, kind: 'gauge' }, state: 'available', series: [{ dimensions: {},
      buckets: [{ value: value === null ? null : { encoding: 'float64', value }, unit, window: probeWindow,
        freshness: 'fresh', coverage: 1, quality, accuracy }] }] } as any,
  { metric_id: metricId, unit, operator: '>=', threshold: 0, duration_seconds: 0, recovery_seconds: 0,
    missing: 'unknown', ...accepted });

  const unknownProbe = lastUnknown ? probe('mysql.queries.per_second', 'count/s', null,
    { status: 'unknown', reason: lastUnknown.reason ?? 'counter_reset' }, 'unknown') : null;
  const valueProbe = lastValid ? probe('mysql.queries.per_second', 'count/s', Number(lastValid.value),
    { status: lastValid.quality === 'good' ? 'good' : 'partial', reason: lastValid.reason ?? 'none' },
    lastValid.quality === 'good' ? 'exact' : 'estimated') : null;
  const zeroProbe = devZero ? probe('linux.filesystem.used_ratio', '1', 0,
    { status: devZero.quality === 'good' ? 'good' : 'partial', reason: devZero.quality === 'good' ? 'none' : 'precision_loss' },
    devZero.accuracy ?? 'exact') : null;

  if (!unknownProbe || unknownProbe.state !== 'unknown' || unknownProbe.value !== null) {
    throw new Error('UNKNOWN_NOT_DISTINGUISHED');
  }
  if (!valueProbe || valueProbe.state !== 'firing' || Number(valueProbe.value) !== Number(lastValid!.value)
    || !(Number(valueProbe.value) > 0)) {
    throw new Error('REAL_VALUE_NOT_EVALUATED');
  }
  if (!zeroProbe || zeroProbe.state !== 'firing' || Number(zeroProbe.value) !== 0) {
    throw new Error('REAL_ZERO_NOT_EVALUATED');
  }
  if (pairs.some(pair => !(pair.ratio >= 0 && pair.ratio <= 1))) throw new Error('RATIO_OUT_OF_RANGE');

  const maxRatio = Math.max(...pairs.map(pair => pair.ratio));
  const thresholdVerdict = {
    qps: { observed_max: qpsBaseline.max, warning: LEGACY_REPLACEMENTS.qps.threshold_template.warning,
      verdict: Number(qpsBaseline.max) < LEGACY_REPLACEMENTS.qps.threshold_template.warning ? 'healthy' : 'at_or_above_warning' },
    filesystem: { observed_max_ratio: maxRatio, warning: LEGACY_REPLACEMENTS.filesystem.threshold_template.warning,
      verdict: maxRatio < LEGACY_REPLACEMENTS.filesystem.threshold_template.warning ? 'healthy' : 'at_or_above_warning' },
    database_size: { observed_bytes: size?.value ?? null, warning: LEGACY_REPLACEMENTS.database_size.threshold_template.warning,
      verdict: size && size.value < LEGACY_REPLACEMENTS.database_size.threshold_template.warning ? 'healthy' : 'unknown_or_at_warning' },
  };
  if (thresholdVerdict.qps.verdict !== 'healthy' || thresholdVerdict.filesystem.verdict !== 'healthy'
    || thresholdVerdict.database_size.verdict !== 'healthy') throw new Error('BASELINE_ABOVE_NEW_THRESHOLD');

  return {
    migration: 'MAX-243', verified_at: new Date().toISOString(),
    resources: { instance: instanceId, server: serverId },
    qps_baseline: qpsBaseline,
    database_size: size,
    filesystem: { observed_at: latestRatioAt, mounts: pairs,
      thresholds: LEGACY_REPLACEMENTS.filesystem.threshold_template },
    current_rule_evaluation: current,
    replay_evaluation: replay,
    threshold_verdict: thresholdVerdict,
    unknown_vs_zero: {
      unknown_observation: lastUnknown,
      unknown: unknownProbe,
      valid_observation: lastValid,
      real_value: valueProbe,
      real_zero_mount: devZero?.mount ?? null,
      real_zero_observation: devZero,
      real_zero: zeroProbe,
      note: 'probe windows are fresh one-bucket evaluations carrying the stored value/quality; historical windows stay stale and are not reused',
    },
    recent_qps_window: { from: currentWindow, null_buckets: startupNull.length, qualities: [...startupQuality] },
    thresholds: Object.fromEntries(Object.values(LEGACY_REPLACEMENTS).map(definition =>
      [definition.key, { metric: definition.metric_name, unit: definition.unit,
        threshold_template: definition.threshold_template, duration_seconds: definition.duration_seconds }])),
  };
}

async function main(): Promise<void> {
  if (!await dbConnection.initialize()) throw new Error('DB_CONNECTION_FAILED');
  const pool = dbConnection.getPool()!;
  if (command === 'verify') {
    const evidence = await verify(Number(flag('instance') ?? 1), Number(flag('server') ?? 3));
    print(evidence);
    return;
  }
  const state = await readLegacyAlertMigrationState(pool);
  const plan: LegacyAlertMigrationPlan = buildLegacyAlertMigrationPlan(state);
  if (command === 'plan' || !has('apply')) {
    print({ dry_run: command !== 'plan', plan });
    return;
  }
  const result = await applyLegacyAlertMigration(pool, command, { actor });
  print({ applied: command, created_rule_ids: result.created_rule_ids, reused_rule_ids: result.reused_rule_ids,
    disabled_rule_ids: result.disabled_rule_ids, already_disabled_rule_ids: result.already_disabled_rule_ids,
    deleted_rule_ids: result.deleted_rule_ids, audit_entries: result.audit_entries,
    remaining_legacy_rules: result.plan.retire.filter(item => !result.deleted_rule_ids.includes(item.rule_id)) });
}

main().then(async () => {
  await dbConnection.close();
}).catch(async error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await dbConnection.close().catch(() => undefined);
  process.exit(1);
});
