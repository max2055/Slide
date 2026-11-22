import type { Pool, RowDataPacket } from 'mysql2/promise';
import { actorContextService, type ActorContext } from '../../auth/actor-context.js';
import type { HashId } from '../../contracts/metrics/templates.js';
import { canManageResource, MysqlResourceRelationStore } from '../../resources/resource-service.js';
import { decodeBindingPayload, encodeTemplatePendingPayload } from '../bindings/persistence-codec.js';
import { buildTemplateCollectionPlan } from '../bindings/plan.js';
import { resolveTemplateBinding } from '../bindings/resolve.js';
import { configurationInventory } from '../config/inventory.js';
import { appendConfigurationHistory } from '../policy/configuration-history.js';
import { GroupChangeSchema, PolicyIdSchema, refKey, rule, type Group } from '../policy/model.js';
import { withPolicyAdmission } from '../policy/store.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { connectionTemplatePool } from './binding-service.js';
import { compileTriggerSnapshot } from '../triggers/compile.js';
import { mysqlTriggerCatalog, stageTriggerSnapshot } from '../triggers/persistence.js';
import { resolveTriggerRules } from '../triggers/resolve.js';
import { MySqlTemplateRepository } from './mysql-repository.js';

const registry = createConfigurationRegistry();
const assets = new MysqlResourceRelationStore();
const decode = (payload: string | unknown) => typeof payload === 'string' ? JSON.parse(payload) : payload;

export async function changeTemplateGroup(pool: Pool, actor: ActorContext, id: string, input: unknown, publish: boolean) {
  PolicyIdSchema.parse(id);
  const change = GroupChangeSchema.parse(input);
  return withPolicyAdmission(pool, async () => {
    const connection = await pool.getConnection();
    const executor = { execute: (sql: string, values?: unknown[]) => connection.execute(sql, values as never) };
    let reusable = false;
    try {
      await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction();
      try {
        const [lock] = await connection.execute<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
        rule(lock.length === 1, 'POLICY_STORE_UNAVAILABLE', 503);
        const [groups] = await connection.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_groups WHERE id = ?', [id]);
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT resource_key, payload, capabilities FROM metric_policy_bindings WHERE group_id = ? ORDER BY resource_key FOR UPDATE', [id]);
        const bindings = rows.map(row => {
          const binding = decodeBindingPayload(row.payload);
          rule(binding.kind === 'template_pending' && refKey(binding.binding.resource) === row.resource_key
            && binding.binding.group_id === id, 'POLICY_BINDING_INVALID', 409);
          return { binding, capabilities: decode(row.capabilities) };
        });
        const authorize = (actor: ActorContext) => {
          const allowed = bindings.length
            ? bindings.every(({ binding }) => canManageResource(actor, binding.binding.resource))
            : actor.permissions.includes('*');
          rule(allowed, 'POLICY_FORBIDDEN', 403);
        };
        const live = await actorContextService.revalidateActorOn(executor, actor, actor.requestId, true);
        authorize(live);
        const previous = groups[0] ? decode(groups[0].payload) as Group : null;
        rule((previous?.revision ?? 0) === change.expected_revision, 'POLICY_REVISION_CONFLICT', 409);
        const group = { id, revision: change.expected_revision + 1, policy_revision: change.expected_revision + 1, overrides: change.overrides };

        const repository = new MySqlTemplateRepository(connectionTemplatePool(connection));
        const updates = [];
        let before = 0, after = 0;
        for (const { binding: current, capabilities } of bindings) {
          const key = refKey(current.binding.resource);
          rule(await assets.existsOn(executor, current.binding.resource), 'POLICY_RESOURCE_NOT_FOUND', 404);
          if (current.binding.template_pins.length === 0) continue;
          const resource = await configurationInventory(current.binding.resource, connection);
          const at = new Date().toISOString();
          const resolved = await resolveTemplateBinding(current.binding, { resource, group, capabilities, at }, repository, registry);
          rule(resolved.kind === 'template_resolution', 'POLICY_BINDING_INVALID', 409);
          const plan = buildTemplateCollectionPlan(resolved, { discoverCapabilities: true });
          const revision = current.binding.revision + 1;
          const payload = encodeTemplatePendingPayload({
            binding: { ...current.binding, revision }, base_revision: revision - 1, target_revision: revision,
            plan, resolution_identity: plan.identity as HashId, operation_key: `group:${id}:${group.revision}`,
            decided_at: at, published_at: at, applied_revision: current.application.applied_revision,
            previous_resolution_identity: current.effective?.resolution_identity ?? null, previous_effective: current.effective,
          });
          const triggerSnapshot = resolved.triggers.some(entry => entry.refs.length)
            ? compileTriggerSnapshot({ ...await resolveTriggerRules(resolved, mysqlTriggerCatalog(connection), repository),
              config_revision: revision }) : null;
          updates.push({ key, payload, at, revision, triggerSnapshot });
          before += current.pending.plan.budget.requests_per_hour_estimate;
          after += plan.budget.requests_per_hour_estimate;
        }

        if (publish) {
          const audit = (target: string, revision: number, at: string) => connection.execute(
            'INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)', [target, JSON.stringify({
              actor_id: live.userId, request_id: live.requestId, action: 'group.publish', target, revision, at,
              configuration: { overrides: group.overrides, group },
            })]);
          await connection.execute(`INSERT INTO metric_policy_groups (id, payload) VALUES (?, ?)
            ON DUPLICATE KEY UPDATE payload = VALUES(payload)`, [id, JSON.stringify(group)]);
          await audit(`group:${id}`, group.revision, new Date().toISOString());
          for (const update of updates) {
            if (update.triggerSnapshot) await stageTriggerSnapshot(connection, update.triggerSnapshot);
            await connection.execute('UPDATE metric_policy_bindings SET payload = ? WHERE resource_key = ?', [update.payload, update.key]);
            await appendConfigurationHistory(connection, update.payload, 'publication', update.at);
            await audit(update.key, update.revision, update.at);
          }
        }
        await connection.commit();
        reusable = true;
        return { published: publish, group, affected_resources: updates.length,
          requests_per_hour_before: before, requests_per_hour_after: after };
      } catch (error) {
        await connection.rollback();
        reusable = true;
        throw error;
      }
    } finally {
      if (reusable) connection.release(); else connection.destroy();
    }
  });
}
