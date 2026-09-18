import { z } from 'zod';
import { ResourceTypeSchema, type CollectionPlan } from '../../contracts/metrics-v2/index.js';
import { SelectionSchema } from '../packages/model.js';

export const PolicyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const RefSchema = z.strictObject({ type: ResourceTypeSchema, id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const numberOverride = (min = 1, max = 86400000) => z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('inherit') }),
  z.strictObject({ mode: z.literal('set'), value: z.number().int().min(min).max(max) }),
]);
export const ToggleSchema = z.enum(['inherit', 'enable', 'disable']);
export const OverridesSchema = z.strictObject({
  enabled: ToggleSchema.optional(), interval_ms: numberOverride(1000).optional(), timeout_ms: numberOverride(250, 30000).optional(),
  stale_after_ms: numberOverride().optional(), max_counter_gap_ms: numberOverride().optional(),
  max_rows: numberOverride(1, 100).optional(), max_concurrency: numberOverride(1, 16).optional(), max_series_per_resource: numberOverride(1, 10000).optional(),
  metrics: z.record(z.string().regex(/^[a-z][a-z0-9_.]*@[0-9]+\.[0-9]+\.[0-9]+$/), ToggleSchema).refine(v => Object.keys(v).length <= 256).optional(),
});
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const BindingChangeSchema = z.strictObject({
  expected_revision: revision,
  package: SelectionSchema.shape.package.optional(),
  group_id: PolicyIdSchema.nullable().optional(),
  overrides: OverridesSchema.optional(),
});
export const GroupChangeSchema = z.strictObject({ expected_revision: revision, overrides: OverridesSchema }).superRefine((value, ctx) => {
  const o = value.overrides;
  if (o.interval_ms?.mode !== 'set') return;
  for (const key of ['timeout_ms', 'stale_after_ms', 'max_counter_gap_ms'] as const) {
    const item = o[key];
    if (item?.mode === 'set' && (key === 'timeout_ms' ? item.value > o.interval_ms.value : item.value < o.interval_ms.value)) {
      ctx.addIssue({ code: 'custom', path: ['overrides', key], message: 'POLICY_TIMING' });
    }
  }
});
export type Ref = z.infer<typeof RefSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type Group = { id: string; revision: number; policy_revision?: number; overrides: Overrides };
export type Binding = { resource: Ref; package: z.infer<typeof SelectionSchema>['package']; group_id: string | null; overrides: Overrides; revision: number };
export type Origin = { layer: 'package' | 'platform' | 'group' | 'resource'; id: string; revision?: number };
export type Settings = { enabled: boolean; interval_ms: number; timeout_ms: number; stale_after_ms: number; max_counter_gap_ms: number; max_rows: number; max_concurrency: number; max_series_per_resource: number };
export type Resolved = {
  plan: CollectionPlan;
  metric_templates: Array<{ metric: CollectionPlan['entries'][number]['binding']['metric']; source: CollectionPlan['entries'][number]['binding']['source'];
    enabled: boolean; required_dimensions: string[]; capability: CollectionPlan['entries'][number]['capability']; decision: CollectionPlan['entries'][number]['decision'] }>;
  settings: Settings;
  platform_limits: Record<string, number>;
  sources: Record<keyof Settings, Origin>;
  metric_sources: Record<string, Origin>;
  dependencies: Array<{ metric: string; requires: string[] }>;
  collector_timeouts: Array<{ collector_id: string; timeout_ms: number; source: Origin }>;
  impact: { requests_per_hour_estimate: number; request_unit: 'logical_reads'; estimated_series_upper_bound: number; active_collectors: string[]; disabled_metrics: string[]; unavailable_metrics: string[]; estimate: true };
};
export type Applied = { applied_revision: number | null; reported_at: string | null; status: 'pending' | 'applied' | 'failed'; error_code: 'apply_failed' | null };
export type Published = { binding: Binding; resolved: Resolved; published_at: string; application: Applied };
export type Audit = { actor_id: number; request_id: string; action: 'binding.publish' | 'group.publish'; target: string; revision: number; at: string;
  configuration: { package?: Binding['package']; group_id?: string | null; overrides: Overrides; group?: Group | null } };
export const refKey = (ref: Ref) => `${ref.type}:${ref.id}`;
export const metricKey = (ref: { id: string; semantic_version: string }) => `${ref.id}@${ref.semantic_version}`;
export class PolicyError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
export function rule(value: unknown, code: string, status = 400): asserts value { if (!value) throw new PolicyError(code, status); }
