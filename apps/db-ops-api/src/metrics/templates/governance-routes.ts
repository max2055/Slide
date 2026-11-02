import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { dbConnection } from '../../db-connection.js';
import { actorContextService, ActorAuthenticationError } from '../../auth/actor-context.js';
import { canReadResource } from '../../resources/resource-service.js';
import { RefSchema, PolicyError, rule } from '../policy/model.js';
import { hasPermission } from '../../auth/require-permission.js';
import { RolloutStep } from '../../contracts/metrics/template-governance.js';
import { TemplateGovernance } from './governance.js';
import { templateBindingService } from './routes.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { inheritTemplate } from './inheritance.js';
import { TemplateError } from './errors.js';
import { templateBindingErrorStatus } from './binding-service.js';
import { stable } from '../packages/model.js';
export async function registerTemplateGovernanceRoutes(
  app: FastifyInstance,
  verify: preHandlerHookHandler,
  poolOf: () => Pool = () => {
    const p = dbConnection.getPool();
    if (!p) throw Error('unavailable');
    return p;
  },
  service = new TemplateGovernance(poolOf, templateBindingService),
) {
  const root = '/api/metrics/template-governance';
  for (const action of [
    'inventory',
    'preview',
    'batch',
    'read',
    'step',
    'inheritance',
    'diff',
  ] as const) {
    const url =
      action === 'inventory'
        ? `${root}/resources`
        : action === 'preview'
          ? `${root}/preview`
          : action === 'batch'
            ? `${root}/batches`
            : action === 'read'
              ? `${root}/batches/:id`
              : action === 'step'
                ? `${root}/batches/:id/:type/:resourceId`
                : action === 'inheritance'
                  ? `${root}/templates/:id/inheritance`
                  : `${root}/templates/:id/diff`;
    app.route({
      method: action === 'batch' || action === 'preview' || action === 'step' ? 'POST' : 'GET',
      url,
      preHandler: [verify],
      bodyLimit: 131072,
      handler: async (req: any, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        try {
          const actor = await actorContextService.revalidateActor(req.user, req.id);
          rule(hasPermission(new Set(actor.permissions), 'metric:view'), 'ROLLOUT_FORBIDDEN', 403);
          if (action === 'inventory') return await service.inventory(actor);
          if (action === 'preview') return await service.preview(actor, req.body);
          if (action === 'batch') return await service.create(actor, req.body);
          if (action === 'read') return await service.read(actor, req.params.id);
          if (action === 'step') {
            const body = RolloutStep.parse(req.body);
            return await service.step(
              actor,
              req.params.id,
              RefSchema.parse({ type: req.params.type, id: Number(req.params.resourceId) }),
              body.action,
              body.operation_key,
            );
          }
          const repository = new MySqlTemplateRepository(poolOf());
          if (action === 'inheritance') {
            const draft = await repository.getDraft(req.params.id);
            rule(draft, 'ROLLOUT_NOT_FOUND', 404);
            const inherited = await inheritTemplate(repository, req.params.id, draft!.aggregate);
            const current = await actorContextService.revalidateActor(actor);
            rule(
              hasPermission(new Set(current.permissions), 'metric:view'),
              'ROLLOUT_FORBIDDEN',
              403,
            );
            return {
              aggregate: inherited.aggregate,
              origins: inherited.origins,
              items: [...inherited.inherited.values()],
            };
          }
          const q = z
            .strictObject({
              from: z.coerce.number().int().positive(),
              to: z.coerce.number().int().positive(),
            })
            .parse(req.query);
          const before = await repository.getVersion(req.params.id, q.from),
            after = await repository.getVersion(req.params.id, q.to);
          rule(before && after, 'ROLLOUT_NOT_FOUND', 404);
          const changes = [];
          const ids = new Set([...before!.items, ...after!.items].map((i) => i.item_id));
          for (const id of ids) {
            const a = before!.items.find((i) => i.item_id === id),
              b = after!.items.find((i) => i.item_id === id);
            if (stable(a ?? null) !== stable(b ?? null))
              changes.push({
                item_id: id,
                kind: !a ? 'added' : !b ? 'deleted' : 'changed',
                before: a ?? null,
                after: b ?? null,
              });
          }
          const { mysqlTriggerCatalog } = await import('../triggers/persistence.js');
          const catalog = mysqlTriggerCatalog(poolOf() as any);
          const triggerBodies = async (refs: NonNullable<typeof before>['aggregate']['triggers']) =>
            Promise.all(
              refs.map(async (ref) => ({
                ref,
                body: await catalog.getVersion(ref.rule_id, ref.version),
              })),
            );
          const thresholds = {
            before: await triggerBodies(before!.aggregate.triggers),
            after: await triggerBodies(after!.aggregate.triggers),
          };
          const [bindings] = await poolOf().query<any[]>(
            'SELECT payload FROM metric_policy_bindings',
          );
          const affected = [];
          // Use the accepted codec; no identity is returned merely because it was in a stored JSON blob.
          const { decodeBindingPayload } = await import('../bindings/persistence-codec.js');
          for (const row of bindings) {
            const v = decodeBindingPayload(row.payload);
            if (
              v.binding.template_pins.some(
                (p) => p.template_id === req.params.id && p.version === q.from,
              )
            )
              affected.push({ resource: v.binding.resource, revision: v.binding.revision });
          }
          const current = await actorContextService.revalidateActor(actor);
          rule(
            hasPermission(new Set(current.permissions), 'metric:view'),
            'ROLLOUT_FORBIDDEN',
            403,
          );
          return {
            from: { version: q.from, hash: before!.content_hash },
            to: { version: q.to, hash: after!.content_hash },
            changes,
            parameters: {
              before: before!.aggregate.parameters,
              after: after!.aggregate.parameters,
            },
            triggers: thresholds,
            load: { before: before!.package_composition, after: after!.package_composition },
            affected: affected.filter((v) => canReadResource(current, v.resource)),
          };
        } catch (e) {
          if (e instanceof ActorAuthenticationError)
            return reply.code(401).send({ error: 'POLICY_AUTH_REQUIRED' });
          if (e instanceof z.ZodError) return reply.code(400).send({ error: 'ROLLOUT_INPUT' });
          if (e instanceof PolicyError || e instanceof TemplateError)
            return reply.code(e.status).send({ error: e.code });
          const mapped = templateBindingErrorStatus(e);
          if (mapped) return reply.code(mapped.status).send({ error: mapped.code });
          return reply.code(503).send({ error: 'ROLLOUT_STATE_UNKNOWN' });
        }
      },
    });
  }
}
