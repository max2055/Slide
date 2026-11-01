import { z } from 'zod';
import { RefSchema } from '../../metrics/policy/model.js';
export const HistoricalSettingsSchema = z.strictObject({ enabled: z.boolean(),
  interval_ms: z.number().int().positive(), timeout_ms: z.number().int().positive(),
  stale_after_ms: z.number().int().positive(), max_counter_gap_ms: z.number().int().positive(),
  max_rows: z.number().int().positive(), max_concurrency: z.number().int().positive(), max_series_per_resource: z.number().int().positive() });
export const ConfigurationAtSchema = z.union([
  z.strictObject({ resource: RefSchema, revision: z.number().int().positive(), state: z.literal('unknown'), reason: z.literal('snapshot_not_recorded') }),
  z.strictObject({ resource: RefSchema, revision: z.number().int().positive(), state: z.enum(['published', 'effective']),
    settings: HistoricalSettingsSchema, snapshot_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    published_at: z.iso.datetime(), resolution_identity: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    evidence: z.array(z.strictObject({ basis: z.enum(['application_report', 'scheduler_activation', 'formal_observation_commit']),
      at: z.iso.datetime(), sample_ids: z.array(z.string()) })) }),
]);
export type ConfigurationAt = z.infer<typeof ConfigurationAtSchema>;
