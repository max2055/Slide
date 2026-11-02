import { z } from 'zod';
import { TriggerRuleVersionSchema } from './triggers.js';
import { RefSchema, OperationKeySchema, refKey } from '../../metrics/policy/model.js';
import {
  TemplatePinSchema,
  TemplateDraftAggregateSchema,
  TemplateItemVersionSchema,
  TemplateParametersSchema,
  PackageCompositionEntrySchema,
  TemplateTriggerRefSchema,
} from './templates.js';
import {
  TemplateBindingBodySchema,
  TemplateBindingStatusSchema,
  TemplateBindingPreviewSchema,
} from './template-bindings.js';
export const RolloutInput = z
  .strictObject({
    operation_key: OperationKeySchema,
    pins: z.array(TemplatePinSchema).min(1).max(20),
    resources: z
      .array(
        z.strictObject({ resource: RefSchema, expected_revision: z.number().int().nonnegative() }),
      )
      .min(1)
      .max(650),
  })
  .superRefine((v, c) => {
    if (
      new Set(v.resources.map((r) => refKey(r.resource))).size !== v.resources.length ||
      new Set(v.pins.map((p) => p.template_id)).size !== v.pins.length
    )
      c.addIssue({ code: 'custom', message: 'ROLLOUT_DUPLICATE' });
  });
export const RolloutStep = z.strictObject({
  operation_key: OperationKeySchema,
  action: z.enum(['apply', 'retry', 'rollback']),
});
const origins = z.record(
  z.string(),
  z.object({ template_id: z.string(), version: z.number().int().positive().nullable() }),
);
const budgetParameters = z.object({
  budget: TemplateBindingPreviewSchema.shape.budget,
  parameters: TemplateBindingPreviewSchema.shape.parameters,
});
const item = z.looseObject({
  resource: RefSchema,
  before: TemplateBindingBodySchema,
  candidate: TemplateBindingBodySchema,
  attempt: z.number().int().nonnegative(),
  key: OperationKeySchema,
  state: z.enum(['ready', 'submitted', 'failed', 'unknown']),
  error: z.string().nullable(),
  target_revision: z.number().int().positive().nullable(),
});
export const TemplateGovernanceSchemas = {
  TemplateRolloutInput: RolloutInput,
  TemplateRolloutStep: RolloutStep,
  TemplateGovernanceInventory: z.array(
    RefSchema.extend({ name: z.string(), revision: z.number().int().nonnegative() }),
  ),
  TemplateRolloutCreated: z.object({ id: z.uuid() }),
  TemplateRolloutItem: item,
  TemplateRolloutBatch: z.looseObject({
    id: z.uuid(),
    pins: z.array(TemplatePinSchema),
    created_at: z.iso.datetime(),
    items: z.array(
      item.extend({
        status: TemplateBindingStatusSchema,
        receipt: z.enum([
          'ready',
          'submitted',
          'failed',
          'unknown',
          'applied',
          'superseded',
          'pending',
          'collection_failed',
        ]),
        collection_failure: z
          .object({ kind: z.string(), id: z.string(), code: z.string() })
          .nullable(),
      }),
    ),
  }),
  TemplateInheritance: z.object({
    aggregate: TemplateDraftAggregateSchema,
    origins: z.object({ items: origins, parameters: origins, triggers: origins }),
    items: z.array(TemplateItemVersionSchema),
  }),
  TemplateRolloutPreview: z.object({
    resources: z.array(
      z.object({
        resource: RefSchema,
        revision: z.number().int().nonnegative(),
        before: budgetParameters.nullable(),
        after: budgetParameters.extend({ executable: z.boolean() }).nullable(),
        error: z.string().nullable(),
        conflicts: z.array(z.unknown()).optional(),
      }),
    ),
  }),
  TemplateVersionDifference: z.object({
    from: z.object({ version: z.number(), hash: z.string() }),
    to: z.object({ version: z.number(), hash: z.string() }),
    changes: z.array(
      z.object({
        item_id: z.string(),
        kind: z.enum(['added', 'deleted', 'changed']),
        before: TemplateItemVersionSchema.nullable(),
        after: TemplateItemVersionSchema.nullable(),
      }),
    ),
    parameters: z.object({ before: TemplateParametersSchema, after: TemplateParametersSchema }),
    triggers: z.object({
      before: z.array(
        z.object({ ref: TemplateTriggerRefSchema, body: TriggerRuleVersionSchema.nullable() }),
      ),
      after: z.array(
        z.object({ ref: TemplateTriggerRefSchema, body: TriggerRuleVersionSchema.nullable() }),
      ),
    }),
    load: z.object({
      before: z.array(PackageCompositionEntrySchema),
      after: z.array(PackageCompositionEntrySchema),
    }),
    affected: z.array(z.object({ resource: RefSchema, revision: z.number() })),
  }),
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 422, 503].map((n) => [
    String(n),
    {
      description:
        'Typed refusal or unknown storage outcome. Retry the exact operation key; never assume applied.',
    },
  ]),
);
const parameter = (name: string, type = 'string') => ({
  name,
  in: 'path',
  required: true,
  schema: { type },
});
const endpoint = (
  method: string,
  operationId: string,
  response: string,
  parameters: any[] = [],
  request?: string,
) => ({
  [method]: {
    operationId,
    security: [{ bearerAuth: [] }],
    parameters,
    ...(request
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${request}` } },
            },
          },
        }
      : {}),
    responses: {
      '200': {
        description: 'Live authorized facts; submitted is not applied',
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${response}` } } },
      },
      ...errors,
    },
  },
});
const base = '/api/metrics/template-governance';
export const templateGovernancePaths = {
  [`${base}/resources`]: endpoint(
    'get',
    'templateGovernanceResources',
    'TemplateGovernanceInventory',
  ),
  [`${base}/preview`]: endpoint(
    'post',
    'templateRolloutPreview',
    'TemplateRolloutPreview',
    [],
    'TemplateRolloutInput',
  ),
  [`${base}/batches`]: endpoint(
    'post',
    'templateRolloutCreate',
    'TemplateRolloutCreated',
    [],
    'TemplateRolloutInput',
  ),
  [`${base}/batches/{id}`]: endpoint('get', 'templateRolloutRead', 'TemplateRolloutBatch', [
    parameter('id'),
  ]),
  [`${base}/batches/{id}/{type}/{resourceId}`]: endpoint(
    'post',
    'templateRolloutStep',
    'TemplateRolloutItem',
    [parameter('id'), parameter('type'), parameter('resourceId')],
    'TemplateRolloutStep',
  ),
  [`${base}/templates/{id}/inheritance`]: endpoint(
    'get',
    'templateInheritance',
    'TemplateInheritance',
    [parameter('id')],
  ),
  [`${base}/templates/{id}/diff`]: endpoint(
    'get',
    'templateVersionDifference',
    'TemplateVersionDifference',
    [
      parameter('id'),
      ...['from', 'to'].map((name) => ({
        name,
        in: 'query',
        required: true,
        schema: { type: 'integer', minimum: 1 },
      })),
    ],
  ),
};
