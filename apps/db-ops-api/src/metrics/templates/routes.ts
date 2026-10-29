/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R1 — HTTP entry for native templates.
 *
 * Two surfaces, both behind the existing token pre-handler:
 *
 * - read-only catalog: the persisted template identities and their immutable
 *   versions (`/api/metrics/templates`), so a binding UI can name a fixed version
 *   and its content hash instead of an internal package;
 * - binding flow: preview → trial → apply for one resource
 *   (`/api/metrics/template-bindings/...`). The trial performs real read-only
 *   collection through the accepted collector access; apply stages the binding
 *   through the accepted host.
 *
 * Nothing here authorizes by itself: resource access is re-checked in the service
 * with the shared resource relation store, and every rejection is one stable code.
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { ActorAuthenticationError, actorContextService } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { dbConnection } from '../../db-connection.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { createAssetCollectorAccess } from '../config/access.js';
import { RefSchema, rule } from '../policy/model.js';
import {
  TemplateBindingApplyBodySchema, TemplateRepinBodySchema, TemplateTrialBodySchema, TemplateBindingBodySchema,
} from '../../contracts/metrics/template-bindings.js';
import { metricJsonSchemas } from '../../contracts/metrics/public-api.js';
import {
  TemplateBindingService, poolTemplatePort, templateBindingErrorStatus,
} from './binding-service.js';
import { templatePinOf, RepinError } from './repin.js';
import { BindingCandidateError } from '../bindings/compile.js';
import { BindingPreflightError } from '../bindings/preflight.js';
import { TemplateResolutionError } from '../bindings/resolve.js';

const registry = createConfigurationRegistry();
const productionPool = (): Pool | null => dbConnection.getPool();

/** The generated JSON schema of one public component; the route and OpenAPI share it. */
const json = (name: keyof typeof metricJsonSchemas): Record<string, unknown> => metricJsonSchemas[name] as Record<string, unknown>;
/**
 * Every rejection the flow can answer with; stable codes only, never a driver
 * message. Structured conflict fields exist so the UI can name the exact item
 * or setting that has to be resolved before the flow may continue.
 */
const errorSchema = { type: 'object', properties: {
  error: { type: 'string' }, item_id: { type: 'string' }, template_id: { type: ['string', 'null'] },
  parameter: { type: ['string', 'null'] }, field: { type: ['string', 'null'] }, rule: { type: ['string', 'null'] },
  release: { type: ['string', 'null'] },
  canonical_metric: { type: 'object', additionalProperties: true },
  providers: { type: 'array', items: { type: 'object', additionalProperties: true } },
  conflicts: { type: 'array', items: { type: 'object', additionalProperties: true } },
  values: { type: 'array', items: { type: 'object', additionalProperties: true } },
  location: { type: 'object', additionalProperties: true },
}, required: ['error'], additionalProperties: {} } as const;
const refusal = (status: number) => ({ [status]: errorSchema });
const refusals = (statuses: number[]) => Object.assign({}, ...statuses.map(refusal));
const resourceParams = { type: 'object', additionalProperties: false, required: ['type', 'id'],
  properties: { type: { type: 'string', enum: ['instance', 'server', 'network_device'] },
    id: { type: 'string', pattern: '^[1-9][0-9]*$' } } };
const templateIdParams = { type: 'object', additionalProperties: false, required: ['templateId'],
  properties: { templateId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } } };
const versionParams = { type: 'object', additionalProperties: false, required: ['templateId', 'version'],
  properties: { templateId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
    version: { type: 'string', pattern: '^[0-9]+$' } } };

const bodyOf = (schema: z.ZodType): Record<string, unknown> => {
  const document = z.toJSONSchema(schema, { unrepresentable: 'throw' }) as Record<string, unknown>;
  // Fastify's validator only needs the shape; the dialect marker is not a keyword there.
  const { $schema: _dialect, ...body } = document;
  return body;
};

/** One service for the process; the access object owns the per-resource caches. */
export const templateBindingService = new TemplateBindingService({
  pool: productionPool, registry, access: createAssetCollectorAccess(),
  reload: actor => actorContextService.revalidateActor(actor, actor.requestId),
  // Persistence boundaries re-read on the connection already held (receipt
  // writer / re-pin transaction), so no second pool connection is needed.
  reloadOn: (actor, executor) => actorContextService.revalidateActorOn(executor, actor, actor.requestId),
});

const ref = (params: unknown) => {
  const p = params as { type: string; id: string };
  rule(/^[1-9]\d*$/.test(p.id), 'POLICY_RESOURCE');
  return RefSchema.parse({ type: p.type, id: Number(p.id) });
};

interface Refusal { status: number; code: string; extra?: Record<string, unknown> }
const refuse = (error: unknown, fallback: string): Refusal => {
  if (error instanceof ActorAuthenticationError) return { status: 401, code: 'POLICY_AUTH_REQUIRED' };
  const mapped = templateBindingErrorStatus(error);
  if (mapped) return mapped;
  // Candidate/preflight/resolution rejections are business answers about the
  // exact pin or item, not server failures: the caller must resolve them.
  if (error instanceof BindingCandidateError) return { status: 422, code: error.code, extra: {
    template_id: error.location.pin?.template_id ?? null, item_id: error.location.item?.item_id ?? null,
    release: error.location.release?.id ?? null,
  } };
  if (error instanceof BindingPreflightError) return { status: 422, code: error.code, extra: {
    conflicts: error.conflicts.map(conflict => ({ code: conflict.code, canonical_metric: conflict.canonical_metric,
      providers: conflict.providers })),
  } };
  if (error instanceof TemplateResolutionError) return { status: 422, code: error.code, extra: {
    template_id: error.location.template_id, parameter: error.location.parameter, field: error.location.field,
    rule: error.rule, location: error.location,
    ...(error.conflicts.length ? { conflicts: error.conflicts } : {}),
  } };
  if (error instanceof z.ZodError) return { status: 400, code: 'TEMPLATE_BINDING_INPUT_INVALID' };
  return { status: 500, code: fallback };
};

export async function registerMetricTemplateRoutes(
  app: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  service: TemplateBindingService = templateBindingService,
): Promise<void> {
  const actorOf = (request: unknown) => (request as { user?: ActorContext }).user;

  app.route({ method: 'GET', url: '/api/metrics/templates', preHandler: [verifyToken],
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 128 }, status: { type: 'string', enum: ['draft', 'active', 'deprecated', 'archived'] },
      cursor: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
      limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    response: { 200: json('TemplateCatalog'), ...refusals([400, 401, 403, 500, 503]) } },
    handler: async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const actor = actorOf(request);
    if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
    if (!hasPermission(new Set(actor.permissions), 'metric:view')) return reply.code(403).send({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
    const pool = productionPool();
    if (!pool) return reply.code(503).send({ error: 'TEMPLATE_BINDING_STORE_UNAVAILABLE' });
    const params = (request.query ?? {}) as { query?: string; status?: 'draft' | 'active' | 'deprecated' | 'archived';
      cursor?: string; limit?: number };
    try {
      const repository = poolTemplatePort(pool);
      const page = await repository.listTemplates({
        query: params.query?.trim() || undefined, status: params.status, cursor: params.cursor, limit: params.limit,
      });
      const templates = [];
      for (const summary of page.items) {
        const versions = await repository.listVersions(summary.template_id);
        templates.push({
          template_id: summary.template_id, name: summary.name, status: summary.status,
          current_published_version: summary.current_published_version ?? null,
          versions: versions.map(version => ({ version: version.version, content_hash: version.content_hash,
            status: version.status })),
        });
      }
      return { templates, next_cursor: page.next_cursor };
    } catch {
      return reply.code(500).send({ error: 'TEMPLATE_LIST_FAILED' });
    }
  } });

  app.route({ method: 'GET', url: '/api/metrics/templates/:templateId/versions/:version', preHandler: [verifyToken],
    schema: { params: versionParams,
      response: { 200: json('TemplateVersionDetail'), ...refusals([400, 401, 403, 404, 500, 503]) } },
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      if (!hasPermission(new Set(actor.permissions), 'metric:view')) return reply.code(403).send({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
      const pool = productionPool();
      if (!pool) return reply.code(503).send({ error: 'TEMPLATE_BINDING_STORE_UNAVAILABLE' });
      const params = request.params as { templateId: string; version: string };
      if (!/^\d+$/.test(params.version)) return reply.code(400).send({ error: 'TEMPLATE_BINDING_INPUT_INVALID' });
      try {
        const version = await poolTemplatePort(pool).getVersion(params.templateId, Number(params.version));
        if (!version) return reply.code(404).send({ error: 'TEMPLATE_VERSION_NOT_FOUND' });
        return {
          template_id: version.template_id, version: version.version, status: version.status,
          content_hash: version.content_hash, package_composition: version.package_composition,
          items: version.items.map(item => ({
            item_id: item.item_id, version: item.version, display_name: item.display_name,
            canonical_metric: item.canonical_metric, unit: item.unit, dimensions: item.dimensions,
            collector_ref: item.collector_ref,
          })),
          parameters: version.aggregate.parameters,
          source_chain: version.source_chain,
          published_at: version.published_at,
        };
      } catch {
        return reply.code(500).send({ error: 'TEMPLATE_VERSION_FAILED' });
      }
    } });

  // Version compatibility: publish a new immutable version whose incompatible
  // items pin an installed release that applies to this target. Never edits the
  // published version and never relaxes applicability.
  app.route({ method: 'POST', url: '/api/metrics/templates/:templateId/repin', preHandler: [verifyToken],
    schema: { params: templateIdParams, body: bodyOf(TemplateRepinBodySchema),
      response: { 200: json('TemplateRepinResponse'), ...refusals([400, 401, 403, 404, 422, 500, 503]) } },
    bodyLimit: 16384, handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      if (!hasPermission(new Set(actor.permissions), 'metric:manage')) return reply.code(403).send({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
      const input = z.strictObject({ resource: RefSchema }).safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'TEMPLATE_BINDING_INPUT_INVALID' });
      try {
        // Re-pinning publishes a new global template version on the strength of
        // this resource's applicability: the caller must manage that resource,
        // not merely hold `metric:manage` over some scope. The service re-reads
        // that live grant at every publication boundary.
        const result = await service.repin(actor, input.data.resource,
          (request.params as { templateId: string }).templateId);
        if ('unchanged' in result) return { unchanged: true, template_id: result.template_id, version: result.version };
        return {
          unchanged: false, template_id: result.template_id, from_version: result.from_version,
          to_version: result.to_version, content_hash: result.content_hash, changes: result.changes,
          pin: templatePinOf(result.version),
        };
      } catch (error) {
        if (error instanceof RepinError) return reply.code(422).send({ error: error.code, item_id: error.item_id });
        const mapped = refuse(error, 'TEMPLATE_REPIN_FAILED');
        return reply.code(mapped.status).send({ error: mapped.code, ...mapped.extra });
      }
    } });

  const root = '/api/metrics/template-bindings';
  const flow: Array<{ method: 'GET' | 'POST'; suffix: string; response: string;
    body?: z.ZodType;
    run: (actor: ActorContext, params: unknown, body: unknown) => Promise<unknown> }> = [
    { method: 'GET', suffix: '', response: 'TemplateBindingStatus',
      run: (actor, params) => service.status(actor, ref(params)) },
    { method: 'POST', suffix: '/preview', response: 'TemplateBindingPreview', body: TemplateBindingBodySchema,
      run: (actor, params, body) => service.preview(actor, ref(params), body) },
    { method: 'POST', suffix: '/trial', response: 'TemplateTrialResponse', body: TemplateTrialBodySchema,
      run: (actor, params, body) => service.trial(actor, ref(params), body) },
    { method: 'POST', suffix: '/apply', response: 'TemplateBindingApplyResponse', body: TemplateBindingApplyBodySchema,
      run: (actor, params, body) => service.apply(actor, ref(params), body) },
  ];
  for (const route of flow) {
    app.route({ method: route.method, url: `${root}/:type/:id${route.suffix}`, preHandler: [verifyToken],
      schema: { params: resourceParams, ...(route.body ? { body: bodyOf(route.body) } : {}),
        response: { 200: json(route.response as keyof typeof metricJsonSchemas),
          ...refusals([400, 401, 403, 404, 409, 422, 500, 503]) } },
      bodyLimit: 65536, handler: async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        const actor = actorOf(request);
        if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
        try { return await route.run(actor, request.params, request.body); }
        catch (error) {
          const mapped = refuse(error, 'TEMPLATE_BINDING_FAILED');
          if (mapped.status >= 500) {
            // Stable diagnostics only: no payload, receipt or driver message.
            request.log.error({ template_flow: route.suffix || 'status', code: mapped.code,
              name: error instanceof Error ? error.name : typeof error },
            error instanceof Error ? error.message.slice(0, 200) : 'unknown');
          }
          return reply.code(mapped.status).send({ error: mapped.code, ...mapped.extra });
        }
      } });
  }

  // Recovery for one client apply intent. The row is the native host's own
  // operation record (written in its apply transaction), never a legacy table
  // nor an inference from the current binding.
  app.route({ method: 'GET', url: `${root}/:type/:id/operations/:key`, preHandler: [verifyToken],
    schema: { params: { type: 'object', additionalProperties: false, required: ['type', 'id', 'key'],
      properties: { ...resourceParams.properties, key: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } } },
      response: { 200: json('TemplateOperationState'), ...refusals([400, 401, 403, 404, 500, 503]) } },
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      try {
        const params = request.params as { type: string; id: string; key: string };
        return await service.operation(actor, ref(params), params.key);
      } catch (error) {
        const mapped = refuse(error, 'TEMPLATE_OPERATION_FAILED');
        return reply.code(mapped.status).send({ error: mapped.code, ...mapped.extra });
      }
    } });
}
