import { ConfigurationAtSchema } from './configuration-history.js';
import { z } from 'zod';
import { RefSchema } from '../../metrics/policy/model.js';
import { TriggerResourceSnapshotSchema } from './triggers.js';

export const MetricConsumerQuerySchema = z.strictObject({
  resource: RefSchema,
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  metric_ids: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/)).min(1).max(32).optional(),
  view: z.enum(['core', 'canonical', 'extension', 'all']).default('core'),
  bucket_ms: z.number().int().positive().max(86400000).optional(),
  latest_capacity: z.boolean().default(false), history: z.boolean().default(false),
});
export const MetricHistoryContextSchema = z.strictObject({
  configurations: z.array(ConfigurationAtSchema).max(100).optional(),
  snapshots: z.array(TriggerResourceSnapshotSchema).max(100),
  missing_revisions: z.array(z.number().int().positive()).max(100),
  events: z.array(z.strictObject({ event_id: z.number().int().positive(), rule_id: z.string(), version: z.number().int().positive(),
    config_revision: z.number().int().positive(), from: z.iso.datetime(), to: z.iso.datetime().nullable(),
    unknown_segments: z.array(z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime().nullable(), reason: z.string() })),
  })).max(200),
  events_readable: z.boolean(),
  retention: z.strictObject({ rawMs: z.number().int().positive(), historyMs: z.number().int().positive(),
    attemptMs: z.number().int().positive(), cleanup_enabled: z.boolean() }),
  sampling: z.strictObject({ interval_ms: z.number().int().positive(), max_gap_ms: z.number().int().positive(),
    basis: z.literal('explicit_history_assumption') }),
});
