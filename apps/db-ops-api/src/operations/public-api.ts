import { planDiscoverySchema, trustedDraftSchema, manualCaseBindingSchema } from './ui-integration.js';
/** Public request contracts consume the same strict validators as domain writes.
 * Responses retain domain lifecycle/unknown semantics; no dispatch endpoint. */
import { z } from 'zod';
import { candidateSchema, revisionSchema, reviewSchema, transitionSchema, withdrawalSchema } from './knowledge/service.js';
import { searchInputSchema } from './knowledge/search.js';
import { baselineInputSchema } from './baselines/source-adapter.js';
import { actionPlanContentSchema, resourceRefSchema, versionReferenceSchema } from './contracts.js';

const relation = z.strictObject({ source: resourceRefSchema, target: resourceRefSchema,
  relationType: z.enum(['runs_on', 'replicates_to', 'depends_on', 'connected_to', 'serves']),
  evidence: z.array(versionReferenceSchema).max(100), observedAt: z.iso.datetime({ precision: 3 }),
  validFrom: z.iso.datetime({ precision: 3 }), validUntil: z.iso.datetime({ precision: 3 }).nullable(),
  origin: z.enum(['manual', 'collector', 'model']) });
const revision = relation.omit({ source: true, target: true, relationType: true }).extend({ expectedVersion: z.number().int().nonnegative() });
const transition = z.strictObject({ expectedVersion: z.number().int().nonnegative(), action: z.enum(['confirm', 'withdraw']), reason: z.string().trim().min(1).max(1000).optional() });
const version = z.strictObject({ expectedVersion: z.number().int().positive().safe() });
const plan = z.strictObject({ content: z.record(z.string(), z.unknown()), lifetimeMs: z.number().int().positive().max(1800000).optional() });
const schemas = {
  OperationsPlanDiscovery: planDiscoverySchema, OperationsTrustedDraft: trustedDraftSchema, OperationsManualCaseBinding: manualCaseBindingSchema,
  OperationsCaseCandidate: candidateSchema, OperationsCaseRevision: revisionSchema, OperationsCaseReview: reviewSchema,
  OperationsCaseTransition: transitionSchema, OperationsCaseWithdrawal: withdrawalSchema, OperationsCaseSearch: searchInputSchema,
  OperationsBaselineInput: baselineInputSchema, OperationsResourceRef: resourceRefSchema,
  OperationsRelationInput: relation, OperationsRelationRevision: revision, OperationsRelationTransition: transition,
  OperationsPlanContent: actionPlanContentSchema, OperationsPlanProposal: plan,
  OperationsPlanRevision: plan.extend({ expectedVersion: z.number().int().positive().safe() }),
  OperationsPlanVersion: version,
  OperationsPlanReview: version.extend({ approvalId: z.string().regex(/^[1-9]\d{0,19}$/), action: z.enum(['approve','reject']), note: z.string().max(1000).optional() }),
  OperationsAttentionInput: z.strictObject({ observedAt: z.iso.datetime({ precision: 3 }), resources: z.array(resourceRefSchema).min(1).max(20) }),
  OperationsAttentionOverride: z.strictObject({ expectedVersion: z.number().int().positive().safe(), reason: z.string().trim().min(1).max(1000), partitions: z.array(z.array(z.string().uuid()).min(1).max(1000)).min(1).max(1000) }),
};
export const operationsJsonSchemas = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema);
  return [name, json];
}));
const route = (method: string, operationId: string, input?: keyof typeof schemas) => ({ [method]: {
  operationId, security: [{ bearerAuth: [] }],
  description: 'Live JWT/session, original delegation ceiling and complete resource/source ACL. Private/no-store. New writes require live feature flag; historical reads remain protected. Synthetic fixtures do not establish real qualification. Preparation has no action dispatcher; plans require a reviewed real environment validator.',
  ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } } } } : {}),
  responses: { '200': { description: 'Authorized domain result, preserving unknown and immutable version/hash' },
    '201': { description: 'Created immutable candidate/version' }, '401': { description: 'Missing or revoked JWT' },
    '403': { description: 'Mutation denied or self review' }, '404': { description: 'Content/source not visible' },
    '409': { description: 'Version/cursor conflict' }, '422': { description: 'Input, feature or source precondition failed' },
    '503': { description: 'Dependency unavailable; no inferred success or replay' } },
} });
export const operationsPublicPaths = {
  '/api/operations/knowledge': { ...route('get','searchOperationsCases'), ...route('post','createOperationsCase','OperationsCaseCandidate') },
  '/api/operations/knowledge/{id}': { ...route('get','readOperationsCase'), ...route('put','reviseOperationsCase','OperationsCaseRevision') },
  '/api/operations/knowledge/{id}/submit': route('post','submitOperationsCase','OperationsCaseTransition'),
  '/api/operations/knowledge/{id}/review': route('post','reviewOperationsCase','OperationsCaseReview'),
  '/api/operations/knowledge/{id}/withdraw': route('post','withdrawOperationsCase','OperationsCaseWithdrawal'),
  '/api/operations/relations': route('post','suggestOperationsRelation','OperationsRelationInput'),
  '/api/operations/relations/{id}/revisions': { ...route('get','readOperationsRelationHistory'), ...route('post','reviseOperationsRelation','OperationsRelationRevision') },
  '/api/operations/relations/{id}/review': route('post','reviewOperationsRelation','OperationsRelationTransition'),
  '/api/operations/resources/{type}/{id}/relations': route('get','readOperationsGraph'),
  '/api/operations/baselines': route('post','computeOperationsBaseline','OperationsBaselineInput'),
  '/api/operations/baselines/{id}': route('get','readOperationsBaseline'),
  '/api/operations/attention': route('post','computeOperationsAttention','OperationsAttentionInput'),
  '/api/operations/attention/{id}': route('get','readOperationsAttention'),
  '/api/operations/attention/{id}/overrides': route('post','overrideOperationsAttention','OperationsAttentionOverride'),
  '/api/operations/actions/plans': { ...route('get','discoverOperationsPlans'), ...route('post','createOperationsPlan','OperationsPlanProposal') },
  '/api/operations/actions/drafts': route('post','createTrustedOperationsDraft','OperationsTrustedDraft'),
  '/api/operations/knowledge/{id}/watch': route('get','watchOperationsCase'),
  '/api/operations/knowledge/{id}/bind': route('post','bindOperationsCase','OperationsManualCaseBinding'),
  '/api/operations/actions/plans/{id}': route('get','readOperationsPlan'),
  '/api/operations/actions/plans/{id}/versions': route('post','reviseOperationsPlan','OperationsPlanRevision'),
  '/api/operations/actions/plans/{id}/submit': route('post','submitOperationsPlan','OperationsPlanVersion'),
  '/api/operations/actions/plans/{id}/review': route('post','reviewOperationsPlan','OperationsPlanReview'),
};
// Every templated path parameter is explicitly required by OpenAPI.
for (const [path, methods] of Object.entries(operationsPublicPaths)) for (const operation of Object.values(methods)) {
  Object.assign(operation, { parameters: [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) });
}
