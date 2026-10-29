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
import { ActorAuthenticationError } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { dbConnection } from '../../db-connection.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { createAssetCollectorAccess } from '../config/access.js';
import { RefSchema, rule } from '../policy/model.js';
import {
  TemplateBindingService, poolTemplatePort, templateBindingErrorStatus,
} from './binding-service.js';
import { repinTemplateVersion, templatePinOf, RepinError } from './repin.js';
import { configurationInventory } from '../config/inventory.js';

const registry = createConfigurationRegistry();
const productionPool = (): Pool | null => dbConnection.getPool();

/** One service for the process; the access object owns the per-resource caches. */
export const templateBindingService = new TemplateBindingService({
  pool: productionPool, registry, access: createAssetCollectorAccess(),
});

const ref = (params: unknown) => {
  const p = params as { type: string; id: string };
  rule(/^[1-9]\d*$/.test(p.id), 'POLICY_RESOURCE');
  return RefSchema.parse({ type: p.type, id: Number(p.id) });
};

const refuse = (error: unknown, fallback: string) => {
  if (error instanceof ActorAuthenticationError) return { status: 401, code: 'POLICY_AUTH_REQUIRED' };
  const mapped = templateBindingErrorStatus(error);
  if (mapped) return mapped;
  if (error instanceof z.ZodError) return { status: 400, code: 'TEMPLATE_BINDING_INPUT_INVALID' };
  return { status: 500, code: fallback };
};

export async function registerMetricTemplateRoutes(
  app: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  service: TemplateBindingService = templateBindingService,
): Promise<void> {
  const actorOf = (request: unknown) => (request as { user?: ActorContext }).user;

  app.route({ method: 'GET', url: '/api/metrics/templates', preHandler: [verifyToken], handler: async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const actor = actorOf(request);
    if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
    if (!hasPermission(new Set(actor.permissions), 'metric:view')) return reply.code(403).send({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
    const pool = productionPool();
    if (!pool) return reply.code(503).send({ error: 'TEMPLATE_BINDING_STORE_UNAVAILABLE' });
    try {
      const repository = poolTemplatePort(pool);
      const page = await repository.listTemplates({ limit: 100 });
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
      return { templates };
    } catch {
      return reply.code(500).send({ error: 'TEMPLATE_LIST_FAILED' });
    }
  } });

  app.route({ method: 'GET', url: '/api/metrics/templates/:templateId/versions/:version', preHandler: [verifyToken],
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
    bodyLimit: 16384, handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
      if (!hasPermission(new Set(actor.permissions), 'metric:manage')) return reply.code(403).send({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
      const pool = productionPool();
      if (!pool) return reply.code(503).send({ error: 'TEMPLATE_BINDING_STORE_UNAVAILABLE' });
      const input = z.strictObject({ resource: RefSchema }).safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'TEMPLATE_BINDING_INPUT_INVALID' });
      try {
        const resource = await configurationInventory(input.data.resource);
        const result = await repinTemplateVersion({
          repository: poolTemplatePort(pool), registry, templateId: (request.params as { templateId: string }).templateId,
          resource, requestId: actor.requestId,
        });
        if ('unchanged' in result) return { unchanged: true, template_id: result.template_id, version: result.version };
        return {
          unchanged: false, template_id: result.template_id, from_version: result.from_version,
          to_version: result.to_version, content_hash: result.content_hash, changes: result.changes,
          pin: templatePinOf(result.version),
        };
      } catch (error) {
        if (error instanceof RepinError) return reply.code(422).send({ error: error.code, item_id: error.item_id });
        return reply.code(500).send({ error: 'TEMPLATE_REPIN_FAILED' });
      }
    } });

  const root = '/api/metrics/template-bindings';
  const flow: Array<{ method: 'GET' | 'POST'; suffix: string; run: (actor: ActorContext, params: unknown, body: unknown) => Promise<unknown> }> = [
    { method: 'GET', suffix: '', run: (actor, params) => service.status(actor, ref(params)) },
    { method: 'POST', suffix: '/preview', run: (actor, params, body) => service.preview(actor, ref(params), body) },
    { method: 'POST', suffix: '/trial', run: (actor, params, body) => service.trial(actor, ref(params), body) },
    { method: 'POST', suffix: '/apply', run: (actor, params, body) => service.apply(actor, ref(params), body) },
  ];
  for (const route of flow) {
    app.route({ method: route.method, url: `${root}/:type/:id${route.suffix}`, preHandler: [verifyToken],
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
          return reply.code(mapped.status).send({ error: mapped.code });
        }
      } });
  }
}
