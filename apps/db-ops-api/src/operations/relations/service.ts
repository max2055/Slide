import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { freezeInvestigationCaller } from '../../investigations/authorization.js';
import { hasValidTopology } from '../../resources/resource-service.js';
import { projectResourceRelation, resourceKey, type ResourceRef } from '../../resources/types.js';
import { OperationsAuthorization } from '../authorization.js';
import { OperationsError, resourceRefSchema, versionReferenceSchema } from '../contracts.js';
import { assertOperationsEnabled, operationsFlags, type OperationsFlags } from '../feature-flags.js';
import { MysqlRelationStore, newRelationId, relationHash, type RelationSession, type RelationStore, type StoredRelation } from './store.js';

const date = z.iso.datetime({ precision: 3 });
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const idSchema = z.string().regex(/^[1-9]\d{0,15}$/).refine(id => Number.isSafeInteger(Number(id)));
const contentSchema = z.strictObject({ evidence: z.array(versionReferenceSchema).max(100),
  observedAt: date, validFrom: date, validUntil: date.nullable(), origin: z.enum(['manual', 'collector', 'model']) });
const createSchema = contentSchema.extend({ source: resourceRefSchema, target: resourceRefSchema,
  relationType: z.enum(['runs_on', 'replicates_to', 'depends_on', 'connected_to', 'serves']) });
const reviseSchema = contentSchema.extend({ expectedVersion: version });
const transitionSchema = z.strictObject({ expectedVersion: version, action: z.enum(['confirm', 'withdraw']),
  reason: z.string().trim().min(1).max(1000).optional() });
export type RelationInput = z.infer<typeof createSchema>;
/** P10 supplies an authoritative evidence resolver. It must validate the exact
 * version/hash, source state, time and resource scope using current locking
 * reads on the same connection. It must not echo source errors or metadata.
 * Client-supplied evidence references alone never establish a fact. */
export interface RelationEvidence {
  check(session: RelationSession, actor: ActorContext, relation: StoredRelation, now: Date): Promise<'valid' | 'withdrawn' | 'unavailable'>;
}
export type RelationProjection = ReturnType<typeof projection>;
function projection(value: StoredRelation, from: ResourceRef) {
  const relation = projectResourceRelation({ source: value.source, target: value.target, relationType: value.relationType,
    provenance: value.legacyProvenance ?? value.origin, validFrom: new Date(value.validFrom),
    validUntil: value.validUntil ? new Date(value.validUntil) : null }, from);
  return { ...relation, relationId: value.relationId, version: value.version, contentHash: value.contentHash,
    state: value.state, verification: value.version === 0 ? 'unverified' as const : value.state,
    // Source evidence may have stricter access than the endpoints. References
    // stay on the protected revision endpoint, not on topology projections.
  };
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  return parsed.data;
}
function inWindow(value: StoredRelation, now: Date): boolean {
  return Date.parse(value.validFrom) <= +now && (!value.validUntil || Date.parse(value.validUntil) > +now);
}
function overlaps(a: StoredRelation, b: StoredRelation): boolean {
  return resourceKey(a.source) === resourceKey(b.source) && resourceKey(a.target) === resourceKey(b.target)
    && a.relationType === b.relationType && Date.parse(a.validFrom) < (b.validUntil ? Date.parse(b.validUntil) : Infinity)
    && Date.parse(b.validFrom) < (a.validUntil ? Date.parse(a.validUntil) : Infinity);
}
const refs = (value: StoredRelation) => [value.source, value.target];

export class RelationService {
  constructor(private readonly store: RelationStore = new MysqlRelationStore(),
    private readonly authorization: OperationsAuthorization = new OperationsAuthorization(),
    private readonly evidence: RelationEvidence = { check: async () => 'unavailable' },
    private readonly flags: () => Readonly<OperationsFlags> = operationsFlags,
    private readonly clock: () => Date = () => new Date()) {}

  async suggest(caller: ActorContext, input: unknown): Promise<StoredRelation> {
    assertOperationsEnabled(this.flags(), 'context');
    const actor = freezeInvestigationCaller(caller), body = parse(createSchema, input), now = this.clock();
    this.validateContent(body, now);
    if (!hasValidTopology(body) || resourceKey(body.source) === resourceKey(body.target)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    return this.store.transaction(async session => {
      await session.lockResources([body.source, body.target]);
      await this.authorize(session, actor, [body.source, body.target], true);
      const id = newRelationId();
      const value: StoredRelation = { ...body, validUntil: body.validUntil ?? null, id, relationId: id, version: 1, schemaVersion: 1, contentHash: '',
        state: 'suggested', author: { kind: actor.principalKind ?? 'user', id: actor.userId }, legacyProvenance: null,
        confirmedBy: null, confirmedAt: null, withdrawalReason: null };
      await this.append(session, value);
      return value;
    });
  }

  async revise(caller: ActorContext, id: string, input: unknown): Promise<StoredRelation> {
    assertOperationsEnabled(this.flags(), 'context');
    const body = parse(reviseSchema, input), actor = freezeInvestigationCaller(caller), now = this.clock();
    this.validateContent(body, now);
    return this.store.transaction(async session => {
      const current = await this.writable(session, actor, id, body.expectedVersion);
      // Endpoints and direction are immutable. Changing content always removes confirmation.
      const { expectedVersion: _expected, ...content } = body;
      const next = { ...current, ...content, version: current.version + 1, state: 'suggested' as const,
        author: { kind: actor.principalKind ?? 'user', id: actor.userId }, confirmedBy: null, confirmedAt: null, withdrawalReason: null };
      await this.append(session, next);
      return next;
    });
  }

  async transition(caller: ActorContext, id: string, input: unknown): Promise<StoredRelation> {
    const body = parse(transitionSchema, input), actor = freezeInvestigationCaller(caller), now = this.clock();
    // Retraction/audit remains available when new work is stopped.
    if (body.action === 'confirm') assertOperationsEnabled(this.flags(), 'context');
    return this.store.transaction(async session => {
      const current = await this.writable(session, actor, id, body.expectedVersion);
      const next: StoredRelation = { ...current, version: current.version + 1 };
      if (body.action === 'withdraw') {
        if (!body.reason) throw new OperationsError('OPERATIONS_INPUT_INVALID');
        next.state = 'withdrawn'; next.withdrawalReason = body.reason;
      } else {
        if (actor.principalKind === 'service') throw new OperationsError('OPERATIONS_FORBIDDEN');
        if (current.state !== 'suggested' || !current.evidence.length || !inWindow(current, now)
          || current.evidence.some(item => Date.parse(item.validUntil) <= +now)) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        const evidence = await this.evidence.check(session, actor, current, now);
        if (evidence === 'unavailable') throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
        if (evidence !== 'valid') throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        if (!await session.legacyActive(current, now)) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        const candidates = await session.adjacent(current.source, 101);
        if (candidates.length > 100) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        const conflicts = candidates.filter(value => value.relationId !== id && value.state === 'confirmed' && overlaps(current, value));
        next.state = conflicts.length ? 'conflicted' : 'confirmed';
        next.confirmedBy = actor.userId; next.confirmedAt = now.toISOString();
        // Invalidate both exact heads; no stale confirmed edge can continue scoring.
        for (const conflict of conflicts) await this.append(session, { ...conflict, version: conflict.version + 1,
          state: 'conflicted', withdrawalReason: 'overlapping_confirmation' });
      }
      await this.authorize(session, actor, refs(next), true);
      await this.append(session, next);
      return next;
    });
  }

  async history(caller: ActorContext, id: string, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    parse(idSchema, id);
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const actor = freezeInvestigationCaller(caller);
    return this.store.transaction(async session => {
      const current = await session.head(id);
      if (!current) throw new OperationsError('OPERATIONS_NOT_FOUND');
      await this.authorize(session, actor, refs(current));
      const values = current.version ? await session.history(id, before, limit + 1) : (before > 0 ? [current] : []);
      // Evidence and author details have independent source ACLs. Never return
      // them merely because both topology endpoints are readable.
      return { revisions: values.slice(0, limit).map(value => ({ ...projection(value, value.source),
        observedAt: value.observedAt, confirmedBy: value.confirmedBy, confirmedAt: value.confirmedAt,
        withdrawalReason: value.withdrawalReason })), partial: values.length > limit };
    });
  }

  async graph(caller: ActorContext, input: unknown, options: { hops?: number; maxEdges?: number; factsOnly?: boolean } = {}) {
    const root = parse(resourceRefSchema, input), actor = freezeInvestigationCaller(caller), now = this.clock();
    const { hops = 2, maxEdges = 100, factsOnly = true } = parse(z.strictObject({ hops: z.number().int().min(1).max(2).optional(),
      maxEdges: z.number().int().min(1).max(100).optional(), factsOnly: z.boolean().optional() }), options);
    return this.store.transaction(async session => {
      await this.authorize(session, actor, [root]);
      let partial = false, scanned = 0;
      const seenNodes = new Set([resourceKey(root)]), seenEdges = new Set<string>();
      const edges: RelationProjection[] = [], queue = [{ ref: root, depth: 0, parentEdge: '' }];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const { ref, depth, parentEdge } = queue[cursor];
        const candidates = await session.adjacent(ref, maxEdges - scanned + 1);
        for (const value of candidates) {
          if (value.relationId === parentEdge) continue; // incoming edge is not a cycle
          if (seenEdges.has(value.relationId)) { partial = true; continue; }
          if (scanned >= maxEdges || depth >= hops) { partial = true; break; }
          seenEdges.add(value.relationId); scanned++;
          try { await this.authorize(session, actor, refs(value)); }
          catch (error) { if (error instanceof OperationsError && error.code === 'OPERATIONS_NOT_FOUND') { partial = true; continue; } throw error; }
          if (value.state === 'confirmed' && (value.validUntil && Date.parse(value.validUntil) <= +now
            || value.evidence.some(item => Date.parse(item.validUntil) <= +now))) {
            await this.expireHead(session, value, 'expired'); partial = true; continue;
          }
          if (!inWindow(value, now) || value.state !== 'confirmed') {
            partial = true;
            if (!factsOnly && inWindow(value, now) && value.state === 'suggested') edges.push(projection(value, ref));
            continue;
          }
          if (!await session.legacyActive(value, now)) {
            await this.expireHead(session, value, 'withdrawn'); partial = true; continue;
          }
          const evidence = value.evidence.length ? await this.evidence.check(session, actor, value, now) : 'unavailable';
          if (evidence !== 'valid') {
            if (evidence === 'withdrawn') await this.expireHead(session, value, 'withdrawn');
            partial = true; continue;
          }
          edges.push(projection(value, ref));
          const other = resourceKey(value.source) === resourceKey(ref) ? value.target : value.source;
          if (seenNodes.has(resourceKey(other))) { partial = true; continue; }
          seenNodes.add(resourceKey(other)); queue.push({ ref: other, depth: depth + 1, parentEdge: value.relationId });
        }
      }
      // Revalidate exact heads and expiry after all source reads. A late source
      // change or a long traversal must not return a superseded fact.
      const visible: RelationProjection[] = [];
      for (const edge of edges) {
        await this.authorize(session, actor, [edge.source, edge.target]);
        const current = await session.head(edge.relationId), sendAt = this.clock();
        if (!current || current.version !== edge.version || current.contentHash !== edge.contentHash || !inWindow(current, sendAt)
          || current.state === 'confirmed' && (current.evidence.some(item => Date.parse(item.validUntil) <= +sendAt)
            || await this.evidence.check(session, actor, current, sendAt) !== 'valid')) { partial = true; continue; }
        visible.push(edge);
      }
      await this.authorize(session, actor, [root]);
      // A late invalidation can disconnect an already-traversed subtree. Only
      // retain edges reachable from the root through the remaining valid path.
      const reachable = new Set([resourceKey(root)]), retained = new Set<string>();
      let frontier = [root];
      for (let depth = 0; depth < hops && frontier.length; depth++) {
        const next: ResourceRef[] = [];
        for (const ref of frontier) for (const edge of visible) {
          const key = resourceKey(ref);
          if (resourceKey(edge.source) !== key && resourceKey(edge.target) !== key) continue;
          retained.add(edge.relationId);
          const other = resourceKey(edge.source) === key ? edge.target : edge.source;
          if (!reachable.has(resourceKey(other))) { reachable.add(resourceKey(other)); next.push(other); }
        }
        frontier = next;
      }
      if (retained.size < visible.length) partial = true;
      return { resource: root, edges: visible.filter(edge => retained.has(edge.relationId)), partial };
    });
  }

  /** Called by source/resource lifecycle composition in P10. No new approval
   * can reference the superseded hash/version. Missing objects leave history. */
  async invalidate(caller: ActorContext, id: string, expectedVersion: number, reason: 'expired' | 'source_withdrawn' | 'resource_deleted') {
    parse(z.enum(['expired', 'source_withdrawn', 'resource_deleted']), reason);
    parse(version, expectedVersion); parse(idSchema, id);
    const actor = freezeInvestigationCaller(caller), now = this.clock();
    return this.store.transaction(async session => {
      const current = await this.writable(session, actor, id, expectedVersion);
      if (reason === 'expired' && (!current.validUntil || Date.parse(current.validUntil) > +now)
        && current.evidence.every(item => Date.parse(item.validUntil) > +now)) throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      if (reason === 'source_withdrawn' && await this.evidence.check(session, actor, current, now) !== 'withdrawn') throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      // A deleted endpoint cannot pass a live manage check. Lifecycle owners
      // must invalidate before deletion while the endpoint is still authorized.
      const next = { ...current, version: current.version + 1, state: reason === 'expired' ? 'expired' as const : 'withdrawn' as const,
        withdrawalReason: reason };
      await this.append(session, next); return next;
    });
  }
  private validateContent(value: z.infer<typeof contentSchema>, now: Date): void {
    if (Date.parse(value.observedAt) > +now || value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
      throw new OperationsError('OPERATIONS_INPUT_INVALID');
    }
  }
  private authorize(session: RelationSession, actor: ActorContext, resources: readonly ResourceRef[], write = false) {
    return this.authorization.authorize({ execute: (sql, values) => session.connection.execute(sql, values as any[]) },
      actor, resources, write ? 'context:manage' : 'context:read');
  }
  private async writable(session: RelationSession, actor: ActorContext, id: string, expectedVersion: number) {
    parse(idSchema, id);
    const initial = await session.head(id);
    if (!initial) throw new OperationsError('OPERATIONS_NOT_FOUND');
    await session.lockResources(refs(initial));
    await this.authorize(session, actor, refs(initial), true);
    const value = (await session.head(id))!;
    if (value.version !== expectedVersion) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    return value;
  }
  private async append(session: RelationSession, value: StoredRelation) {
    value.contentHash = relationHash(value); await session.append(value);
  }
  private async expireHead(session: RelationSession, value: StoredRelation, state: 'expired' | 'withdrawn') {
    await session.lockHead(value.relationId);
    const current = await session.head(value.relationId);
    if (!current || current.version !== value.version || current.state !== 'confirmed') return;
    await this.append(session, { ...current, state, version: current.version + 1,
      withdrawalReason: state === 'expired' ? 'validity_expired' : 'source_withdrawn' });
  }
}
