import { z } from 'zod';
import { RefSchema } from '../../metrics/policy/model.js';
import { DimensionsSchema, MetricRefSchema, MetricDefinitionSchema } from './index.js';
import { TriggerResourceSnapshotSchema, TriggerItemIdentitySchema } from './triggers.js';
import { ConfigurationAtSchema } from './configuration-history.js';
import { MetricHistoryContextSchema } from './history.js';

const time = z.iso.datetime({ offset: true });
export const StudyWindowSchema = z.strictObject({ resource: RefSchema, from: time, to: time });
export const StudyTrendSchema = StudyWindowSchema.extend({ metric: MetricRefSchema,
  dimensions: DimensionsSchema.default({}), tier: z.enum(['5m', '1h', '1d']).default('1h'),
  interval_ms: z.number().int().min(1000).max(86400000).default(60000) });
export const StudyReplaySchema = StudyWindowSchema.extend({ revision: z.number().int().positive(),
  snapshot_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), rule_id: z.string().min(1).max(128), scope: z.string().min(1).max(256) });
export const StudyRetentionSchema = z.strictObject({ numeric_days: z.number().int().min(1).max(3650).default(30),
  non_numeric_days: z.number().int().min(1).max(3650).default(7),
  series_per_resource: z.number().int().min(1).max(10000).default(1),
  interval_ms: z.number().int().min(1000).max(86400000).default(60000) });
export const StudyCapacitySchema = z.strictObject({ resource: RefSchema, assumptions: StudyRetentionSchema.default({numeric_days:30,non_numeric_days:7,series_per_resource:1,interval_ms:60000}) });
const window=z.strictObject({from:time,to:time});
const exact=z.strictObject({numerator:z.string().regex(/^-?\d+$/),denominator:z.string().regex(/^[1-9]\d*$/)});
const integer=z.number().int().nonnegative();
export const StudyTrendResultSchema=z.strictObject({resource:RefSchema,metric:MetricRefSchema,dimensions:DimensionsSchema,window,
  tier:z.enum(['5m','1h','1d']),evidence_hash:z.string(),note:z.string(),sampling:z.strictObject({interval_ms:integer,basis:z.literal('explicit_measurement_assumption')}),
  buckets:z.array(z.strictObject({from:time,to:time,count:integer,numeric_count:integer,invalid_count:integer,non_numeric_count:integer,estimated_count:integer,
    sum:exact,min:exact.nullable(),max:exact.nullable(),avg:exact.nullable(),first_at:time.nullable(),last_at:time.nullable(),max_gap_ms:integer,coverage:z.number().min(0).max(1),quality:z.enum(['good','partial','unknown']),raw_status:z.enum(['available','partial_expired','expired','boundary_unavailable']).default('available'),retained_count:integer.default(0),statistics_complete:z.boolean().default(true)})).max(10080)});
export const StudyCatalogResultSchema=z.strictObject({resource:RefSchema,window,
  metrics:z.array(z.strictObject({metric:MetricRefSchema,definition:MetricDefinitionSchema.nullable()})).max(100),snapshots:z.array(TriggerResourceSnapshotSchema).max(100),
  aggregation:z.strictObject({mode:z.literal('durable_exact_hierarchy'),tiers:z.array(z.enum(['5m','1h','1d'])),max_rows:integer,max_days:integer,retention_ms:integer}),raw_max_days:integer});
const evaluation=z.strictObject({rule:z.strictObject({rule_id:z.string(),version:integer}),scope:z.string(),item:TriggerItemIdentitySchema,metric:MetricRefSchema,
  business:z.enum(['problem','healthy','unknown']),quality:z.enum(['good','partial','unknown']),problem_open:z.boolean(),recovery:z.boolean(),nodata:z.boolean(),reason:z.string(),value:z.number().nullable(),
  dimensions:DimensionsSchema.nullable(),series_count:integer,evaluated_at:time});
export const StudyReplayResultSchema=z.strictObject({resource:RefSchema,window,isolated:z.literal(true),initial_state:z.literal('unknown'),snapshot_hash:z.string(),revision:integer,
  rule:z.strictObject({rule_id:z.string(),version:integer,scope:z.string(),body_hash:z.string()}),evidence_count:integer,evidence_hash:z.string(),configuration:ConfigurationAtSchema,evidence_configurations:z.array(ConfigurationAtSchema).max(100),
  runs:z.array(z.strictObject({dimensions:DimensionsSchema,timeline:z.array(evaluation.extend({event_type:z.enum(['sample','clock']),sample_id:z.string().nullable()})).max(16384),tail:evaluation})).max(100),
  formal_events_readable:z.boolean(),formal_events:MetricHistoryContextSchema.shape.events});
export const StudyDimensionsResultSchema=z.strictObject({dimensions:z.array(DimensionsSchema).max(100)});
export const StudyCapacityResultSchema=z.strictObject({resource:RefSchema,preview_only:z.literal(true),
  retained_trends:z.strictObject({buckets:integer,payload_bytes:integer,receipts:integer,retention_ms:integer,projected_buckets_650:integer,projected_receipts_650:integer,projected_statistics_bytes_650:integer.nullable(),basis:z.string()}),
  assumptions:StudyRetentionSchema.extend({resources:z.strictObject({server:integer,instance:integer,network_device:integer}),basis:z.literal('explicit_measurement_assumption')}),
  measured:z.array(z.strictObject({value_class:z.string(),rows:integer,payload_bytes:integer,mean_payload_bytes:z.number().nonnegative().nullable(),retention_days:integer,projected_rows_650:integer.nullable(),projected_payload_bytes_650:integer.nullable()})),
  cleanup_candidates:z.record(z.string(),z.strictObject({count:integer,oldestAt:time.nullable(),oldestAgeMs:integer.nullable()})),
  configured_retention:MetricHistoryContextSchema.shape.retention.omit({cleanup_enabled:true}),boundary:z.string(),
  baseline:z.strictObject({commit:z.string(),resources:integer,series_per_resource:integer,interval_ms:integer,throughput_jobs_s:z.array(z.number()),history_p95_ms:z.array(z.number()),production_slo:z.literal(false),
    p0_gate_source:z.string(),stop_thresholds:z.strictObject({sampling_delay_p95_intervals:z.number(),missing_rate:z.number(),duplicate_events:integer}),gate_measured_here:z.literal(false)})});
export const studySchemas = { MetricStudyWindow: StudyWindowSchema, MetricStudyTrend: StudyTrendSchema,
  MetricStudyReplay: StudyReplaySchema, MetricStudyCapacity: StudyCapacitySchema,
  MetricStudyTrendResult:StudyTrendResultSchema,MetricStudyCatalogResult:StudyCatalogResultSchema,MetricStudyReplayResult:StudyReplayResultSchema,MetricStudyDimensionsResult:StudyDimensionsResultSchema,MetricStudyCapacityResult:StudyCapacityResultSchema };
export const studyPaths = Object.fromEntries([
  ['catalog','MetricStudyWindow'], ['trend','MetricStudyTrend'], ['replay','MetricStudyReplay'], ['capacity','MetricStudyCapacity'],
  ['dimensions','MetricStudyTrend'],
].map(([operation, name]) => [`/api/metrics/study/${operation}`, { post: {
  operationId: `metricStudy${operation}`, security: [{bearerAuth:[]}],
  description: operation === 'replay' ? 'Isolated historical evaluation; no formal state/event/notification writes.' : 'Authorized resource-scoped historical study; bounded reads and live access recheck.',
  requestBody: { required: true, content: {'application/json': {schema: {$ref:`#/components/schemas/${name}`}}} },
  responses: {'200': {description:'Resource-scoped study result',content:{'application/json':{schema:{$ref:`#/components/schemas/MetricStudy${operation[0].toUpperCase()+operation.slice(1)}Result`}}}},'400':{description:'Invalid window or budget exceeded'},'401':{description:'Authentication required'},'403':{description:'Live permission denied'},'409':{description:'Original evidence expired; retained trends cannot be replayed'},'503':{description:'Study unavailable'}},
}}]));
