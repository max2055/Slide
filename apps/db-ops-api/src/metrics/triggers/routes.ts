import { triggerProviderState } from './provider-state.js';
import { decodeBindingPayload } from '../bindings/persistence-codec.js';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { actorContextService, ActorAuthenticationError } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { hasPermission } from '../../auth/require-permission.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { templateBindingService } from '../templates/routes.js';
import { PolicyError, RefSchema, rule } from '../policy/model.js';
import { MySqlTemplateRepository } from '../templates/mysql-repository.js';
import { TriggerPublicationService } from './publication.js';
import { mysqlTriggerCatalog } from './persistence.js';
import { connectionTemplatePool, templateBindingErrorStatus } from '../templates/binding-service.js';
import { alertEventService } from '../../alert-event-service.js';
import { canManageResource, canReadResource } from '../../resources/resource-service.js';
import { verifyTriggerSnapshot } from './compile.js';
import type { TriggerResourceSnapshot } from '../../contracts/metrics/triggers.js';
import type { TriggerEpisodeRecord } from './episode.js';
import { readTriggerSourceAvailability, type TriggerSourceAvailability } from './source-availability.js';

const parsed = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const episodeResource = (episode: TriggerEpisodeRecord) =>
  RefSchema.parse({ type: episode.resource.type, id: Number(episode.resource.id) });
const alertPermission = (actor: ActorContext, permission: 'alert:view' | 'alert:manage') =>
  hasPermission(new Set(actor.permissions), permission);
export async function registerTemplateTriggerRoutes(
  app: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  poolProvider: () => Pool | null = () => dbConnection.getPool(),
  reload = (actor: ActorContext, c: any, locking = true) =>
    actorContextService.revalidateActorOn(c, actor, actor.requestId, locking),
) {
  const handle =
    (run: (req: any, pool: Pool, actor: ActorContext) => Promise<unknown>) =>
    async (req: any, reply: any) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!req.user) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      const pool = poolProvider();
      if (!pool) return reply.code(503).send({ error: 'TRIGGER_STORE_UNAVAILABLE' });
      try {
        return await run(req, pool, req.user);
      } catch (e) {
        if (e instanceof z.ZodError) return reply.code(400).send({ error: 'TRIGGER_INPUT_INVALID' });
        if (e instanceof ActorAuthenticationError) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
        if (e instanceof PolicyError) return reply.code(e.status).send({ error: e.code });
        const mapped = templateBindingErrorStatus(e);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.code });
        const code = (e as { code?: string }).code;
        if (code?.startsWith('TEMPLATE_') || code?.startsWith('TRIGGER_'))
          return reply.code(422).send({ error: code });
        return reply.code(503).send({ error: 'TRIGGER_OPERATION_UNAVAILABLE' });
      }
    };
  const template = (req: any) =>
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
      .parse(req.params.templateId);
  app.post(
    '/api/metrics/templates/:templateId/triggers',
    { preHandler: [verifyToken], bodyLimit: 65536 },
    handle(async (req, pool, actor) =>
      new TriggerPublicationService(pool, createConfigurationRegistry(), reload).publish(
        actor,
        template(req),
        req.body,
      ),
    ),
  );
  app.get(
    '/api/metrics/templates/:templateId/versions/:version/triggers',
    { preHandler: [verifyToken] },
    handle(async (req, pool, actor) => {
      const c = await pool.getConnection();
      try {
        const live = await reload(actor, c, false);
        rule(hasPermission(new Set(live.permissions), 'metric:view'), 'TRIGGER_FORBIDDEN', 403);
        const version = await new MySqlTemplateRepository(connectionTemplatePool(c)).getVersion(
          template(req),
          z.coerce.number().int().positive().parse(req.params.version),
        );
        rule(version, 'TEMPLATE_VERSION_NOT_FOUND', 404);
        const rules = await Promise.all(
          version.aggregate.triggers.map((ref) =>
            mysqlTriggerCatalog(c).getVersion(ref.rule_id, ref.version),
          ),
        );
        const final = await reload(actor, c, false);
        rule(hasPermission(new Set(final.permissions), 'metric:view'), 'TRIGGER_FORBIDDEN', 403);
        return { rules };
      } finally {
        c.release();
      }
    }),
  );

  for (const action of ['read', 'acknowledge', 'close'] as const)
    app.route({
      method: action === 'read' ? 'GET' : 'POST',
      url: `/api/metrics/template-events/:eventId${action === 'read' ? '' : `/${action}`}`,
      preHandler: [verifyToken],
      handler: handle(async (req, pool, actor) => {
        const eventId = z.coerce.number().int().positive().safe().parse(req.params.eventId);
        if (action === 'close') z.strictObject({}).parse(req.body === undefined ? {} : req.body);
        const c = await pool.getConnection();
        let reusable = false;
        try {
          await c.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await c.beginTransaction();
          if (action === 'close') {
            const before = await reload(actor, c, false);
            rule(alertPermission(before, 'alert:view') && alertPermission(before, 'alert:manage'), 'TRIGGER_FORBIDDEN', 403);
            const [identity] = await c.execute<RowDataPacket[]>(
              'SELECT identity_hash,payload FROM metric_trigger_episodes WHERE event_id=?', [eventId],
            );
            rule(identity.length === 1, 'TRIGGER_EVENT_NOT_FOUND', 404);
            const ref = episodeResource(parsed(identity[0].payload));
            rule(canReadResource(before, ref), 'TRIGGER_EVENT_NOT_FOUND', 404);
            await templateBindingService.assertAccess(before, ref, true, c);
            // The formal writer locks the head before the episode. Same order for manual closure.
            await c.execute('SELECT identity_hash FROM metric_trigger_heads WHERE identity_hash=? FOR UPDATE',
              [identity[0].identity_hash]);
          }
          const [rows] = await c.execute<RowDataPacket[]>(
            'SELECT * FROM metric_trigger_episodes WHERE event_id=? FOR UPDATE',
            [eventId],
          );
          rule(rows.length === 1, 'TRIGGER_EVENT_NOT_FOUND', 404);
          let episode: TriggerEpisodeRecord = parsed(rows[0].payload);
          const ref = episodeResource(episode);
          const check = async () => {
            const live = await reload(actor, c);
            rule(alertPermission(live, 'alert:view'), 'TRIGGER_FORBIDDEN', 403);
            if (action !== 'read')
              rule(alertPermission(live, 'alert:manage'), 'TRIGGER_FORBIDDEN', 403);
            await templateBindingService.assertAccess(live, ref, action !== 'read', c);
            return live;
          };
          const live = await check();
          const evidence: { configuration: TriggerResourceSnapshot; opening: { sample_ids?: unknown } } = parsed(rows[0].snapshot);
          const findOpeningRule = (configuration: TriggerResourceSnapshot) =>
            configuration.rules.find(rule =>
              rule.rule_id === episode.rule_id && rule.version === episode.version && rule.scope === episode.scope
                && rule.body_hash === episode.body_hash);
          const ruleAtOpening = findOpeningRule(evidence.configuration);
          if (action === 'close') {
            const verified = verifyTriggerSnapshot(evidence.configuration);
            const frozen = findOpeningRule(verified);
            rule(frozen?.allow_manual_close === true, 'TRIGGER_MANUAL_CLOSE_DISABLED', 403);
            episode = await alertEventService.closeTemplateEpisode(c, episode, live);
          }
          const [processing] = await c.execute<RowDataPacket[]>(
            'SELECT status,acknowledged_at FROM alerts WHERE id=? FOR UPDATE',
            [rows[0].alert_id],
          );
          if (action === 'acknowledge' && !processing[0]?.acknowledged_at) {
            // No episode/event state mutation and no job admission.
            await c.execute(
              "UPDATE alerts SET status=IF(status IN ('unread','read'),'acknowledged',status), acknowledged_by=?,acknowledged_at=COALESCE(acknowledged_at,NOW()) WHERE id=?",
              [actor.userId || null, rows[0].alert_id],
            );
            await c.execute(
              "INSERT INTO alert_event_logs(event_id,action,actor_id,details) VALUES(?,'note_added',?,?)",
              [
                eventId,
                actor.userId || null,
                JSON.stringify({ action: 'trigger_acknowledged', request_id: actor.requestId }),
              ],
            );
          }
          const [binding] = await c.execute<RowDataPacket[]>(
            'SELECT payload FROM metric_policy_bindings WHERE resource_key=?',
            [rows[0].resource_key],
          );
          const decoded = binding[0] ? decodeBindingPayload(binding[0].payload) : null;
          const current = decoded?.binding ?? null;
          const states = [episode.opened.metric, ...(ruleAtOpening?.inputs ?? []).map((input: { metric: typeof episode.opened.metric }) => input.metric)]
            .map(metric => triggerProviderState(decoded?.kind === 'template_pending' ? decoded : null, metric, episode.last.dimensions ?? {}));
          const evaluation = states.find(state => state.state === 'active') ?? states.find(state => state.state === 'pending') ?? states[0];
          const [deliveries] = await c.execute<RowDataPacket[]>(
            `SELECT j.id AS job_id,j.state AS job_state,
          JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.channelId')) AS channel_id,
          d.state,d.error_code,d.attempt_id,d.updated_at
          FROM workflow_jobs j LEFT JOIN notification_delivery_states d ON d.workflow_job_id=j.id
          WHERE j.job_type='notification.deliver' AND JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.alertId'))=?`,
            [String(rows[0].alert_id)],
          );
          const [receipts] = await c.execute<RowDataPacket[]>(
            'SELECT id,channel_id,status,sent_at FROM notification_records WHERE alert_id=? ORDER BY id',
            [rows[0].alert_id],
          );
          const [alerts] = await c.execute<RowDataPacket[]>(
            'SELECT status,acknowledged_at FROM alerts WHERE id=?',
            [rows[0].alert_id],
          );
          const sourceAvailability: { opening: TriggerSourceAvailability; recovery?: TriggerSourceAvailability } = {
            opening: await readTriggerSourceAvailability(c, ref, evidence.opening?.sample_ids).catch(() => 'unknown' as const),
          };
          if (episode.state === 'closed' && !episode.manual_close && episode.recovery_count === 1) {
            sourceAvailability.recovery = await (async () => {
              const [recovery] = await c.execute<RowDataPacket[]>(`
                SELECT JSON_EXTRACT(details, '$.sample_ids') AS sample_ids
                FROM alert_event_logs WHERE event_id=? AND action='resolved'
                  AND details->>'$.action'='trigger_recovered' AND details->>'$.episode_id'=?
                ORDER BY id DESC LIMIT 1
              `, [eventId, episode.episode_id]);
              return readTriggerSourceAvailability(c, ref, parsed(recovery[0]?.sample_ids));
            })().catch(() => 'unknown' as const);
          }
          const final = await check();
          await c.commit();
          reusable = true;
          return {
            event_id: eventId,
            alert_id: Number(rows[0].alert_id),
            episode,
            snapshot: evidence,
            source_availability: sourceAvailability,
            current,
            evaluation,
            processing: alerts[0],
            can_manual_close: episode.state === 'open' && ruleAtOpening?.allow_manual_close === true
              && alertPermission(final, 'alert:manage') && canManageResource(final, ref),
            deliveries,
            receipts,
          };
        } catch (e) {
          try {
            await c.rollback();
            reusable = true;
          } catch {
            /*discard*/
          }
          throw e;
        } finally {
          if (reusable) c.release();
          else c.destroy();
        }
      }),
    });
}
