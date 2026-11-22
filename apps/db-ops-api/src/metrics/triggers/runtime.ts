import { continuesAfterPinRemoval } from './provider-state.js';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { NormalizedObservationSchema, type NormalizedObservation } from '../../contracts/metrics/index.js';
import {
  TriggerSampleSchema, TRIGGER_LIMITS, type TriggerRuleSnapshot, type TriggerSample,
} from '../../contracts/metrics/triggers.js';
import { BINDING_APPLIED_ENVELOPE, decodeBindingPayload, type DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import { verifyTriggerSnapshot, checkTriggerSnapshotFence } from './compile.js';
import { evaluateTriggerRule, triggerSampleQualityFault } from './evaluate.js';
import { nextTriggerEpisode, triggerEpisodeIdentityHash, type TriggerEpisodeRecord } from './episode.js';
import { hashOf, orderTriggerDependencies, triggerSelectors } from './model.js';
import { stable } from '../packages/model.js';
import { blockingDependencies } from '../../alert-dependencies.js';
import { alertEventService } from '../../alert-event-service.js';
import { assetCollectionEnabled } from '../config/effective-state.js';
import { rule as requireRule } from '../policy/model.js';
import { discoveryRows } from '../templates/discovery-store.js';
import { itemIntervals } from '../bindings/plan.js';
import { metricKey } from '../policy/model.js';

const decode = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const keyOf = (decoded: DecodedTemplateBindingPayload) =>
  `${decoded.binding.resource.type}:${decoded.binding.resource.id}`;

const maxWindow = (selectors: ReturnType<typeof triggerSelectors>) =>
  Math.max(0, ...selectors.map(selector => selector.aggregation === 'last' ? 0 : selector.window_ms));

const inputLimit = 4096;
async function readTriggerInputs(c: PoolConnection, hash: string, now: number, sourceCount = 1, arriving = 0) {
  const limit = inputLimit * sourceCount + arriving;
  const [rows] = await c.execute<RowDataPacket[]>(
    `SELECT sample_id,observed_at,payload FROM metric_trigger_inputs
     WHERE identity_hash=? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at,sample_id LIMIT ${limit + 1}`,
    [hash, new Date(now - TRIGGER_LIMITS.max_window_ms), new Date(now)],
  );
  requireRule(rows.length <= limit, 'TRIGGER_INPUT_BUDGET');
  return rows;
}

type CombinationInput = { metric: NormalizedObservation['metric']; observed_at: string; sample: TriggerSample | null };
type TriggerApplicationProof = ReadonlyMap<string, { sample: string; attempt: string; observed_ms: number }>;

function triggerDependencyOrder(rules: readonly TriggerRuleSnapshot[]) {
  const upstreamByRule = new Map<TriggerRuleSnapshot, TriggerRuleSnapshot[]>();
  if (!rules.some(rule => rule.dependencies?.length)) return { rules, upstreamByRule };
  const templates = new Map<string, TriggerRuleSnapshot[]>();
  for (const rule of rules) {
    const id = rule.item.template_id;
    const group = templates.get(id) ?? [];
    group.push(rule);
    templates.set(id, group);
  }
  const ordered = [...templates.values()].flatMap(group => {
    const byId = new Map(group.map(rule => [rule.rule_id, rule]));
    return orderTriggerDependencies(group).map(rule => {
      const upstream = (rule.dependencies ?? []).flatMap(id => {
        const parent = byId.get(id)!;
        return [parent, ...upstreamByRule.get(parent)!];
      });
      upstreamByRule.set(rule, [...new Set(upstream)]);
      return rule;
    });
  });
  return { rules: ordered, upstreamByRule };
}

const activeTriggerInput = (input: Pick<TriggerRuleSnapshot, 'decision'>) =>
  input.decision === 'collect' || input.decision === 'derive';

async function allowDependentEvaluation(c: PoolConnection, identity: { hash: string; key: string; ruleId: string; at: string },
  blockers: string[], evidence: { accepted: number; usable: boolean; clockOnly: boolean }) {
  const { hash, key, ruleId, at } = identity;
  if (blockers.length) {
    await c.execute('INSERT INTO alert_dependency_decisions VALUES(?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)',
      [hash, key, JSON.stringify({ at, rule_id: ruleId, blocked: true, dependencies: [],
        template_dependencies: blockers, waiting_for_sample: true })]);
    return false;
  }
  if (!evidence.accepted && !evidence.clockOnly) return false;
  const [decisions] = await c.execute<RowDataPacket[]>(
    'SELECT payload FROM alert_dependency_decisions WHERE identity_hash=?', [hash]);
  const waiting = decisions[0] && decode<{ waiting_for_sample?: boolean }>(decisions[0].payload).waiting_for_sample;
  if (!waiting) return true;
  // A clock tick or unusable input cannot replay evidence held by the dependency.
  if (!evidence.usable) return false;
  await c.execute('UPDATE alert_dependency_decisions SET payload=? WHERE identity_hash=?',
    [JSON.stringify({ at, rule_id: ruleId, blocked: false, dependencies: [], template_dependencies: [] }), hash]);
  return true;
}

function combinationSamples(inputs: RowDataPacket[], windows: Map<string, number>, intervals: Map<string, number>,
  defaultInterval: number, now: number) {
  const series = new Map<string, Array<CombinationInput & { id: string }>>();
  const expired: string[] = [];
  for (const row of inputs) {
    const input = decode<CombinationInput>(row.payload);
    const key = metricKey(input.metric);
    const rows = series.get(key) ?? [];
    rows.push({ ...input, id: String(row.sample_id) });
    series.set(key, rows);
  }
  const samples = [...series.entries()].flatMap(([key, rows]) => {
    const window = windows.get(key) ?? 0;
    const interval = intervals.get(key) ?? defaultInterval;
    const cutoff = now - window - Math.ceil(interval * 1.25);
    const kept = rows.filter((row, index) => {
      if (index === rows.length - 1 || (window && Date.parse(row.observed_at) >= cutoff)) return true;
      expired.push(row.id);
      return false;
    });
    requireRule(kept.length <= inputLimit, 'TRIGGER_INPUT_BUDGET');
    const last = kept.at(-1)?.sample;
    if (!last) return [];
    // A last() leaf may share an operand with a shorter window leaf.
    if (!window || Date.parse(last.observed_at) < now - window) return [last];
    return kept.flatMap(({ sample }, i) => {
      if (!sample || Date.parse(sample.observed_at) < now - window) return [];
      const prior = kept[i - 1]?.sample;
      const gap = prior ? Date.parse(sample.observed_at) - Date.parse(prior.observed_at) : Infinity;
      return [{ ...sample, window: prior && gap > 0 && gap <= interval * 1.25
        ? { from: prior.observed_at, to: sample.observed_at } : null }];
    });
  });
  return { samples, expired };
}

/** Called by the one formal writer on its own transaction connection, or by the existing alert clock. */
export async function evaluateTemplateSamples(
  c: PoolConnection,
  binding: DecodedTemplateBindingPayload,
  observations: NormalizedObservation[],
  now: number,
  clockOnly = false,
  applicationProof?: TriggerApplicationProof,
): Promise<void> {
  if (!binding.pending.plan.triggers.some((t) => t.refs.length)) return;
  // Serialize dependency decisions with graph edits and other upstream transitions.
  await c.execute('SELECT id FROM alert_dependency_lock WHERE id=1 FOR UPDATE');
  const key = keyOf(binding);
  const [rows] = await c.execute<RowDataPacket[]>(
    'SELECT payload FROM metric_trigger_snapshots WHERE resource_key=? AND config_revision=?',
    [key, binding.binding.revision],
  );
  requireRule(rows.length === 1, 'TRIGGER_SNAPSHOT_MISSING');
  const snapshot = verifyTriggerSnapshot(decode(rows[0].payload));
  const [priorRows] = await c.execute<RowDataPacket[]>(
    'SELECT payload FROM metric_trigger_snapshots WHERE resource_key=? AND config_revision=?',
    [key, snapshot.config_revision - 1],
  );
  const priorSnapshot = priorRows[0] ? verifyTriggerSnapshot(decode(priorRows[0].payload)) : null;
  const applied = {
    resource: binding.binding.resource,
    applied_revision: binding.application.applied_revision,
    application_status: binding.application.status,
    plan_identity: binding.application.resolution_identity,
  };
  requireRule(checkTriggerSnapshotFence(snapshot, applied).ok, 'TRIGGER_NOT_APPLIED');
  // Like Zabbix's event dependency check, use the upstream transitions from this batch.
  const dependencyOrder = triggerDependencyOrder(snapshot.rules);
  const upstreamRules = new Set([...dependencyOrder.upstreamByRule.values()].flat());
  const primed: NormalizedObservation[] = [];
  const primingRules = snapshot.rules.filter(rule => rule.inputs || upstreamRules.has(rule));
  if (applicationProof && primingRules.length) {
    const keys = new Set(primingRules.flatMap(rule => [rule, ...(rule.inputs ?? [])].map(input => metricKey(input.metric))));
    const arriving = new Set(observations.map(observation => observation.id));
    const ids = [...new Set([...applicationProof].filter(([key, fact]) => keys.has(key) && !arriving.has(fact.sample))
      .map(([, fact]) => fact.sample))];
    if (ids.length) {
      const [prior] = await c.execute<RowDataPacket[]>(
        `SELECT payload FROM metric_observations WHERE stage='normalized' AND id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const row of prior) {
        const sample = NormalizedObservationSchema.parse(decode(row.payload));
        const fact = applicationProof.get(metricKey(sample.metric));
        requireRule(fact?.sample === sample.id && fact.attempt === sample.source.attempt_id
          && fact.observed_ms === Date.parse(sample.observed_at) && sample.versions.config_revision === snapshot.config_revision
          && sample.resource_type === snapshot.resource.type && sample.resource_id === snapshot.resource.id, 'TRIGGER_APPLICATION_EVIDENCE');
        primed.push(sample);
      }
    }
  }
  const at = new Date(now).toISOString();
  const discoveries = await discoveryRows(c, key);
  const intervals = itemIntervals(binding.pending.plan.releases);
  const discoveryFor = (rule: TriggerRuleSnapshot) => discoveries.filter(row =>
    row.template_id === rule.item.template_id && row.state.config_revision === snapshot.config_revision
    && row.state.triggers.some(t => t.rule_id === rule.rule_id && t.scope === rule.scope));
  const admittedMembers = (rows: ReturnType<typeof discoveryFor>) => new Map(rows.flatMap(row =>
    row.state.members.filter(m => ['active', 'waiting'].includes(m.state)).map(m => [stable(m.dimensions), m] as const)));
  const openUpstream = new Map<TriggerRuleSnapshot, boolean>();
  const isUpstreamOpen = async (rule: TriggerRuleSnapshot) => {
    const cached = openUpstream.get(rule);
    if (cached !== undefined) return cached;
    let open = false;
    if ([rule, ...(rule.inputs ?? [])].some(activeTriggerInput)) {
      const discovered = discoveryFor(rule);
      const admitted = admittedMembers(discovered);
      const revisions = [snapshot.config_revision];
      if (!discovered.length && continuesAfterPinRemoval(priorSnapshot, snapshot, rule)) {
        revisions.push(snapshot.config_revision - 1);
      }
      const [heads] = await c.execute<RowDataPacket[]>(
        `SELECT dimensions,payload FROM metric_trigger_heads
         WHERE resource_key=? AND config_revision IN (${revisions.map(() => '?').join(',')})
           AND rule_id=? AND payload IS NOT NULL FOR SHARE`,
        [key, ...revisions, rule.rule_id],
      );
      open = heads.some(row => {
        const previous = decode<TriggerEpisodeRecord>(row.payload);
        // An unknown evaluation retains an already open upstream problem.
        return previous.state === 'open' && previous.version === rule.version && previous.body_hash === rule.body_hash
          && previous.scope === rule.scope && previous.opened.item.template_id === rule.item.template_id
          && (!discovered.length || admitted.has(stable(decode(row.dimensions))));
      });
    }
    openUpstream.set(rule, open);
    return open;
  };
  for (const rule of dependencyOrder.rules) {
    const primaryKey = metricKey(rule.metric);
    const defaultInterval = binding.pending.plan.settings.interval_ms;
    const interval = intervals.get(primaryKey) ?? defaultInterval;
    const inputsByItem = new Map([rule, ...(rule.inputs ?? [])].map(input => [input.item.item_id, input]));
    const activeMetrics = new Set([...inputsByItem.values()].filter(activeTriggerInput)
      .map(input => metricKey(input.metric)));
    if (!activeMetrics.size) continue;
    const operandKey = (id: string | undefined) => {
      const input = inputsByItem.get(id ?? rule.item.item_id);
      requireRule(input, 'TRIGGER_ITEM_UNKNOWN');
      return metricKey(input.metric);
    };
    const problemSelectors = triggerSelectors(rule.problem);
    const problemMetrics = new Set(problemSelectors.map(selector => operandKey(selector.item_id)));
    const windowSelectors = [...problemSelectors, ...triggerSelectors(rule.recovery)];
    const windowMs = maxWindow(windowSelectors);
    const historyMs = rule.inputs
      ? Math.min(TRIGGER_LIMITS.max_window_ms, Math.max(rule.clock.stale_after_ms,
          windowMs + Math.ceil(Math.max(...[...activeMetrics].map(key => intervals.get(key) ?? defaultInterval)) * 1.25)))
      : TRIGGER_LIMITS.max_window_ms;
    const operandWindows = new Map([...activeMetrics].map(key =>
      [key, maxWindow(windowSelectors.filter(selector => operandKey(selector.item_id) === key))]));
    const matching = (rule.inputs || upstreamRules.has(rule) ? [...primed, ...observations] : observations).filter(
      (o) => activeMetrics.has(metricKey(o.metric)) && (!rule.inputs || !Object.keys(o.dimensions).length),
    );
    const upstream = dependencyOrder.upstreamByRule.get(rule) ?? [];
    const unitsByMetric = new Map([...inputsByItem.values()].map(input => [metricKey(input.metric), input.unit]));
    const templateBlockers: string[] = [];
    for (const parent of upstream) {
      if (await isUpstreamOpen(parent)) templateBlockers.push(parent.rule_id);
    }
    if (rule.inputs && !clockOnly && !matching.length && !templateBlockers.length) continue;
    const dimensions = new Map<string, Record<string, string>>();
    for (const o of matching) dimensions.set(stable(o.dimensions), o.dimensions);
    // Clock and failed/missing collection also revisit existing dimensional heads.
    const [heads] = await c.execute<RowDataPacket[]>(
      'SELECT rule_id,dimensions FROM metric_trigger_heads WHERE resource_key=? AND config_revision=?',
      [key, snapshot.config_revision],
    );
    for (const head of heads) {
      if (String(head.rule_id) === rule.rule_id) {
        const dims = decode<Record<string, string>>(head.dimensions);
        dimensions.set(stable(dims), dims);
      }
    }
    if (!dimensions.size) dimensions.set('{}', {});
    const discovered = discoveryFor(rule);
    const admitted = admittedMembers(discovered);
    if (discovered.length) {
      for (const dim of dimensions.keys()) if (!admitted.has(dim)) dimensions.delete(dim);
    } else {
      requireRule(dimensions.size <= TRIGGER_LIMITS.max_series, 'TRIGGER_SERIES_BUDGET');
    }
    // Discovered members already passed the collection budget and are evaluated one at a time.
    // The expression-wide series limit still applies inside the evaluator.
    for (const dims of dimensions.values()) {
      const instance = admitted.get(stable(dims));
      let identity = {
        resource: snapshot.resource,
        rule_id: rule.rule_id,
        version: rule.version,
        body_hash: rule.body_hash,
        scope: rule.scope,
        context_hash: hashOf({ snapshot: snapshot.snapshot_hash, item: rule.item,
          ...(instance?{discovery_instance:instance.id}:{dimensions:dims}) }),
      };
      let hash = triggerEpisodeIdentityHash(identity);
      let continued = false;
      if (!discovered.length && continuesAfterPinRemoval(priorSnapshot, snapshot, rule)) {
        const [priorHeads] = await c.execute<RowDataPacket[]>(
          `SELECT h.identity_hash,h.payload,h.dimensions,e.snapshot FROM metric_trigger_heads h
          JOIN metric_trigger_episodes e ON e.episode_id=JSON_UNQUOTE(JSON_EXTRACT(h.payload,'$.episode_id'))
          WHERE h.resource_key=? AND h.config_revision=? AND h.rule_id=? FOR UPDATE`,
          [key, snapshot.config_revision - 1, rule.rule_id],
        );
        const prior = priorHeads.filter(head => head.payload && stable(decode(head.dimensions)) === stable(dims));
        if (prior.length === 1) {
          const record = decode<TriggerEpisodeRecord>(prior[0].payload);
          const origin = verifyTriggerSnapshot(decode<{ configuration: unknown }>(prior[0].snapshot).configuration);
          identity = { resource: record.resource, rule_id: record.rule_id, version: record.version,
            body_hash: record.body_hash, scope: record.scope,
            context_hash: hashOf({ snapshot: origin.snapshot_hash, item: rule.item, dimensions: dims }) };
          hash = triggerEpisodeIdentityHash(identity);
          requireRule(hash === String(prior[0].identity_hash), 'TRIGGER_HEAD_IDENTITY');
          await c.execute('UPDATE metric_trigger_heads SET config_revision=? WHERE identity_hash=?', [snapshot.config_revision, hash]);
          continued = true;
        }
      }
      if (!continued) {
        await c.execute(
          `INSERT INTO metric_trigger_heads(identity_hash,resource_key,config_revision,rule_id,dimensions) VALUES(?,?,?,?,?)
          ON DUPLICATE KEY UPDATE dimensions=VALUES(dimensions)`,
          [hash, key, snapshot.config_revision, rule.rule_id, JSON.stringify(dims)],
        );
      }
      const [locked] = await c.execute<RowDataPacket[]>(
        `SELECT payload,sample_watermark${rule.inputs ? ',source_watermarks' : ''} FROM metric_trigger_heads WHERE identity_hash=? FOR UPDATE`,
        [hash],
      );
      const previous = locked[0].payload ? decode<TriggerEpisodeRecord>(locked[0].payload) : null;
      const manuallyClosedAt = previous?.manual_close ? Date.parse(previous.closed_at!) : null;
      let watermark = locked[0].sample_watermark as string | null;
      const storedWatermarks = locked[0].source_watermarks;
      const sourceWatermarks = new Map<string, string>(storedWatermarks
        ? Object.entries(decode<Record<string, string>>(storedWatermarks)) : []);
      if (rule.inputs && !storedWatermarks && matching.length) {
        for (const row of await readTriggerInputs(c, hash, now, activeMetrics.size)) {
          const source = decode<CombinationInput>(row.payload);
          sourceWatermarks.set(metricKey(source.metric), source.observed_at);
        }
      }
      if (rule.inputs && watermark && (!sourceWatermarks.has(primaryKey)
        || Date.parse(sourceWatermarks.get(primaryKey)!) < Date.parse(watermark))) sourceWatermarks.set(primaryKey, watermark);
      let accepted = 0;
      let problemChanged = false;
      const usableSampleTimes = new Map<string, number>();
      for (const o of matching
        .filter((o) => stable(o.dimensions) === stable(dims))
        .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id.localeCompare(b.id))) {
        const observed = Date.parse(o.observed_at), source = metricKey(o.metric);
        const last = rule.inputs ? sourceWatermarks.get(source) : watermark;
        if (last && observed <= Date.parse(last)) continue;
        if (rule.inputs && (observed > now || observed < now - TRIGGER_LIMITS.max_window_ms)) continue;
        // This input cache is not a formal store; null/unusable evidence must still become unknown.
        const sample =
          o.value && 'encoding' in o.value && ['float64', 'int64', 'uint64'].includes(o.value.encoding)
            ? TriggerSampleSchema.parse({
                metric: o.metric,
                unit: o.unit,
                value: o.value,
                observed_at: o.observed_at,
                dimensions: o.dimensions,
                quality: o.quality,
                accuracy: o.accuracy,
                coverage: 1,
                window: null,
              })
            : null;
        await c.execute(
          'INSERT INTO metric_trigger_inputs(identity_hash,sample_id,observed_at,payload) VALUES(?,?,?,?)',
          [hash, o.id, new Date(o.observed_at), JSON.stringify({ sample, attempt_id: o.source.attempt_id,
            ...(rule.inputs ? { metric: o.metric, observed_at: o.observed_at } : {}) })],
        );
        sourceWatermarks.set(source, o.observed_at);
        if (source === primaryKey) watermark = o.observed_at;
        if (problemMetrics.has(source) && (manuallyClosedAt === null || observed > manuallyClosedAt)) problemChanged = true;
        if (upstream.length) {
          if (sample && sample.unit === unitsByMetric.get(source) && observed <= now
            && now - observed < rule.clock.stale_after_ms && !triggerSampleQualityFault(sample, rule.quality)) {
            usableSampleTimes.set(source, observed);
          } else {
            usableSampleTimes.delete(source);
          }
        }
        accepted++;
      }
      // Repeated messages cannot open another occurrence after recovery.
      if (!clockOnly && matching.length && !accepted && !templateBlockers.length) continue;
      // The current batch can push the cache past the bound before old rows are trimmed.
      const inputs = await readTriggerInputs(c, hash, now, activeMetrics.size, rule.inputs ? accepted : 0);
      const samples = inputs
        .map((row) => decode<{ sample: TriggerSample | null }>(row.payload).sample)
        .filter((s): s is TriggerSample => s !== null && stable(s.dimensions)===stable(dims));
      const combination = rule.inputs ? combinationSamples(inputs, operandWindows, intervals, defaultInterval, now) : null;
      const selected = combination ? combination.samples : windowMs
        ? samples
            .map((sample) => {
              const inputIndex = inputs.findIndex(row => decode<{sample:TriggerSample|null}>(row.payload).sample?.observed_at === sample.observed_at);
              const prior = inputIndex > 0 ? decode<{sample:TriggerSample|null}>(inputs[inputIndex-1].payload).sample : null,
                gap = prior ? Date.parse(sample.observed_at) - Date.parse(prior.observed_at) : Infinity;
              return {
                ...sample,
                window:
                  gap > 0 && gap <= interval * 1.25
                    ? { from: prior.observed_at, to: sample.observed_at }
                    : null,
              };
            })
            .filter((s) => Date.parse(s.observed_at) >= now - windowMs)
        : samples.slice(-1);
      // Keep valid scalar evidence for last and each shorter window. A null
      // breaks original adjacency above; each selector judges that gap itself.
      // A null newest formal value must not fall back to an older good value.
      const lastInput = inputs.at(-1);
      const newestUsable = lastInput && decode<{ sample: TriggerSample | null }>(lastInput.payload).sample;
      const usable = usableSampleTimes.size > 0;
      if (upstream.length) problemChanged = [...usableSampleTimes].some(([source, observed]) => problemMetrics.has(source)
        && (manuallyClosedAt === null || observed > manuallyClosedAt));
      const allowed = !upstream.length || await allowDependentEvaluation(c,
        { hash, key, ruleId: rule.rule_id, at }, templateBlockers, { accepted, usable, clockOnly });
      const evaluation = allowed ? evaluateTriggerRule(
        snapshot,
        { rule_id: rule.rule_id, scope: rule.scope, template_id: rule.item.template_id },
        {
          applied,
          input: {
            now: at,
            last_seen_at: watermark,
            previous: previous?.state === 'open' ? 'problem' : null,
            samples: rule.inputs || newestUsable ? selected : [],
          },
        },
      ) : null;
      let next = previous;
      if (evaluation && (!upstream.length || usable || clockOnly && evaluation.nodata
        || evaluation.business === 'unknown' && previous?.state === 'open' && !evaluation.nodata)) {
        const verdict = evaluation.nodata
          ? { ...evaluation, business: 'problem' as const, problem_open: true }
          : evaluation;
        next = nextTriggerEpisode({ identity, previous, evaluation: verdict });
        // Zabbix admits recovery-only samples to the expression history without opening a new problem.
        if (rule.inputs && !problemChanged && !evaluation.nodata && previous?.state !== 'open' && next?.state === 'open') next = previous;
        if (manuallyClosedAt !== null && next?.state === 'open' && !problemChanged) {
          // A new no-data deadline is evidence; a repeated clock tick over the same problem is not.
          const nodata = rule.clock.nodata;
          const newDeadline = evaluation.nodata && nodata.enabled && watermark
            && Date.parse(watermark) + nodata.after_ms > manuallyClosedAt;
          if (!newDeadline) next = previous;
        }
      }
      if (next?.state === 'open' && previous?.state !== 'open') {
        const blockers = await blockingDependencies(c, binding.binding.resource, rule.rule_id);
        await c.execute('INSERT INTO alert_dependency_decisions VALUES(?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)',
          [hash,key,JSON.stringify({at,rule_id:rule.rule_id,blocked:!!blockers.length,dependencies:blockers})]);
        if (blockers.length) next = previous; // Formal inputs remain; no new problem, no acknowledgement or fake recovery.
      }
      if (next && (next !== previous || !upstream.length)) {
        const evidenceKeys = new Set(selected.map(sample => `${metricKey(sample.metric)}\0${sample.observed_at}`));
        const evidenceRows = inputs.filter(row => {
          const { sample } = decode<{ sample: TriggerSample | null }>(row.payload);
          return sample && evidenceKeys.has(`${metricKey(sample.metric)}\0${sample.observed_at}`);
        });
        await alertEventService.persistTemplateTransition(c, previous, next, snapshot, {
          sample_ids: evidenceRows.map((row) => String(row.sample_id)),
          attempt_ids: [
            ...new Set(evidenceRows.map((row) => decode<{ attempt_id: string }>(row.payload).attempt_id)),
          ],
          samples: evidenceRows.map((row) => ({
            id: String(row.sample_id),
            ...decode<{ sample: TriggerSample }>(row.payload).sample,
          })),
          unit: rule.unit,
          dimensions: dims,
        });
      }
      await c.execute(`UPDATE metric_trigger_heads SET payload=?,sample_watermark=?${rule.inputs ? ',source_watermarks=?' : ''} WHERE identity_hash=?`, [
        next ? JSON.stringify(next) : null,
        watermark,
        ...(rule.inputs ? [JSON.stringify(Object.fromEntries(sourceWatermarks))] : []),
        hash,
      ]);
      const expired = combination?.expired ?? [];
      for (let offset = 0; offset < expired.length; offset += 1000) {
        const ids = expired.slice(offset, offset + 1000);
        await c.execute(`DELETE FROM metric_trigger_inputs WHERE identity_hash=? AND sample_id IN (${ids.map(() => '?').join(',')})`, [hash, ...ids]);
      }
      await c.execute('DELETE FROM metric_trigger_inputs WHERE identity_hash=? AND observed_at < ?', [
        hash,
        new Date(now - historyMs),
      ]);
    }
  }
}

/** No new scheduler or worker: the existing alert-engine minute clock calls this. */
export async function evaluateTemplateClock(pool: Pool, now = Date.now()) {
  const [bindings] = await pool.execute<RowDataPacket[]>(
    "SELECT resource_key FROM metric_policy_bindings WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.envelope')) = ?",
    [BINDING_APPLIED_ENVELOPE],
  );
  for (const row of bindings) {
    let c: PoolConnection | undefined;
    let reusable = false;
    try {
      c = await pool.getConnection();
      await c.beginTransaction();
      await c.execute('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');
      const [current] = await c.execute<RowDataPacket[]>(
        'SELECT payload FROM metric_policy_bindings WHERE resource_key=? FOR UPDATE',
        [row.resource_key],
      );
      const decoded = current[0] ? decodeBindingPayload(current[0].payload) : null;
      if (
        decoded?.kind === 'template_pending' &&
        decoded.application.status === 'applied' &&
        (await assetCollectionEnabled(c, decoded.binding.resource, true))
      )
        await evaluateTemplateSamples(c, decoded, [], now, true);
      await c.commit();
      reusable = true;
    } catch {
      try {
        await c?.rollback();
        reusable = true;
      } catch {
        /* discard */
      }
      console.error('[TemplateTriggers] Clock evaluation failed:', { resource: row.resource_key });
    } finally {
      if (reusable) c?.release();
      else c?.destroy();
    }
  }
}
