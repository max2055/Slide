import { z } from 'zod';
import { RefSchema } from '../../metrics/policy/model.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const DiscoveryRuleSchema = z.strictObject({
  rule_id: id, name: z.string().trim().min(1).max(128),
  item_ids: z.array(id).min(1).max(32),
  identity_dimensions: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(8),
  timeout_ms: z.number().int().min(100).max(30000),
  max_instances: z.number().int().min(1).max(1000),
  lost_after_ms: z.number().int().min(1000).max(2592000000),
  retire_after_ms: z.number().int().min(1000).max(31536000000),
}).superRefine((v, ctx) => {
  if (new Set(v.item_ids).size !== v.item_ids.length || new Set(v.identity_dimensions).size !== v.identity_dimensions.length
    || v.retire_after_ms < v.lost_after_ms) ctx.addIssue({ code: 'custom', message: 'DISCOVERY_RULE_INVALID' });
});
export type DiscoveryRule = z.infer<typeof DiscoveryRuleSchema>;
export const DiscoveryInstanceSchema = z.strictObject({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/), identity: z.string().min(1).max(2048), name: z.string().max(512),
  dimensions: z.record(z.string(), z.string()),
  dimension_history: z.array(z.record(z.string(), z.string())),
  first_seen: z.number(), last_seen: z.number(), missing_since: z.number().nullable(),
  state: z.enum(['active', 'waiting', 'disabled', 'retired']), manual: z.boolean(),
  transitions: z.array(z.strictObject({ state: z.enum(['active', 'waiting', 'disabled', 'retired']), at: z.number() })),
});
export type DiscoveryInstance = z.infer<typeof DiscoveryInstanceSchema>;
export const DiscoveryPreviewRequestSchema = z.strictObject({ resource: RefSchema, version: z.number().int().positive(),
  operation_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) });
export const DiscoveryStateRowSchema = z.strictObject({ template_id: id, rule_id: id, revision: z.number().int().nonnegative(),
  state: z.object({ template_version: z.number(), content_hash: z.string(), config_revision: z.number(), rule: DiscoveryRuleSchema,
    items: z.array(z.object({ item_id: id, version: z.number(), display_name: z.string() })),
    triggers: z.array(z.object({ rule_id: id, version: z.number(), scope: z.string() })), members: z.array(DiscoveryInstanceSchema) }) });
export const DiscoveryPreviewSchema = z.object({ state: z.enum(['completed','unknown']), version: z.number(), content_hash: z.string(),
  rules: z.array(z.object({ rule: DiscoveryRuleSchema, status: z.enum(['complete','unknown']), count: z.number(),
    members: z.array(z.object({ identity: z.string(), name: z.string(), dimensions: z.record(z.string(),z.string()) })), error: z.string().nullable(),
    budget: z.object({ timeout_ms: z.number(), max_instances: z.number(), item_upper_bound: z.number(), trigger_upper_bound: z.number() }) })) });
export const DiscoveryStopSchema = z.strictObject({ expected_revision: z.number().int().positive(), template_id: id, rule_id: id,
  instance_id: z.string().regex(/^sha256:[a-f0-9]{64}$/), action: z.enum(['disabled','retired']) });
export const discoverySchemas = { DiscoveryPreviewRequest: DiscoveryPreviewRequestSchema, DiscoveryPreview: DiscoveryPreviewSchema,
  DiscoveryState: z.object({ rows: z.array(DiscoveryStateRowSchema) }), DiscoveryStop: DiscoveryStopSchema };
const response = (name: string) => ({ description: 'Live authorized discovery facts', content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } });
const errors = { '400': { description:'Invalid input' }, '401': { description:'Revoked session' }, '403': { description:'Resource authority denied' },
  '409': { description:'Revision conflict or unknown prior enumeration; never replay' }, '422': { description:'Prototype unavailable' }, '503': { description:'Result unknown' } };
export const discoveryPaths = {
  '/api/metrics/templates/{templateId}/discovery-preview': { post: { operationId:'previewTemplateDiscovery', security:[{bearerAuth:[]}],
    parameters:[{name:'templateId',in:'path',required:true,schema:{type:'string'}}],
    requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/DiscoveryPreviewRequest'}}}},responses:{'200':response('DiscoveryPreview'),...errors} } },
  ...Object.fromEntries(['get','post'].map(method => ['/api/metrics/discovery/{type}/{id}'+(method==='post'?'/stop':''),{[method]: {
    operationId:method==='get'?'getDiscoveryState':'stopDiscoveryInstance',security:[{bearerAuth:[]}],
    parameters:[{name:'type',in:'path',required:true,schema:{type:'string',enum:['instance','server','network_device']}},{name:'id',in:'path',required:true,schema:{type:'integer'}}],
    ...(method==='post'?{requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/DiscoveryStop'}}}}}:{}),
    responses:{'200':response('DiscoveryState'),...errors},
  }}])),
};
