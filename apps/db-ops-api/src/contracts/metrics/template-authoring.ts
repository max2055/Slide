import { z } from 'zod';
import { MetricRefSchema, ResourceTypeSchema, VersionSchema } from './definitions.js';
import { HashIdSchema, ItemIdSchema, RevisionSchema, TemplateDetailResponseSchema,
  TemplateDraftSchema, TemplateDraftAggregateSchema, TemplateItemVersionSchema,
  TemplateRecordSchema, TemplateVersionSchema } from './templates.js';

const operation = { operation_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) };
const name = z.string().max(128);
export const TemplateAuthoringRequests = {
  copy: z.strictObject({ ...operation, name }),
  name: z.strictObject({ ...operation, name, expected_revision: RevisionSchema }),
  item: z.strictObject({ ...operation, item_id: ItemIdSchema.optional(), display_name: name.optional(),
    package: z.strictObject({ id: z.string().min(1).max(256), version: VersionSchema, digest: HashIdSchema }), metric: MetricRefSchema }),
  draft: z.strictObject({ ...operation, expected_draft_revision: RevisionSchema, aggregate: TemplateDraftAggregateSchema }),
  publish: z.strictObject({ ...operation, expected_draft_revision: RevisionSchema, expected_revision: RevisionSchema }),
};
// Capability metadata is resolved exclusively from the installed registry.
export const TemplateCapabilitySchema = z.object({
  metric: MetricRefSchema, display_name_default: z.string(), unit: z.string(), value_type: z.string(),
  resource_type: ResourceTypeSchema, default_interval_ms: z.number(), package_release: z.string(),
  package: z.object({ id: z.string(), version: VersionSchema, digest: HashIdSchema }),
  implementation_id: z.string(), raw_field: z.string(), input_unit: z.string(), output_unit: z.string(),
  transform_version: z.string(), steps: z.array(z.string()), method: z.string(),
  dimensions: z.array(z.object({ name: z.string(), meaning: z.string(), required: z.boolean() })),
  permissions: z.array(z.string()), discovery: z.string(),
});
export const TemplateAuthoringSchemas = {
  TemplateLibrary: z.object({ can_manage: z.boolean(), templates: z.array(z.object({
    template: TemplateRecordSchema, builtin: z.boolean(), resource_types: z.array(ResourceTypeSchema),
    item_count: z.number(),
  })) }),
  TemplateCapabilities: z.object({ candidates: z.array(TemplateCapabilitySchema),
    unavailable: z.array(z.object({ id: z.string(), semantic_version: VersionSchema, code: z.string(), reason: z.string() })) }),
  TemplateEditor: TemplateDetailResponseSchema.extend({ versions: z.array(TemplateVersionSchema), draft: TemplateDraftSchema, builtin: z.boolean(), can_manage: z.boolean() }),
  TemplateAuthoringResult: z.object({ template: TemplateRecordSchema.optional(), draft: TemplateDraftSchema.optional(),
    item: TemplateItemVersionSchema.optional(), auto: TemplateCapabilitySchema.optional(),
    published: TemplateVersionSchema.optional() }),
  TemplateCopyRequest: TemplateAuthoringRequests.copy,
  TemplateNameRequest: TemplateAuthoringRequests.name,
  TemplateItemRequest: TemplateAuthoringRequests.item,
  TemplateDraftWriteRequest: TemplateAuthoringRequests.draft,
  TemplatePublishRequest: TemplateAuthoringRequests.publish,
};
const response = (name: string) => ({ description: 'Live authorized template facts', content: { 'application/json': {
  schema: { $ref: `#/components/schemas/${name}` } } } });
const parameter = { name: 'templateId', in: 'path', required: true, schema: { type: 'string' } };
const errors = { '400': { description: 'Invalid input' }, '401': { description: 'Session revoked' },
  '403': { description: 'Permission revoked or built-in immutable' }, '409': { description: 'Revision or retry conflict' },
  '422': { description: 'Template cannot be published' }, '503': { description: 'Storage unavailable; retry same operation key' } };
export const templateAuthoringPaths = {
  '/api/metrics/templates/library': { get: { operationId: 'templateLibrary', security: [{ bearerAuth: [] }],
    responses: { '200': response('TemplateLibrary'), ...errors } } },
  '/api/metrics/templates/capabilities': { get: { operationId: 'templateCapabilities', security: [{ bearerAuth: [] }],
    responses: { '200': response('TemplateCapabilities'), ...errors } } },
  '/api/metrics/templates/{templateId}/editor': { get: { operationId: 'templateEditor', security: [{ bearerAuth: [] }],
    parameters: [parameter], responses: { '200': response('TemplateEditor'), ...errors } } },
  ...Object.fromEntries(Object.entries({ copy: 'TemplateCopyRequest', name: 'TemplateNameRequest', item: 'TemplateItemRequest',
    draft: 'TemplateDraftWriteRequest', publish: 'TemplatePublishRequest' }).map(([action, request]) => [
    `/api/metrics/templates/{templateId}/${action}`, { post: { operationId: `templateAuthoring${action}`, security: [{ bearerAuth: [] }],
      parameters: [parameter], requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${request}` } } } },
      responses: { '200': response('TemplateAuthoringResult'), ...errors } } },
  ])),
};
