import { z } from 'zod';
import { CONTRACT_VERSION, DimensionsSchema, IdSchema, MetricRefSchema, TimestampSchema, UnitSchema } from './definitions.js';
import { AccuracySchema, MetricValueSchema, ObservationSourceRecord, ObservationVersionsRecord, QualitySchema } from './observations.js';
import { metricBulkSchemas, metricBulkPaths } from './bulk.js';
import { MetricConfigurationStatusSchema } from './configuration-status.js';
import { PackageReleaseSchema } from '../../metrics/packages/model.js';
import { BindingChangeSchema, OverridesSchema, RefSchema } from '../../metrics/policy/model.js';

const metric = z.strictObject({ id: z.string(), semantic_version: z.string() });
export const MetricRecommendationsSchema = z.strictObject({
  resource: RefSchema, evaluated_at: z.iso.datetime(), packages: z.array(z.strictObject({
    release: PackageReleaseSchema, compatibility: z.enum(['compatible', 'incompatible', 'unknown']), recommended: z.boolean(),
    checks: z.array(z.strictObject({ attribute: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      supported_values: z.array(z.string()), status: z.enum(['supported', 'unsupported', 'unknown']) })),
    coverage: z.array(metric), missing_core_metrics: z.array(z.string()),
  })),
});
export const MetricPolicyGroupsSchema = z.strictObject({ groups: z.array(z.strictObject({
  id: z.string(), revision: z.number().int().positive(), policy_revision: z.number().int().positive().optional(),
  overrides: OverridesSchema, can_manage: z.boolean(),
})) });
/** Cursor is opaque: the page position plus a binding to resource, metric, version, dimensions and window. */
export const MetricObservationPageRequestSchema = z.strictObject({
  resource: RefSchema, metric: MetricRefSchema, dimensions: DimensionsSchema.default({}),
  from: z.iso.datetime(), to: z.iso.datetime(),
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().min(1).max(4096).optional(),
});
export const MetricObservationPageSchema = z.strictObject({
  contract_version: z.literal(CONTRACT_VERSION),
  resource: RefSchema, metric: MetricRefSchema, dimensions: DimensionsSchema,
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  order: z.literal('observed_at,observation_id'),
  /** Formal rows in the half-open window; never a truncated count. */
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
  observations: z.array(z.strictObject({
    id: IdSchema, observed_at: TimestampSchema, value: MetricValueSchema.nullable(), unit: UnitSchema,
    quality: QualitySchema, accuracy: AccuracySchema,
    sources: z.array(z.strictObject({ id: IdSchema, source: ObservationSourceRecord, versions: ObservationVersionsRecord })).min(1),
  })),
});
export const metricPublicSchemas = {
  ...metricBulkSchemas,
  MetricConfigurationStatus: MetricConfigurationStatusSchema,
  MetricConfigurationMigration: z.strictObject({resource:RefSchema,items:MetricConfigurationStatusSchema.shape.legacy_configuration.unwrap()}),
  MetricBindingChange: BindingChangeSchema,
  MetricRecommendations: MetricRecommendationsSchema,
  MetricPolicyGroups: MetricPolicyGroupsSchema,
  MetricObservationPageRequest: MetricObservationPageRequestSchema,
  MetricObservationPage: MetricObservationPageSchema,
};
export const metricJsonSchemas = Object.fromEntries(Object.entries(metricPublicSchemas).map(([name, schema]) =>
  [name, { ...z.toJSONSchema(schema, { unrepresentable: 'throw' }), $id: name }]));

const parameters = [{ name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['instance', 'server', 'network_device'] } },
  { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }];
const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({ description: 'Authorized live configuration facts', content: { 'application/json': { schema: schema(name) } } });
const errors = { '400': { description: 'Invalid input' }, '401': { description: 'Authentication required' },
  '403': { description: 'Live resource permission denied' }, '404': { description: 'Resource not found' }, '503': { description: 'Configuration facts unavailable' } };
export const metricPublicPaths = {
  ...metricBulkPaths,
  '/api/metrics/config/resources/{type}/{id}/migration': { get: { operationId: 'getMetricConfigurationMigration', security: [{ bearerAuth: [] }], parameters,
    description: 'Requires live resource management permission. Returns pending custom-SQL/retained-template migration codes and actionable steps, without SQL or secrets. Reviewed means awaiting activation, not formal visibility.',
    responses: { '200': response('MetricConfigurationMigration'), ...errors } } },
  '/api/metrics/config/resources/{type}/{id}/status': { get: { operationId: 'getMetricConfigurationStatus', security: [{ bearerAuth: [] }], parameters,
    description: 'Binding, effective switch, execution, formal visibility and per-metric coverage are independent. Read failures never become unbound.',
    responses: { '200': response('MetricConfigurationStatus'), ...errors } } },
  '/api/metrics/config/resources/{type}/{id}/recommendations': { get: { operationId: 'getMetricRecommendations', security: [{ bearerAuth: [] }], parameters,
    description: 'Same resource type only; actual engine/version/protocol applicability. Unknown is never a compatible recommendation.',
    responses: { '200': response('MetricRecommendations'), ...errors } } },
  '/api/metrics/config/resources/{type}/{id}/activate': { post: { operationId: 'activateMetricConfiguration', security: [{ bearerAuth: [] }], parameters,
    description: 'Bounded trial followed by live permission, candidate and revision CAS. Success publishes configuration; formal source acceptance continues asynchronously and is reported in status. 409 must not be retried blindly.',
    requestBody: { required: true, content: { 'application/json': { schema: schema('MetricBindingChange') } } },
    responses: { '200': { description: 'Published policy preview and independently evaluated status', content: { 'application/json': { schema: { type: 'object', required: ['published', 'status'],
      properties: { published: { const: true }, status: schema('MetricConfigurationStatus') } } } } }, ...errors,
      '409': { description: 'Revision conflict or trial busy; no implicit retry' }, '422': { description: 'Incompatible package or trial failed; not published' } } } },
  '/api/metrics/observations': { post: { operationId: 'listMetricObservations', security: [{ bearerAuth: [] }],
    description: 'Read-only formal raw observations, page by page. Current authorization is re-evaluated from each request, so a cursor cannot move to another resource, metric, version, dimensions or window. Same formal fence as the aggregate query: shadow, rolled-back and unaccepted revisions never appear. Half-open [from, to), ascending (observed_at, observation_id) keyset pages without duplicates or gaps at a same-timestamp boundary; no zero fill and no aggregate predecessor/successor. total and has_more come from the same snapshot. A window above the 50,000-row bound returns 400 instead of a truncated total.',
    requestBody: { required: true, content: { 'application/json': { schema: schema('MetricObservationPageRequest') } } },
    responses: { '200': { description: 'Authorized raw observation page', content: { 'application/json': { schema: schema('MetricObservationPage') } } }, ...errors } } },
  '/api/metrics/policy/groups': { get: { operationId: 'listMetricPolicyGroups', security: [{ bearerAuth: [] }],
    parameters: [{ name: 'query', in: 'query', schema: { type: 'string', maxLength: 128 } }],
    description: 'At most 100 visible groups; every member must be readable. Empty groups require admin. Management permission is evaluated separately.',
    responses: { '200': response('MetricPolicyGroups'), ...errors } } },
};
