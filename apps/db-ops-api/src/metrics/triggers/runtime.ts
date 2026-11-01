import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { TriggerSampleSchema, TRIGGER_LIMITS, type TriggerSample } from '../../contracts/metrics/triggers.js';
import { decodeBindingPayload, type DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import { verifyTriggerSnapshot, checkTriggerSnapshotFence } from './compile.js';
import { evaluateTriggerRule } from './evaluate.js';
import { nextTriggerEpisode, triggerEpisodeIdentityHash, type TriggerEpisodeRecord } from './episode.js';
import { hashOf } from './model.js';
import { stable } from '../packages/model.js';
import { alertEventService } from '../../alert-event-service.js';
import { assetCollectionEnabled } from '../config/effective-state.js';
import { rule as requireRule } from '../policy/model.js';

const decode = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const keyOf = (decoded: DecodedTemplateBindingPayload) =>
  `${decoded.binding.resource.type}:${decoded.binding.resource.id}`;

/** Called by the one formal writer on its own transaction connection, or by the existing alert clock. */
export async function evaluateTemplateSamples(
  c: PoolConnection,
  binding: DecodedTemplateBindingPayload,
  observations: NormalizedObservation[],
  now: number,
  clockOnly = false,
): Promise<void> {
  if (!binding.pending.plan.triggers.some((t) => t.refs.length)) return;
  const key = keyOf(binding);
  const [rows] = await c.execute<RowDataPacket[]>(
    'SELECT payload FROM metric_trigger_snapshots WHERE resource_key=? AND config_revision=?',
    [key, binding.binding.revision],
  );
  requireRule(rows.length === 1, 'TRIGGER_SNAPSHOT_MISSING');
  const snapshot = verifyTriggerSnapshot(decode(rows[0].payload));
  const applied = {
    resource: binding.binding.resource,
    applied_revision: binding.application.applied_revision,
    application_status: binding.application.status,
    plan_identity: binding.application.resolution_identity,
  };
  requireRule(checkTriggerSnapshotFence(snapshot, applied).ok, 'TRIGGER_NOT_APPLIED');
  const at = new Date(now).toISOString();
  for (const rule of snapshot.rules) {
    if (!['collect', 'derive'].includes(rule.decision)) continue;
    const matching = observations.filter(
      (o) => o.metric.id === rule.metric.id && o.metric.semantic_version === rule.metric.semantic_version,
    );
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
    requireRule(dimensions.size <= TRIGGER_LIMITS.max_series, 'TRIGGER_SERIES_BUDGET');
    for (const dims of dimensions.values()) {
      const identity = {
        resource: snapshot.resource,
        rule_id: rule.rule_id,
        version: rule.version,
        body_hash: rule.body_hash,
        scope: rule.scope,
        context_hash: hashOf({ snapshot: snapshot.snapshot_hash, item: rule.item, dimensions: dims }),
      };
      const hash = triggerEpisodeIdentityHash(identity);
      await c.execute(
        `INSERT INTO metric_trigger_heads(identity_hash,resource_key,config_revision,rule_id,dimensions) VALUES(?,?,?,?,?)
        ON DUPLICATE KEY UPDATE identity_hash=identity_hash`,
        [hash, key, snapshot.config_revision, rule.rule_id, JSON.stringify(dims)],
      );
      const [locked] = await c.execute<RowDataPacket[]>(
        'SELECT payload,sample_watermark FROM metric_trigger_heads WHERE identity_hash=? FOR UPDATE',
        [hash],
      );
      const previous = locked[0].payload ? decode<TriggerEpisodeRecord>(locked[0].payload) : null;
      let watermark = locked[0].sample_watermark as string | null;
      let accepted = 0;
      for (const o of matching
        .filter((o) => stable(o.dimensions) === stable(dims))
        .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id.localeCompare(b.id))) {
        if (watermark && Date.parse(o.observed_at) <= Date.parse(watermark)) continue;
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
          [hash, o.id, new Date(o.observed_at), JSON.stringify({ sample, attempt_id: o.source.attempt_id })],
        );
        watermark = o.observed_at;
        accepted++;
      }
      // Repeated messages cannot open another occurrence after recovery.
      if (!clockOnly && matching.length && !accepted) continue;
      const [inputs] = await c.execute<RowDataPacket[]>(
        `SELECT sample_id,observed_at,payload FROM metric_trigger_inputs
        WHERE identity_hash=? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at,sample_id LIMIT 4097`,
        [hash, new Date(now - TRIGGER_LIMITS.max_window_ms), new Date(now)],
      );
      requireRule(inputs.length <= 4096, 'TRIGGER_INPUT_BUDGET');
      const samples = inputs
        .map((row) => decode<{ sample: TriggerSample | null }>(row.payload).sample)
        .filter((s): s is TriggerSample => s !== null);
      const selectors = [rule.problem, rule.recovery];
      let windowMs = 0;
      while (selectors.length) {
        const n = selectors.pop()!;
        if (n.node === 'compare') {
          if (n.select.aggregation !== 'last') windowMs = Math.max(windowMs, n.select.window_ms);
        } else selectors.push(...n.children);
      }
      const selected = windowMs
        ? samples
            .map((sample) => {
              const inputIndex = inputs.findIndex(row => decode<{sample:TriggerSample|null}>(row.payload).sample?.observed_at === sample.observed_at);
              const prior = inputIndex > 0 ? decode<{sample:TriggerSample|null}>(inputs[inputIndex-1].payload).sample : null,
                gap = prior ? Date.parse(sample.observed_at) - Date.parse(prior.observed_at) : Infinity;
              return {
                ...sample,
                window:
                  gap > 0 && gap <= binding.pending.plan.settings.interval_ms * 1.25
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
      const evaluation = evaluateTriggerRule(
        snapshot,
        { rule_id: rule.rule_id, scope: rule.scope },
        {
          applied,
          input: {
            now: at,
            last_seen_at: watermark,
            previous: previous?.state === 'open' ? 'problem' : null,
            samples: newestUsable ? selected : [],
          },
        },
      );
      const verdict = evaluation.nodata
        ? { ...evaluation, business: 'problem' as const, problem_open: true }
        : evaluation;
      const next = nextTriggerEpisode({ identity, previous, evaluation: verdict });
      const evidenceRows = inputs.filter((row) =>
        selected.some(
          (s) => s.observed_at === decode<{ sample: TriggerSample | null }>(row.payload).sample?.observed_at,
        ),
      );
      if (next)
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
      await c.execute('UPDATE metric_trigger_heads SET payload=?,sample_watermark=? WHERE identity_hash=?', [
        next ? JSON.stringify(next) : null,
        watermark,
        hash,
      ]);
      await c.execute('DELETE FROM metric_trigger_inputs WHERE identity_hash=? AND observed_at < ?', [
        hash,
        new Date(now - TRIGGER_LIMITS.max_window_ms),
      ]);
    }
  }
}

/** No new scheduler or worker: the existing alert-engine minute clock calls this. */
export async function evaluateTemplateClock(pool: Pool, now = Date.now()) {
  const [bindings] = await pool.execute<RowDataPacket[]>(
    "SELECT resource_key FROM metric_policy_bindings WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.envelope'))='templates-applied-v1'",
  );
  for (const row of bindings) {
    const c = await pool.getConnection();
    let reusable = false;
    try {
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
    } catch (error) {
      try {
        await c.rollback();
        reusable = true;
      } catch {
        /* discard */
      }
      throw error;
    } finally {
      if (reusable) c.release();
      else c.destroy();
    }
  }
}
