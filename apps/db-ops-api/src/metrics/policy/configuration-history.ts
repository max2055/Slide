import { HistoricalSettingsSchema, ConfigurationAtSchema, type ConfigurationAt } from '../../contracts/metrics/configuration-history.js';
/** Historical configuration uses the existing append-only policy audit, never current defaults. */
import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { decodeBindingPayload, type DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import { stable } from '../packages/model.js';
import { PolicyError, refKey, type Ref } from './model.js';

const Basis = z.enum(['publication', 'application_report', 'scheduler_activation', 'formal_observation_commit']);
const RecordSchema = z.strictObject({ format: z.literal('configuration-history-v1'), basis: Basis,
  at: z.iso.datetime(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), payload: z.unknown(),
  sample_ids: z.array(z.string().min(1)).max(100000) });
const digestOf = (payload: unknown) => `sha256:${createHash('sha256').update(stable(payload)).digest('hex')}`;

function samplingIdentity(payload: unknown): string {
  const decoded = decodeBindingPayload(payload);
  return stable({ binding: decoded.binding,
    settings: decoded.kind === 'template_pending' ? decoded.pending.plan.settings : (decoded.payload.resolved as { settings: unknown }).settings,
    identity: decoded.kind === 'template_pending' ? decoded.pending.resolution_identity : null });
}

export function configurationHistoryRecord(payload: unknown, basis: z.infer<typeof Basis>, at: string, sampleIds: string[] = []) {
  const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const decoded = decodeBindingPayload(value);
  return { action: 'configuration.snapshot', target: refKey(decoded.binding.resource), revision: decoded.binding.revision,
    configuration_history: RecordSchema.parse({ format: 'configuration-history-v1', basis, at,
      digest: digestOf(value), payload: value, sample_ids: sampleIds }) };
}

export function templateHistoryPayload(decoded: DecodedTemplateBindingPayload): unknown {
  // Preserve the original envelope, including its applied revision and formal proof.
  const current = decodeBindingPayload(decoded.payload);
  if (current.kind !== 'template_pending') throw new PolicyError('CONFIGURATION_HISTORY_INVALID', 409);
  return structuredClone(current.payload);
}

export async function appendConfigurationHistory(c: Pick<PoolConnection, 'execute'>, payload: unknown,
  basis: z.infer<typeof Basis>, at: string, sampleIds: string[] = []): Promise<void> {
  const record = configurationHistoryRecord(payload, basis, at, sampleIds);
  // Preserve the first evidence per revision and basis, not one full snapshot per tick.
  // Every caller holds the existing policy lock through this transaction.
  if (basis !== 'publication') {
    const [existing] = await c.execute<RowDataPacket[]>(`SELECT payload FROM metric_policy_audit WHERE target = ?
      AND JSON_EXTRACT(payload, '$.revision') = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.configuration_history.basis')) = ? LIMIT 1`,
    [record.target, record.revision, basis]);
    if (existing.length) {
      const outer = typeof existing[0].payload === 'string' ? JSON.parse(existing[0].payload) : existing[0].payload;
      const previous = RecordSchema.parse(outer.configuration_history);
      if (previous.digest !== digestOf(previous.payload)
        || samplingIdentity(previous.payload) !== samplingIdentity(record.configuration_history.payload))
        throw new PolicyError('CONFIGURATION_HISTORY_INVALID', 409);
      return;
    }
  }
  await c.execute('INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)', [record.target, JSON.stringify(record)]);
}

/** Caller holds the policy + live actor locks through return/commit. No fallback to current binding. */
export async function readConfigurationHistory(c: Pick<PoolConnection, 'execute'>, ref: Ref, revision: number): Promise<ConfigurationAt> {
  const [rows] = await c.execute<RowDataPacket[]>(`SELECT payload FROM metric_policy_audit
    WHERE target = ? AND JSON_EXTRACT(payload, '$.revision') = ?
      AND JSON_EXTRACT(payload, '$.configuration_history') IS NOT NULL ORDER BY id`, [refKey(ref), revision]);
  if (!rows.length) return { resource: ref, revision, state: 'unknown' as const, reason: 'snapshot_not_recorded' as const };
  try {
    const records = rows.map(row => {
      const outer = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const record = RecordSchema.parse(outer.configuration_history);
      const decoded = decodeBindingPayload(record.payload);
      if (outer.target !== refKey(ref) || outer.revision !== revision || refKey(decoded.binding.resource) !== refKey(ref)
        || decoded.binding.revision !== revision || record.digest !== digestOf(record.payload)) throw new Error();
      const publishedAt = decoded.kind === 'template_pending' ? decoded.published_at : String(decoded.payload.published_at);
      if (Date.parse(record.at) < Date.parse(publishedAt)) throw new Error();
      if (record.basis === 'publication' && record.at !== publishedAt) throw new Error();
      if (record.basis === 'formal_observation_commit' && (decoded.kind !== 'template_pending' || !record.sample_ids.length)) throw new Error();
      if (['application_report', 'scheduler_activation'].includes(record.basis) && decoded.kind !== 'legacy_published') throw new Error();
      if (record.basis === 'application_report' && (decoded.application.status !== 'applied'
        || decoded.application.applied_revision !== revision)) throw new Error();
      const settings = decoded.kind === 'template_pending' ? decoded.pending.plan.settings : (decoded.payload.resolved as { settings: unknown }).settings;
      return { record, decoded, settings: HistoricalSettingsSchema.parse(settings) };
    });
    // A revision cannot silently acquire a different sampling policy at activation.
    if (records.some(entry => stable(entry.settings) !== stable(records[0].settings)
      || stable(entry.decoded.binding) !== stable(records[0].decoded.binding))) throw new Error();
    const templateIdentities = new Set(records.map(entry => entry.decoded.kind === 'template_pending' ? entry.decoded.pending.resolution_identity : 'package'));
    if (templateIdentities.size !== 1) throw new Error();
    const effective = records.filter(entry => entry.record.basis !== 'publication');
    const chosen = effective[0] ?? records[0];
    return ConfigurationAtSchema.parse({ resource: ref, revision, state: effective.length ? 'effective' as const : 'published' as const,
      settings: chosen.settings, snapshot_digest: chosen.record.digest,
      published_at: chosen.decoded.kind === 'template_pending' ? chosen.decoded.published_at : chosen.decoded.payload.published_at,
      evidence: effective.map(({ record }) => ({ basis: record.basis, at: record.at, sample_ids: record.sample_ids })),
      resolution_identity: chosen.decoded.kind === 'template_pending' ? chosen.decoded.pending.resolution_identity : null });
  } catch { throw new PolicyError('CONFIGURATION_HISTORY_INVALID', 409); }
}
