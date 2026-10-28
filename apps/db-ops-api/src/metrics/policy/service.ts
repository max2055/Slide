import type { ActorContext } from '../../auth/actor-context.js';
import { createHash } from 'node:crypto';
import { canManageResource, canReadResource, MysqlResourceRelationStore } from '../../resources/resource-service.js';
import { configurationInventory } from '../config/inventory.js';
import { type Resource } from '../../contracts/metrics/index.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { type PolicyStore, type PolicyTransaction, MysqlPolicyStore } from './store.js';
import { BindingChangeSchema, GroupChangeSchema, OperationKeySchema, PolicyIdSchema, RefSchema, PolicyError, type BindingChange, type Ref, type Group,
  type Binding, type Published, type PublicationResult, refKey, rule } from './model.js';
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
/**
 * The canonical client request one operation key recorded. Omitted fields stay
 * omitted: they are never filled from the current binding, group or inventory,
 * so a later intent can neither change nor be mistaken for this one.
 */
export function intentFingerprint(change: BindingChange): string {
  return `sha256:${createHash('sha256').update(stable({
    expected_revision: change.expected_revision,
    ...(change.package === undefined ? {} : { package: change.package }),
    ...(change.group_id === undefined ? {} : { group_id: change.group_id }),
    ...(change.overrides === undefined ? {} : { overrides: change.overrides }),
  })).digest('hex')}`;
}
export class PolicyService {
  constructor(private readonly store: PolicyStore, private readonly registry: PackageRegistry,
    private readonly resources: PolicyResources, private readonly clock = () => new Date().toISOString()) {}

  async assertAccess(actor: ActorContext, ref: Ref, write: boolean): Promise<void> {
    RefSchema.parse(ref);
    rule(write ? canManageResource(actor, ref) : canReadResource(actor, ref), 'POLICY_FORBIDDEN', 403);
    rule(await this.resources.exists(ref), 'POLICY_RESOURCE_NOT_FOUND', 404);
  }
  /**
   * Authorization at the serialization boundary. Admission, connection checkout
   * and the policy row lock can all wait; a grant revoked during that wait must
   * fail before anything is read, returned or published, and must never be
   * inferred from the actor snapshot the request arrived with. Callers that can
   * re-read the actor pass that check; nothing is re-checked without one.
   */
  private async live(actor: ActorContext, ref: Ref, write: boolean, check?: () => Promise<ActorContext>): Promise<ActorContext> {
    if (!check) return actor;
    const current = await check();
    await this.assertAccess(current, ref, write);
    return current;
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
  /** The recorded intent for this key, if any. Another resource, target revision or request is a collision. */
  private async recorded(tx: PolicyTransaction, ref: Ref, change: BindingChange) {
    if (change.operation_key === undefined) return null;
    const recorded = await tx.applyOperation(change.operation_key);
    if (!recorded) return null;
    rule(recorded.resource_key === refKey(ref), 'POLICY_OPERATION_CONFLICT', 409);
    rule(recorded.target_revision === change.expected_revision + 1, 'POLICY_OPERATION_CONFLICT', 409);
    rule(recorded.intent_digest === intentFingerprint(change), 'POLICY_OPERATION_CONFLICT', 409);
    return recorded;
  }
  /**
   * Reserve one keyed activate intent before any trial IO. Serialized with
   * publication, so a duplicate key either replays a committed result or learns
   * that this intent is still pending; neither starts a second trial.
   */
  async beginOperation(actor: ActorContext, ref: Ref, input: unknown,
    check?: () => Promise<ActorContext>): Promise<{ replayed: PublicationResult } | { claimed: true }> {
    await this.assertAccess(actor, ref, true);
    const change = BindingChangeSchema.parse(input);
    const operationKey = change.operation_key;
    rule(operationKey !== undefined, 'POLICY_OPERATION_KEY_REQUIRED', 400);
    const intent = intentFingerprint(change);
    return this.store.transaction(async tx => {
      // A duplicate may wait for the lock held by the request it duplicates;
      // its grants are re-read before it learns that request's outcome.
      const live = await this.live(actor, ref, true, check);
      const recorded = await tx.applyOperation(operationKey);
      if (recorded) {
        rule(recorded.resource_key === refKey(ref), 'POLICY_OPERATION_CONFLICT', 409);
        rule(recorded.target_revision === change.expected_revision + 1, 'POLICY_OPERATION_CONFLICT', 409);
        rule(recorded.intent_digest === intent, 'POLICY_OPERATION_CONFLICT', 409);
        // Pending covers both "another request is working this intent" and
        // "the process that claimed it stopped before confirming"; neither may
        // start a second trial or be reported as safely retryable.
        rule(recorded.state === 'committed' && recorded.result !== null, 'POLICY_OPERATION_PENDING', 409);
        return { replayed: recorded.result };
      }
      await tx.saveApplyOperation({ operation_key: operationKey, resource_key: refKey(ref), actor_id: live.userId,
        target_revision: change.expected_revision + 1, intent_digest: intent, configuration_digest: null,
        state: 'pending', claimed_at: this.clock(), result: null, committed_at: null });
      return { claimed: true as const };
    });
  }
  /**
   * Reconcile a failed keyed activate without guessing at remote work.
   * `before` is a failure that certainly did not reach the target (preview
   * validation, or a trial that returned its own decision): only this intent's
   * uncommitted claim is removed so the key may be retried. `trial` means the
   * target may have been read and the result is unknown: the claim stays pending
   * and no retry can start a second trial. `publish` reads the journal after the
   * failure: the journal and the binding commit together, so a committed row is
   * this intent's lost response and is returned for recovery, while a pending row
   * proves the publication rolled back and its claim may be cleared. Anything
   * unreadable stays pending. No caller route; internal.
   */
  async failedOperation(actor: ActorContext, ref: Ref, input: unknown,
    phase: 'before' | 'trial' | 'publish', check?: () => Promise<ActorContext>): Promise<PublicationResult | null> {
    const change = BindingChangeSchema.parse(input);
    if (change.operation_key === undefined) return null;
    const operationKey = change.operation_key, intent = intentFingerprint(change);
    if (phase === 'before') {
      await this.store.transaction(tx => tx.releaseApplyOperation(operationKey, refKey(ref), intent));
      return null;
    }
    return this.store.transaction(async tx => {
      await this.live(actor, ref, true, check);
      const recorded = await tx.applyOperation(operationKey);
      if (!recorded) return null;
      rule(recorded.resource_key === refKey(ref) && recorded.intent_digest === intent, 'POLICY_OPERATION_CONFLICT', 409);
      if (recorded.state === 'committed') { rule(recorded.result, 'POLICY_OPERATION_INVALID', 500); return recorded.result; }
      if (phase === 'publish') await tx.releaseApplyOperation(operationKey, refKey(ref), intent);
      return null;
    });
  }
  async changeBinding(actor: ActorContext, ref: Ref, input: unknown, publish: boolean, expectedCandidate?: string,
    finishClaim = false, check?: () => Promise<ActorContext>) {
    await this.assertAccess(actor, ref, true);
    const change = BindingChangeSchema.parse(input);
    return this.store.transaction(async tx => {
      // The lock wait can outlive the grants the request arrived with; re-read
      // them before reading or writing any protected state.
      const live = await this.live(actor, ref, true, check);
      // A client operation key binds one authorized resource, target revision and
      // canonical client request. It is checked inside the serialized policy
      // transaction, so concurrent duplicates and restarts both replay the
      // recorded publication instead of writing a second revision.
      const operationKey = publish ? change.operation_key : undefined;
      const recorded = operationKey === undefined ? null : await this.recorded(tx, ref, change);
      // A committed intent replays its recorded publication. Current configuration
      // is never its input, so a later intent cannot change what it recovers.
      if (recorded?.state === 'committed') { rule(recorded.result, 'POLICY_OPERATION_INVALID', 500); return recorded.result; }
      // A pending intent is an activate in flight or an unknown remote outcome.
      rule(recorded === null || finishClaim, 'POLICY_OPERATION_PENDING', 409);
      // Only the caller that reserved this key may complete the publication.
      rule(!finishClaim || recorded !== null, 'POLICY_OPERATION_CONFLICT', 409);
      const previous = await tx.binding(ref);
      rule((previous?.binding.revision ?? 0) === change.expected_revision, 'POLICY_REVISION_CONFLICT', 409);
      const { binding, group, groupId, next, at, changedPackage } = await this.candidate(tx, live, ref, change, previous);
      if (expectedCandidate !== undefined) rule(candidateFingerprint(next) === expectedCandidate, 'POLICY_REVISION_CONFLICT', 409);
      const result = { published: publish, resources: [next], affected_resources: 1,
        requests_per_hour_before: previous?.resolved.impact.requests_per_hour_estimate ?? 0,
        requests_per_hour_after: next.resolved.impact.requests_per_hour_estimate };
      if (publish) {
        await tx.saveBinding(next, changedPackage);
        await tx.audit({ actor_id: live.userId, request_id: live.requestId, action: 'binding.publish', target: refKey(ref), revision: binding.revision, at,
          configuration: { package: binding.package, group_id: groupId, overrides: binding.overrides, group } });
        // Membership revisions prevent preview→publish races even when no policy value changed.
        for (const id of new Set([previous?.binding.group_id, groupId].filter((id): id is string => Boolean(id)))) {
          const changed = (await tx.group(id))!;
          await tx.saveGroup({ ...changed, revision: changed.revision + 1 });
        }
        // The journal row is committed with the binding, revision and audit it
        // records: a promotion of this intent's own claim, never a second row.
        if (operationKey !== undefined) {
          await tx.saveApplyOperation({ operation_key: operationKey, resource_key: refKey(ref), actor_id: live.userId,
            target_revision: binding.revision, intent_digest: intentFingerprint(change),
            configuration_digest: configurationDigest(next), state: 'committed', claimed_at: recorded?.claimed_at ?? at,
            result: { ...result, published: true }, committed_at: at });
        }
      }
      return result;
    });
  }
  /**
   * The recorded publication for exactly this intent, or null when no key was
   * sent or nothing was recorded. The stored intent is compared as it was
   * recorded; a pending intent is not a publication. Callers must already hold
   * live authorization; nothing here is written.
   */
  async replay(actor: ActorContext, ref: Ref, input: unknown, check?: () => Promise<ActorContext>) {
    await this.assertAccess(actor, ref, true);
    const change = BindingChangeSchema.parse(input);
    if (change.operation_key === undefined) return null;
    return this.store.transaction(async tx => {
      await this.live(actor, ref, true, check);
      const recorded = await this.recorded(tx, ref, change);
      if (!recorded) return null;
      rule(recorded.state === 'committed' && recorded.result !== null, 'POLICY_OPERATION_PENDING', 409);
      return recorded.result;
    });
  }
  /**
   * Authoritative operation lookup under the same serialization as publication.
   * An absent key means no intent with that key was ever recorded, so a retry
   * cannot duplicate a publication. A pending key means its outcome is in flight
   * or unknown and must not be retried blindly. A key recorded for another
   * resource is not disclosed.
   */
  async operation(actor: ActorContext, ref: Ref, operationKey: string, check?: () => Promise<ActorContext>) {
    await this.assertAccess(actor, ref, false);
    OperationKeySchema.parse(operationKey);
    return this.store.transaction(async tx => {
      await this.live(actor, ref, false, check);
      const recorded = await tx.applyOperation(operationKey);
      if (!recorded || recorded.resource_key !== refKey(ref)) return { state: 'absent' as const, operation: null };
      if (recorded.state === 'pending') return { state: 'pending' as const, operation: { resource: ref,
        target_revision: recorded.target_revision, configuration_digest: null, committed_at: null } };
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
