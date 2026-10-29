import { z } from 'zod';
import { metricBulkSchemas, metricBulkPaths } from './bulk.js';
import { MetricConfigurationStatusSchema } from './configuration-status.js';
import { PackageReleaseSchema } from '../../metrics/packages/model.js';
import { BindingChangeSchema, OverridesSchema, RefSchema } from '../../metrics/policy/model.js';
import {
  TemplateBindingApplyBodySchema, TemplateBindingApplyResponseSchema, TemplateBindingBodySchema,
  TemplateBindingPreviewSchema, TemplateBindingStatusSchema, TemplateCatalogSchema,
  TemplateRepinBodySchema, TemplateRepinResponseSchema, TemplateTrialBodySchema, TemplateTrialResponseSchema,
  TemplateVersionDetailSchema,
} from './template-bindings.js';

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
export const MetricOperationStateSchema = z.strictObject({
  state: z.enum(['committed', 'pending', 'absent']),
  operation: z.strictObject({ resource: RefSchema, target_revision: z.number().int().positive(),
    configuration_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(), committed_at: z.iso.datetime().nullable() }).nullable(),
});
export const metricPublicSchemas = {
  ...metricBulkSchemas,
  MetricConfigurationStatus: MetricConfigurationStatusSchema,
  MetricConfigurationMigration: z.strictObject({resource:RefSchema,items:MetricConfigurationStatusSchema.shape.legacy_configuration.unwrap()}),
  MetricBindingChange: BindingChangeSchema,
  MetricRecommendations: MetricRecommendationsSchema,
  MetricPolicyGroups: MetricPolicyGroupsSchema,
  MetricOperationState: MetricOperationStateSchema,
  TemplateCatalog: TemplateCatalogSchema,
  TemplateVersionDetail: TemplateVersionDetailSchema,
  TemplateRepinResponse: TemplateRepinResponseSchema,
  TemplateRepinBody: TemplateRepinBodySchema,
  TemplateBindingStatus: TemplateBindingStatusSchema,
  TemplateBindingPreview: TemplateBindingPreviewSchema,
  TemplateTrialResponse: TemplateTrialResponseSchema,
  TemplateBindingApplyResponse: TemplateBindingApplyResponseSchema,
  TemplateBindingRequest: TemplateBindingBodySchema,
  TemplateTrialRequest: TemplateTrialBodySchema,
  TemplateBindingApplyRequest: TemplateBindingApplyBodySchema,
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
    description: 'Bounded trial followed by live permission, candidate and revision CAS. Success publishes configuration; formal source acceptance continues asynchronously and is reported in status. 409 must not be retried blindly. An optional operation_key binds one client intent to this resource, target revision and canonical request: a committed replay returns the recorded publication without a second trial, revision, publication or audit, a duplicate while the same intent is pending is rejected without a second trial, and reuse for another intent is rejected.',
    requestBody: { required: true, content: { 'application/json': { schema: schema('MetricBindingChange') } } },
    responses: { '200': { description: 'Published policy preview and independently evaluated status', content: { 'application/json': { schema: { type: 'object', required: ['published', 'status'],
      properties: { published: { const: true }, status: schema('MetricConfigurationStatus') } } } } }, ...errors,
      '409': { description: 'Revision conflict, operation-key collision or trial busy; no implicit retry' }, '422': { description: 'Incompatible package or trial failed; not published' } } } },
  '/api/metrics/config/resources/{type}/{id}/operations/{key}': { get: { operationId: 'getMetricConfigurationOperation', security: [{ bearerAuth: [] }],
    parameters: [...parameters, { name: 'key', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } }],
    description: 'Authoritative read of one client operation key under the same serialization as publication: committed returns the recorded publication, pending means the intent was reserved and its outcome is in flight or unknown after a restart (not safely retryable), and absent means no intent with that key was ever recorded, so a same-key retry cannot duplicate a publication. A key recorded for another resource is reported absent, never disclosed.',
    responses: { '200': response('MetricOperationState'), ...errors } } },
  '/api/metrics/policy/groups': { get: { operationId: 'listMetricPolicyGroups', security: [{ bearerAuth: [] }],
    parameters: [{ name: 'query', in: 'query', schema: { type: 'string', maxLength: 128 } }],
    description: 'At most 100 visible groups; every member must be readable. Empty groups require admin. Management permission is evaluated separately.',
    responses: { '200': response('MetricPolicyGroups'), ...errors } } },
  '/api/metrics/templates': { get: { operationId: 'listMetricTemplates', security: [{ bearerAuth: [] }],
    description: 'Persisted native template identities and their immutable versions. Requires metric:view; read-only, private/no-store.',
    responses: { '200': response('TemplateCatalog'), ...errors } } },
  '/api/metrics/templates/{templateId}/versions/{version}': { get: { operationId: 'getMetricTemplateVersion',
    security: [{ bearerAuth: [] }],
    parameters: [{ name: 'templateId', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } },
      { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
    description: 'One immutable published version with its composition, items and provenance. Requires metric:view; a missing version is 404, never a synthesized one.',
    responses: { '200': response('TemplateVersionDetail'), ...errors } } },
  '/api/metrics/templates/{templateId}/repin': { post: { operationId: 'repinMetricTemplateVersion',
    security: [{ bearerAuth: [] }],
    parameters: [{ name: 'templateId', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } }],
    description: 'Publishes one new immutable template version whose items pin an installed release that applies to the named resource. Requires metric:manage and live management permission on that resource; the published audit records the real caller. Never edits a published version, never relaxes applicability and never widens permission.',
    requestBody: { required: true, content: { 'application/json': { schema: schema('TemplateRepinBody') } } },
    responses: { '200': response('TemplateRepinResponse'), ...errors,
      '422': { description: 'No compatible release, or the item semantics changed; nothing was published' } } } },
  '/api/metrics/template-bindings/{type}/{id}': { get: { operationId: 'getMetricTemplateBinding',
    security: [{ bearerAuth: [] }], parameters,
    description: 'Binding source, pending template plan, application status, effective revision and pins as independent facts. Requires read access to the resource; a failure never becomes "unbound".',
    responses: { '200': response('TemplateBindingStatus'), ...errors } } },
  '/api/metrics/template-bindings/{type}/{id}/preview': { post: { operationId: 'previewMetricTemplateBinding',
    security: [{ bearerAuth: [] }], parameters,
    description: 'Walks preflight → compile → resolve → plan for the exact pinned versions and reports every item decision with its release and applicability to the live target. Requires live management permission on this resource. Nothing is persisted.',
    requestBody: { required: true, content: { 'application/json': { schema: schema('TemplateBindingRequest') } } },
    responses: { '200': response('TemplateBindingPreview'), ...errors, '422': { description: 'Not executable for this target' } } } },
  '/api/metrics/template-bindings/{type}/{id}/trial': { post: { operationId: 'trialMetricTemplateBinding',
    security: [{ bearerAuth: [] }], parameters,
    description: 'Real read-only collection of the plan through the accepted collector access, written only as a v2 trial receipt: never a formal observation, history row or alert. Live permission is re-read after the resource lock and before any remote request. Busy is 409; a mandatory item that was not proven read/transform/unit is an explicit optional exclusion, never a pass.',
    requestBody: { required: true, content: { 'application/json': { schema: schema('TemplateTrialRequest') } } },
    responses: { '200': response('TemplateTrialResponse'), ...errors,
      '409': { description: 'Trial busy or receipt id collision' }, '422': { description: 'Not executable or trial failed' } } } },
  '/api/metrics/template-bindings/{type}/{id}/apply': { post: { operationId: 'applyMetricTemplateBinding',
    security: [{ bearerAuth: [] }], parameters,
    description: 'Stages one pending binding revision through the accepted host: live authorization (re-read after the policy lock), CAS on the trusted revision, operation key and audit in one transaction. An already committed caller key replays its receipt without a second revision; an unknown outcome must be looked up, never resent. A committed staging is reported as pending application until a fenced worker applies it.',
    requestBody: { required: true, content: { 'application/json': { schema: schema('TemplateBindingApplyRequest') } } },
    responses: { '200': response('TemplateBindingApplyResponse'), ...errors,
      '409': { description: 'Revision or operation-key conflict; no implicit retry' }, '422': { description: 'Receipt invalid, expired or consumed' } } } },
};
