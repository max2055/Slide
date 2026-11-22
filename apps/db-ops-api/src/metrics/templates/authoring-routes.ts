import { createHash } from 'node:crypto';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { ActorAuthenticationError, actorContextService, type ActorContext } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { dbConnection } from '../../db-connection.js';
import { TemplateAuthoringRequests, TemplateAuthoringSchemas } from '../../contracts/metrics/template-authoring.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { stable } from '../packages/model.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { connectionTemplatePool } from './binding-service.js';
import { MetricTemplateService } from './service.js';
import { TemplateError } from './errors.js';
import { configuredRetention, DEFAULT_TREND_RETENTION_MS } from '../retention.js';
import { readMetricRetentionConfig } from '../../workflows/metric-retention-handler.js';
import { parsePackageReleaseRef } from './model.js';

const registry = createConfigurationRegistry();
const json = (schema: z.ZodType) => { const { $schema: _dialect, ...body } = z.toJSONSchema(schema); return body; };
const requirePermission = (actor: ActorContext, write = false) => {
  if (!hasPermission(new Set(actor.permissions), write ? 'metric:manage' : 'metric:view')) throw new TemplateError('TEMPLATE_FORBIDDEN');
};
export async function registerTemplateAuthoringRoutes(app: FastifyInstance, verify: preHandlerHookHandler,
  poolOf: () => Pool | null = () => dbConnection.getPool()) {
  const root = '/api/metrics/templates';
  const refusals = Object.fromEntries([400,401,403,404,409,422,503].map(code => [code,{ type:'object',properties:{error:{type:'string'}},required:['error'] }]));
  const sendError = (error: unknown, reply: any) => {
    if (error instanceof ActorAuthenticationError) return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
    if (error instanceof TemplateError) return reply.code(error.status).send({ error: error.code });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'TEMPLATE_INVALID_INPUT' });
    return (reply as any).code(503).send({ error: 'TEMPLATE_STORE_UNAVAILABLE' });
  };
  const actorOf = async (request: any, write = false) => {
    if (!request.user) throw new ActorAuthenticationError();
    const actor = await actorContextService.revalidateActor(request.user, request.id);
    requirePermission(actor, write); return actor;
  };
  for (const action of ['library', 'capabilities', 'editor'] as const) {
    const response = action === 'library' ? TemplateAuthoringSchemas.TemplateLibrary
      : action === 'capabilities' ? TemplateAuthoringSchemas.TemplateCapabilities : TemplateAuthoringSchemas.TemplateEditor;
    app.get(action === 'editor' ? `${root}/:templateId/editor` : `${root}/${action}`, {
      preHandler: [verify], schema: { response: { 200: json(response), ...refusals } },
    }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      try {
        const actor = await actorOf(request); const pool = poolOf();
        if (!pool) return (reply as any).code(503).send({ error: 'TEMPLATE_STORE_UNAVAILABLE' });
        const repository = new MySqlTemplateRepository(pool);
        const service = new MetricTemplateService(repository, registry);
        let result: unknown;
        if (action === 'capabilities') result = service.capabilities(actor);
        else if (action === 'editor') {
          const id = (request.params as { templateId: string }).templateId;
          const detail = await service.detail(actor, id);
          const draft = await repository.getDraft(id);
          const draftItems = await Promise.all((draft?.aggregate.items ?? []).map(ref => repository.getItemVersion(id, ref.item_id, ref.version)));
          const policy = configuredRetention();
          const mode = readMetricRetentionConfig()?.mode;
          const trends = policy.trendMs ?? DEFAULT_TREND_RETENTION_MS;
          const retention = { mode: mode === 'apply' ? 'apply' : mode === 'dry-run' ? 'preview' : 'off',
            history_ms: policy.historyMs, trends_ms: trends,
            by_value_type: [...new Set([...Object.keys(policy.valueTypeMs ?? {}), ...Object.keys(policy.trendValueTypeMs ?? {})])]
              .map(type => ({ type, history_ms: policy.valueTypeMs?.[type] ?? policy.historyMs,
                trends_ms: policy.trendValueTypeMs?.[type] ?? trends })) };
          const applicable = new Set((detail.current?.items ?? draftItems.filter(Boolean)).map(item =>
            registry.get(parsePackageReleaseRef(item.collector_ref.package_release)).recommendations.interval_ms));
          result = { ...detail, retention, default_interval_ms: applicable.size === 1 ? [...applicable][0] : null, items: draftItems.filter(Boolean), versions: await Promise.all(detail.versions.map(v => repository.getVersion(id, v.version))), draft, builtin: detail.template.created_by === null,
            can_manage: hasPermission(new Set(actor.permissions), 'metric:manage') };
        } else {
          const templates = []; let cursor: string | undefined;
          do {
            const page = await repository.listTemplates({ cursor, limit: 100 });
            for (const entry of page.items) {
              const template = (await repository.getTemplate(entry.template_id))!;
              const published = template.current_published_version === null ? null
                : await repository.getVersion(entry.template_id, template.current_published_version);
              const draft = published ? null : await repository.getDraft(entry.template_id);
              const aggregate = published?.aggregate ?? draft?.aggregate;
              const items = published?.items ?? await Promise.all((aggregate?.items ?? []).map(ref =>
                repository.getItemVersion(entry.template_id, ref.item_id, ref.version)));
              const types = new Set(items.filter(Boolean).map(item =>
                registry.get(parsePackageReleaseRef(item.collector_ref.package_release)).package.resource_type));
              templates.push({ template, builtin: template.created_by === null, resource_types: [...types],
                item_count: aggregate?.items.length ?? 0, trigger_count: aggregate?.triggers.length ?? 0,
                discovery_count: aggregate?.discovery_rules?.length ?? 0 });
            }
            cursor = page.next_cursor ?? undefined;
          } while (cursor);
          result = { templates, can_manage: hasPermission(new Set(actor.permissions), 'metric:manage') };
        }
        const current = await actorOf(request); // A read that waited cannot disclose under a revoked session.
        if (action !== 'capabilities') (result as { can_manage: boolean }).can_manage = hasPermission(new Set(current.permissions), 'metric:manage');
        return result;
      } catch (error) { return sendError(error, reply); }
    });
  }
  for (const action of Object.keys(TemplateAuthoringRequests) as Array<keyof typeof TemplateAuthoringRequests>) {
    app.post(action === 'create' ? root : `${root}/:templateId/${action}`, { preHandler: [verify], bodyLimit: 131072,
      preValidation: async (request, reply) => {
        // Validate before AJV's default removeAdditional can strip caller fields.
        if (!TemplateAuthoringRequests[action].safeParse(request.body).success) {
          return (reply as any).code(400).send({ error: 'TEMPLATE_INVALID_INPUT' });
        }
      },
      schema: { body: json(TemplateAuthoringRequests[action]), response: { 200: json(TemplateAuthoringSchemas.TemplateAuthoringResult), ...refusals } },
    }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      let connection: Awaited<ReturnType<Pool['getConnection']>> | undefined;
      let reusable = false;
      try {
        const actor = await actorOf(request, true); const pool = poolOf();
        if (!pool) return (reply as any).code(503).send({ error: 'TEMPLATE_STORE_UNAVAILABLE' });
        const id = action === 'create' ? null : (request.params as { templateId: string }).templateId;
        const { operation_key, ...input } = TemplateAuthoringRequests[action].parse(request.body);
        const hash = createHash('sha256').update(stable({ action, id, input })).digest('hex');
        connection = await pool.getConnection();
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        // Lock existing keys exclusively as well. INSERT IGNORE takes a shared
        // duplicate-key lock and concurrent replays can deadlock upgrading it.
        await connection.execute(`INSERT INTO metric_template_authoring_operations(actor_id,operation_key,intent_hash) VALUES(?,?,?)
          ON DUPLICATE KEY UPDATE operation_key=operation_key`,
          [actor.userId, operation_key, hash]);
        const [rows] = await connection.execute<any[]>(`SELECT intent_hash,result FROM metric_template_authoring_operations WHERE actor_id=? AND operation_key=? FOR UPDATE`, [actor.userId, operation_key]);
        if (rows[0].intent_hash !== hash) throw new TemplateError('TEMPLATE_REVISION_CONFLICT');
        let result = typeof rows[0].result === 'string' ? JSON.parse(rows[0].result) : rows[0].result;
        if (!result) {
          const repository = new MySqlTemplateRepository(connectionTemplatePool(connection));
          const service = new MetricTemplateService(repository, registry);
          if (id === null) {
            result = { template: await service.create(actor, input) };
          } else {
            const template = await repository.getTemplate(id);
            if (!template) throw new TemplateError('TEMPLATE_NOT_FOUND');
            if (action !== 'copy' && template.created_by === null) throw new TemplateError('TEMPLATE_FORBIDDEN');
            if (action === 'copy') result = { template: await service.copy(actor, id, input) };
            if (action === 'name') result = { template: await service.rename(actor, id, input) };
            if (action === 'item') { const selected = await service.selectMetric(actor, id, input); result = { item: selected.item, auto: selected.auto }; }
            if (action === 'draft') result = { draft: await service.updateDraft(actor, id, input) };
            if (action === 'save') {
              await connection.execute('SELECT template_id FROM monitoring_templates WHERE template_id = ? FOR UPDATE', [id]);
              const locked = await repository.getTemplate(id);
              const edit = TemplateAuthoringRequests.save.parse(request.body);
              const original = await repository.getDraft(id);
              if (!locked || locked.revision !== edit.expected_revision) throw new TemplateError('TEMPLATE_REVISION_CONFLICT');
              if (!original || original.revision !== edit.expected_draft_revision) throw new TemplateError('TEMPLATE_DRAFT_CONFLICT');
              const renamed = edit.name.trim() === locked.name ? locked
                : await service.rename(actor, id, { name: edit.name, expected_revision: edit.expected_revision });
              const aggregate = structuredClone(edit.aggregate);
              const seen = new Set<string>();
              for (const change of edit.item_names) {
                const ref = aggregate.items.find(ref => ref.item_id === change.item_id);
                if (!ref || seen.has(ref.item_id)) throw new TemplateError('TEMPLATE_INVALID_INPUT');
                seen.add(ref.item_id);
                const item = await repository.getItemVersion(id, ref.item_id, ref.version);
                if (!item) throw new TemplateError('TEMPLATE_ITEM_NOT_FOUND');
                const selected = await service.selectMetric(actor, id, { item_id: item.item_id,
                  display_name: change.display_name, metric: item.canonical_metric,
                  package: parsePackageReleaseRef(item.collector_ref.package_release) });
                ref.version = selected.item.version;
              }
              const draft = await service.updateDraft(actor, id, { expected_draft_revision: edit.expected_draft_revision, aggregate });
              result = { template: renamed, draft };
              if (edit.publish) {
                const published = await service.publish(actor, id, {
                  expected_revision: renamed.revision, expected_draft_revision: draft.revision,
                });
                result = { published: await repository.getVersion(id, published.version) };
              }
            }
            if (action === 'publish') {
              const published = await service.publish(actor, id, input);
              result = { published: await repository.getVersion(id, published.version) };
            }
          }
          await connection.execute(`UPDATE metric_template_authoring_operations SET result=? WHERE actor_id=? AND operation_key=?`, [JSON.stringify(result), actor.userId, operation_key]);
        }
        // Includes retries: never return a cached write result after revocation.
        requirePermission(await actorContextService.revalidateActorOn({ execute: (sql,values) => connection!.execute(sql,values as any) }, actor, actor.requestId, true), true);
        await connection.commit(); reusable = true;
        return result;
      } catch (error) {
        if (connection) { try { await connection.rollback(); reusable = true; } catch { /* discard */ } }
        return sendError(error, reply);
      } finally { if (connection) { if (reusable) connection.release(); else connection.destroy(); } }
    });
  }
}
