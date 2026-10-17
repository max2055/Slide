import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { BindingChangeSchema, OverridesSchema, RefSchema, refKey, type Binding, type Ref } from '../policy/model.js';
import { SelectionSchema } from '../packages/model.js';
import type { MetricConfigurationStatus } from '../../contracts/metrics/configuration-status.js';

export const BulkKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const BulkPreviewSchema = z.strictObject({
  key: BulkKeySchema,
  resources: z.array(RefSchema).min(1).max(100).refine(a => new Set(a.map(refKey)).size === a.length),
  overrides: OverridesSchema.optional(),
  /** Omitted groups preserve the existing package ID and use the server recommendation for unbound objects. */
  packages: z.array(z.strictObject({ resources: z.array(RefSchema).min(1).max(100), package: SelectionSchema.shape.package })).max(100).optional(),
});
export const BulkConfirmSchema = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const BulkRetrySchema = z.strictObject({ key: BulkKeySchema });
export type BulkInput = z.infer<typeof BulkPreviewSchema>;
export type BulkItemState = 'eligible' | 'unsupported' | 'skipped' | 'queued' | 'running' | 'succeeded' | 'pending_takeover' | 'failed' | 'cancelled';
export type ActorSeed = Pick<ActorContext, 'userId' | 'sessionVersion' | 'resourceBoundary' | 'principalKind'>;
export interface BulkItem {
  resource: Ref;
  state: BulkItemState;
  code: string | null;
  group: string;
  checks: Array<{attribute:string;value:string|number|boolean|null;status:string}>;
  choices: Array<{package: Binding['package'];recommended:boolean;compatibility:string;metrics:string[];missing:string[]}>;
  before: Binding | null;
  change: z.infer<typeof BindingChangeSchema> | null;
  settings: Record<string, number | boolean> | null;
  coverage: string[];
  missing: string[];
  cost: {before:number;after:number;unit:'logical_reads_per_hour';estimate:true} | null;
  retained: string[];
  changed: string[];
  revision: number | null;
  status: MetricConfigurationStatus | null;
  /** Internal recovery/candidate data; never emitted by the API projection. */
  candidate: string | null;
  request_id: string;
}
export interface BulkJob {
  id: string; key: string; digest: string; input_digest: string; actor: ActorSeed;
  state: 'draft' | 'queued' | 'running' | 'completed' | 'cancelled';
  created_at: string; updated_at: string; expires_at: string;
  input: BulkInput; items: BulkItem[];
  retry_of: string | null;
}
export interface BulkStore {
  create(job: BulkJob): Promise<BulkJob>;
  get(id: string): Promise<BulkJob | null>;
  save(job: BulkJob): Promise<void>;
  list(owner?: number): Promise<BulkJob[]>;
  cancel(id: string): Promise<void>;
  cancelled(id: string): Promise<boolean>;
  /** One batch worker across processes, with a lease tied to the DB connection. */
  exclusive<T>(fn: () => Promise<T>, key?: string): Promise<T | null>;
  fence?(): Promise<void>;
}
