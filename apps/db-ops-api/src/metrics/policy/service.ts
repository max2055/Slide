import type { ActorContext } from '../../auth/actor-context.js';
import { createHash } from 'node:crypto';
import { canManageResource, canReadResource, MysqlResourceRelationStore } from '../../resources/resource-service.js';
import { configurationInventory } from '../config/inventory.js';
import { type Resource } from '../../contracts/metrics/index.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { type PolicyStore, type PolicyTransaction, MysqlPolicyStore } from './store.js';
import { BindingChangeSchema, GroupChangeSchema, OperationKeySchema, PolicyIdSchema, RefSchema, PolicyError, type BindingChange, type Ref, type Group,
  type Binding, type Published, refKey, rule } from './model.js';
import { resolvePolicy } from './resolver.js';

export interface PolicyResources { exists(ref: Ref): Promise<boolean>; inventory(ref: Ref): Promise<Resource | null> }
/** Stable execution inputs only; timestamps and expiring capability evidence are deliberately excluded. */
export function candidateFingerprint(next: Published): string {
  return stable({binding:next.binding,settings:next.resolved.settings,sources:next.resolved.sources,metric_sources:next.resolved.metric_sources,
    applicability:next.resolved.applicability,policy_revision:next.resolved.plan.binding.policy_revision,
    metrics:next.resolved.metric_templates.map(t=>({metric:t.metric,source:t.source,enabled:t.enabled}))});
}
/** The canonical configuration digest an operation key binds to its target revision. */
export function configurationDigest(next: Published): string {
  return `sha256:${createHash('sha256').update(candidateFingerprint(next)).digest('hex')}`;
}
export class PolicyService {
  constructor(private readonly store: PolicyStore, private readonly registry: PackageRegistry,
    private readonly resources: PolicyResources, private readonly clock = () => new Date().toISOString()) {}

  async assertAccess(actor: ActorContext, ref: Ref, write: boolean): Promise<void> {
    RefSchema.parse(ref);
    rule(write ? canManageResource(actor, ref) : canReadResource(actor, ref), 'POLICY_FORBIDDEN', 403);
    rule(await this.resources.exists(ref), 'POLICY_RESOURCE_NOT_FOUND', 404);
  }
  private async groupAccess(actor: ActorContext, tx: PolicyTransaction, id: string, write: boolean): Promise<Published[]> {
    const members = await tx.members(id);
    if (!members.length) rule(actor.permissions.includes('*'), 'POLICY_FORBIDDEN', 403);
    for (const member of members) await this.assertAccess(actor, member.binding.resource, write);
    return members;
  }
  private async resolve(tx: PolicyTransaction, binding: Binding, group: Group | null, previous: Published | null, at: string): Promise<Published> {
    const changedPackage = !previous || stable(previous.binding.package) !== stable(binding.package);
    const resource = await this.resources.inventory(binding.resource) ?? { type: binding.resource.type, id: String(binding.resource.id), attributes: {} };
    // Inventory may be stamped during the asynchronous read. Evaluate after it,
    // retaining the operation timestamp for publication and its atomic audit.
    const resolved = resolvePolicy(this.registry, binding, group, resource, changedPackage ? [] : await tx.capabilities(binding.resource), this.clock());
    return { binding, resolved, published_at: at, application: {
      applied_revision: previous?.application.applied_revision ?? null, reported_at: previous?.application.reported_at ?? null, status: 'pending', error_code: null,
    } };
  }
  async binding(actor: ActorContext, ref: Ref): Promise<Published> {
    await this.assertAccess(actor, ref, false);
    return this.store.transaction(async tx => { const result = await tx.binding(ref); rule(result, 'POLICY_NOT_FOUND', 404); return result; });
  }
  async audits(actor: ActorContext, ref: Ref, requestId?: string) {
    await this.assertAccess(actor, ref, true);
    return this.store.transaction(tx => tx.audits(refKey(ref), requestId));
  }
  async effective(actor: ActorContext, ref: Ref) {
    await this.assertAccess(actor, ref, false);
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
  async groups(actor: ActorContext, query = '') {
    rule(query.length <= 128, 'POLICY_INPUT_INVALID');
    return this.store.transaction(async tx => {
      const visible: Array<Group & {can_manage: boolean}> = [];
      for (const group of await tx.groups()) {
        if (!group.id.toLowerCase().includes(query.toLowerCase())) continue;
        try {
          const members = await this.groupAccess(actor, tx, group.id, false);
          visible.push({ ...group, can_manage: members.length ? members.every(m => canManageResource(actor, m.binding.resource)) : actor.permissions.includes('*') });
        } catch(e) { if (!(e instanceof PolicyError && e.status === 403)) throw e; }
        if (visible.length === 100) break;
      }
      return { groups: visible };
    });
  }
  async groupPermissions(actor: ActorContext, id: string) {
    PolicyIdSchema.parse(id);
    return this.store.transaction(async tx => {
      const members = await this.groupAccess(actor, tx, id, false);
      return { can_manage: members.length ? members.every(member => canManageResource(actor, member.binding.resource)) : actor.permissions.includes('*') };
    });
  }
  /** Resolve the intended publication from the request. No write, no revision CAS. */
  private async candidate(tx: PolicyTransaction, actor: ActorContext, ref: Ref, change: BindingChange, previous: Published | null) {
    const pin = change.package ?? previous?.binding.package; rule(pin, 'POLICY_PACKAGE_REQUIRED');
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
    // A package is an immutable execution input, not the resource identity. Resolve
    // inherited overrides against the target (unknown metrics fail explicitly),
    // and reject known incompatible replacements on preview AND direct publish.
    if (previous && stable(previous.binding.package) !== stable(pin)) {
      rule(!next.resolved.applicability.some(c => c.status === 'unsupported'), 'PACKAGE_INCOMPATIBLE', 422);
    }
    return { binding, group, groupId, next, at, changedPackage: !previous || stable(previous.binding.package) !== stable(pin) };
  }
  /** The recorded intent for this key, if any. Another resource or target revision is a collision. */
  private async recorded(tx: PolicyTransaction, ref: Ref, change: BindingChange) {
    if (change.operation_key === undefined) return null;
    const recorded = await tx.applyOperation(change.operation_key);
    if (!recorded) return null;
    rule(recorded.resource_key === refKey(ref), 'POLICY_OPERATION_CONFLICT', 409);
    rule(recorded.target_revision === change.expected_revision + 1, 'POLICY_OPERATION_CONFLICT', 409);
    return recorded;
  }
  async changeBinding(actor: ActorContext, ref: Ref, input: unknown, publish: boolean, expectedCandidate?: string) {
    await this.assertAccess(actor, ref, true);
    const change = BindingChangeSchema.parse(input);
    return this.store.transaction(async tx => {
      // A client operation key binds one authorized resource, target revision and
      // canonical configuration digest. It is checked inside the serialized
      // policy transaction, so concurrent duplicates and restarts both replay
      // the recorded publication instead of writing a second revision.
      const operationKey = publish ? change.operation_key : undefined;
      const recorded = operationKey === undefined ? null : await this.recorded(tx, ref, change);
      const previous = await tx.binding(ref);
      // A replay is not evaluated against the revision it already published.
      rule(recorded !== null || (previous?.binding.revision ?? 0) === change.expected_revision, 'POLICY_REVISION_CONFLICT', 409);
      const { binding, group, groupId, next, at, changedPackage } = await this.candidate(tx, actor, ref, change, previous);
      if (recorded) {
        // Reusing a key for another resource, revision or configuration is a collision.
        rule(configurationDigest(next) === recorded.configuration_digest, 'POLICY_OPERATION_CONFLICT', 409);
        return recorded.result;
      }
      if (expectedCandidate !== undefined) rule(candidateFingerprint(next) === expectedCandidate, 'POLICY_REVISION_CONFLICT', 409);
      const result = { published: publish, resources: [next], affected_resources: 1,
        requests_per_hour_before: previous?.resolved.impact.requests_per_hour_estimate ?? 0,
        requests_per_hour_after: next.resolved.impact.requests_per_hour_estimate };
      if (publish) {
        await tx.saveBinding(next, changedPackage);
        await tx.audit({ actor_id: actor.userId, request_id: actor.requestId, action: 'binding.publish', target: refKey(ref), revision: binding.revision, at,
          configuration: { package: binding.package, group_id: groupId, overrides: binding.overrides, group } });
        // Membership revisions prevent preview→publish races even when no policy value changed.
        for (const id of new Set([previous?.binding.group_id, groupId].filter((id): id is string => Boolean(id)))) {
          const changed = (await tx.group(id))!;
          await tx.saveGroup({ ...changed, revision: changed.revision + 1 });
        }
        // The journal row is committed with the binding, revision and audit it records.
        if (operationKey !== undefined) {
          await tx.saveApplyOperation({ operation_key: operationKey, resource_key: refKey(ref), actor_id: actor.userId,
            target_revision: binding.revision, configuration_digest: configurationDigest(next), result: { ...result, published: true }, committed_at: at });
        }
      }
      return result;
    });
  }
  /**
   * The recorded publication for exactly this intent, or null when no key was
   * sent or nothing was recorded. The digest is recomputed from the same request,
   * so a key reused for a different configuration is a collision. Callers must
   * already hold live authorization; nothing here is written.
   */
  async replay(actor: ActorContext, ref: Ref, input: unknown) {
    await this.assertAccess(actor, ref, true);
    const change = BindingChangeSchema.parse(input);
    if (change.operation_key === undefined) return null;
    return this.store.transaction(async tx => {
      const recorded = await this.recorded(tx, ref, change);
      if (!recorded) return null;
      const { next } = await this.candidate(tx, actor, ref, change, await tx.binding(ref));
      rule(configurationDigest(next) === recorded.configuration_digest, 'POLICY_OPERATION_CONFLICT', 409);
      return recorded.result;
    });
  }
  /**
   * Authoritative operation lookup. It runs under the same policy lock as a
   * publication, so an absent key means no publication with that key is in
   * flight; a retry is safe. A key recorded for another resource is not disclosed.
   */
  async operation(actor: ActorContext, ref: Ref, operationKey: string) {
    await this.assertAccess(actor, ref, false);
    OperationKeySchema.parse(operationKey);
    return this.store.transaction(async tx => {
      const recorded = await tx.applyOperation(operationKey);
      if (!recorded || recorded.resource_key !== refKey(ref)) return { state: 'absent' as const, operation: null };
      return { state: 'committed' as const, operation: { resource: ref, target_revision: recorded.target_revision,
        configuration_digest: recorded.configuration_digest, committed_at: recorded.committed_at } };
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
export const policyService = new PolicyService(new MysqlPolicyStore(), createConfigurationRegistry(), {
  exists: ref => resourceStore.exists(ref),
  inventory: configurationInventory,
});
