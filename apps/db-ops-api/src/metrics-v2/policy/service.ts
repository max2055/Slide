import type { ActorContext } from '../../auth/actor-context.js';
import { canManageResource, canReadResource, MysqlResourceRelationStore } from '../../resources/resource-service.js';
import { dbConnection } from '../../db-connection.js';
import { type Resource } from '../../contracts/metrics-v2/index.js';
import { MysqlMetricStorage } from '../storage.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { type PolicyStore, type PolicyTransaction, MysqlPolicyStore } from './store.js';
import { BindingChangeSchema, GroupChangeSchema, PolicyIdSchema, RefSchema, type Ref, type Group,
  type Binding, type Published, refKey, rule } from './model.js';
import { resolvePolicy } from './resolver.js';

export interface PolicyResources { exists(ref: Ref): Promise<boolean>; inventory(ref: Ref): Promise<Resource | null> }
export class PolicyService {
  constructor(private readonly store: PolicyStore, private readonly registry: PackageRegistry,
    private readonly resources: PolicyResources, private readonly clock = () => new Date().toISOString()) {}

  private async authorize(actor: ActorContext, ref: Ref, write: boolean): Promise<void> {
    RefSchema.parse(ref);
    rule(write ? canManageResource(actor, ref) : canReadResource(actor, ref), 'POLICY_FORBIDDEN', 403);
    rule(await this.resources.exists(ref), 'POLICY_RESOURCE_NOT_FOUND', 404);
  }
  private async groupAccess(actor: ActorContext, tx: PolicyTransaction, id: string, write: boolean): Promise<Published[]> {
    const members = await tx.members(id);
    if (!members.length) rule(actor.permissions.includes('*'), 'POLICY_FORBIDDEN', 403);
    for (const member of members) await this.authorize(actor, member.binding.resource, write);
    return members;
  }
  private async resolve(tx: PolicyTransaction, binding: Binding, group: Group | null, previous: Published | null, at: string): Promise<Published> {
    const changedPackage = !previous || stable(previous.binding.package) !== stable(binding.package);
    const resource = await this.resources.inventory(binding.resource) ?? { type: binding.resource.type, id: String(binding.resource.id), attributes: {} };
    const resolved = resolvePolicy(this.registry, binding, group, resource, changedPackage ? [] : await tx.capabilities(binding.resource), at);
    return { binding, resolved, published_at: at, application: {
      applied_revision: previous?.application.applied_revision ?? null, reported_at: previous?.application.reported_at ?? null, status: 'pending', error_code: null,
    } };
  }
  async binding(actor: ActorContext, ref: Ref): Promise<Published> {
    await this.authorize(actor, ref, false);
    return this.store.transaction(async tx => { const result = await tx.binding(ref); rule(result, 'POLICY_NOT_FOUND', 404); return result; });
  }
  async audits(actor: ActorContext, ref: Ref) {
    await this.authorize(actor, ref, true);
    return this.store.transaction(tx => tx.audits(refKey(ref)));
  }
  async effective(actor: ActorContext, ref: Ref) {
    await this.authorize(actor, ref, false);
    return this.store.transaction(async tx => {
      const published = await tx.binding(ref); rule(published, 'POLICY_NOT_FOUND', 404);
      const resource = await this.resources.inventory(ref) ?? { type: ref.type, id: String(ref.id), attributes: {} };
      // Re-evaluate evidence at query time without changing the published policy or application acknowledgement.
      const snapshot = published.resolved;
      const groupId = published.binding.group_id;
      const group = groupId ? await tx.group(groupId) : null;
      const resolved = resolvePolicy(this.registry, published.binding, group, resource, await tx.capabilities(ref), this.clock());
      return { published_revision: published.binding.revision, published_at: published.published_at,
        published_policy_revision: snapshot.plan.binding.policy_revision, application: published.application, resolved };
    });
  }
  async group(actor: ActorContext, id: string) {
    PolicyIdSchema.parse(id);
    return this.store.transaction(async tx => {
      await this.groupAccess(actor, tx, id, false);
      const group = await tx.group(id); rule(group, 'POLICY_NOT_FOUND', 404);
      return group;
    });
  }
  async changeBinding(actor: ActorContext, ref: Ref, input: unknown, publish: boolean) {
    await this.authorize(actor, ref, true);
    const change = BindingChangeSchema.parse(input);
    return this.store.transaction(async tx => {
      const previous = await tx.binding(ref);
      rule((previous?.binding.revision ?? 0) === change.expected_revision, 'POLICY_REVISION_CONFLICT', 409);
      const pin = change.package ?? previous?.binding.package; rule(pin, 'POLICY_PACKAGE_REQUIRED');
      if (previous) rule(pin.id === previous.binding.package.id, 'POLICY_PACKAGE_SWITCH_ID');
      const groupId = change.group_id === undefined ? previous?.binding.group_id ?? null : change.group_id;
      const group = groupId ? await tx.group(groupId) : null;
      rule(!groupId || group, 'POLICY_GROUP_NOT_FOUND', 404);
      // Joining/leaving a group also changes the group's impact set: require management of its current members.
      for (const id of new Set([previous?.binding.group_id, groupId].filter((id): id is string => Boolean(id)))) {
        if (id !== previous?.binding.group_id || id !== groupId) await this.groupAccess(actor, tx, id, true);
      }
      const binding: Binding = { resource: ref, package: pin, group_id: groupId,
        overrides: change.overrides ?? previous?.binding.overrides ?? {}, revision: change.expected_revision + 1 };
      const at = this.clock(), next = await this.resolve(tx, binding, group, previous, at);
      const result = { published: publish, resources: [next], affected_resources: 1,
        requests_per_hour_before: previous?.resolved.impact.requests_per_hour_estimate ?? 0,
        requests_per_hour_after: next.resolved.impact.requests_per_hour_estimate };
      if (publish) {
        await tx.saveBinding(next, !previous || stable(previous.binding.package) !== stable(pin));
        await tx.audit({ actor_id: actor.userId, request_id: actor.requestId, action: 'binding.publish', target: refKey(ref), revision: binding.revision, at,
          configuration: { package: pin, group_id: groupId, overrides: binding.overrides, group } });
        // Membership revisions prevent preview→publish races even when no policy value changed.
        for (const id of new Set([previous?.binding.group_id, groupId].filter((id): id is string => Boolean(id)))) {
          const changed = (await tx.group(id))!;
          await tx.saveGroup({ ...changed, revision: changed.revision + 1 });
        }
      }
      return result;
    });
  }
  async changeGroup(actor: ActorContext, id: string, input: unknown, publish: boolean) {
    PolicyIdSchema.parse(id);
    const change = GroupChangeSchema.parse(input);
    return this.store.transaction(async tx => {
      const members = await this.groupAccess(actor, tx, id, true);
      const previous = await tx.group(id);
      rule((previous?.revision ?? 0) === change.expected_revision, 'POLICY_REVISION_CONFLICT', 409);
      const group = { id, revision: change.expected_revision + 1, policy_revision: change.expected_revision + 1, overrides: change.overrides };
      const at = this.clock(), next: Published[] = [];
      for (const member of members) next.push(await this.resolve(tx, { ...member.binding, revision: member.binding.revision + 1 }, group, member, at));
      if (publish) {
        await tx.saveGroup(group);
        await tx.audit({ actor_id: actor.userId, request_id: actor.requestId, action: 'group.publish', target: `group:${id}`, revision: group.revision, at,
          configuration: { overrides: group.overrides, group } });
        for (const resource of next) {
          await tx.saveBinding(resource, false);
          await tx.audit({ actor_id: actor.userId, request_id: actor.requestId, action: 'group.publish', target: refKey(resource.binding.resource), revision: resource.binding.revision, at,
            configuration: { package: resource.binding.package, group_id: id, overrides: resource.binding.overrides, group } });
        }
      }
      return { published: publish, group, resources: next, affected_resources: next.length,
        requests_per_hour_before: members.reduce((n, m) => n + m.resolved.impact.requests_per_hour_estimate, 0),
        requests_per_hour_after: next.reduce((n, m) => n + m.resolved.impact.requests_per_hour_estimate, 0) };
    });
  }
}

const resourceStore = new MysqlResourceRelationStore();
export const policyService = new PolicyService(new MysqlPolicyStore(), createBuiltinRegistry(), {
  exists: ref => resourceStore.exists(ref),
  inventory: async ref => {
    const pool = dbConnection.getPool(); rule(pool, 'POLICY_STORE_UNAVAILABLE', 503);
    return new MysqlMetricStorage(pool).inventory(ref.type, String(ref.id));
  },
});
