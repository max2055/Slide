import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { ActorContextService, ActorAuthenticationError, type ActorContext } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { InvestigationAuthorization, freezeInvestigationCaller } from '../../investigations/authorization.js';
import { InvestigationStoreError } from '../../investigations/store.js';
import { validateOperationalEvent } from '../../investigations/contracts.js';
import { dbConnection } from '../../db-connection.js';
import { resourceKey, type ResourceRef } from '../../resources/types.js';
import { OutboxService } from '../../workflows/outbox-service.js';
import { OperationsAuthorization } from '../authorization.js';
import { OperationsError, operationsContentHash, resourceRefSchema } from '../contracts.js';
import { operationsFlags, assertOperationsEnabled, type OperationsFlags } from '../feature-flags.js';
import { BaselineStore } from '../baselines/store.js';
import { MysqlRelationStore } from '../relations/store.js';
import { RelationService, type RelationEvidence } from '../relations/service.js';
import { buildGroup, correlate, observationWindow, type AttentionEdge, type AttentionEvent, type AttentionGroup, type CorrelationResult } from './correlator.js';
import { compareAttention, compareId, scoreAttention } from './scoring.js';

const key = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const requestSchema = z.strictObject({ observedAt: z.iso.datetime({ precision: 3 }), resources: z.array(resourceRefSchema).min(1).max(20) });
const pageSchema = z.strictObject({ version: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(4096).optional() });
const overrideSchema = z.strictObject({ expectedVersion: version, reason: z.string().trim().min(1).max(1000),
  // Exact partition of ALL persisted events. A one-part partition is a merge.
  partitions: z.array(z.array(z.string().uuid()).min(1).max(1000)).min(1).max(1000) });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new OperationsError('OPERATIONS_INPUT_INVALID'); return result.data;
}
const decode = (value: any): any => typeof value === 'string' ? JSON.parse(value) : value;
const sqlDate = (v: string) => v.replace('T', ' ').replace('Z', '');
const absent = () => new OperationsError('OPERATIONS_NOT_FOUND');
async function rows(c: PoolConnection, sql: string, values: any[] = []): Promise<RowDataPacket[]> { return (await c.execute<RowDataPacket[]>(sql, values))[0]; }

export interface AttentionSnapshot extends CorrelationResult {
  schemaVersion: 1; id: string; version: number; contentHash: string; principal: { id: number; kind: string };
  resources: ResourceRef[]; events: AttentionEvent[]; edges: AttentionEdge[]; baseline: Record<string, number | null>;
  baselines: { id: string; version: number; hash: string; validUntil: string; resource: ResourceRef }[];
  override: { ofVersion: number; reason: string; actorId: number; partitions: string[][] } | null;
}
export interface AttentionPage {
  id: string; version: number; from: string; until: string; ruleVersion: string; scoreRule: string;
  items: (AttentionGroup & { recordedScore: AttentionGroup['score']; recordedReasons: AttentionGroup['reasons']; currentValidity: 'current' | 'unknown'; missing: string[] })[];
  override: AttentionSnapshot['override'] | null;
  authorizedCounts: { total: number }; nextCursor: string | null; modelCalls: 0; partial: boolean;
}
/** A narrow connection lease for composing the existing P02/P04 stores in ONE
 * outer transaction. Nested begin/commit/release are suppressed; failures bubble
 * to the outer rollback. No nested work may escape this callback or retry IO. */
function leasedPool(c: PoolConnection): Pool {
  const lease = new Proxy(c, { get(target, name) {
    if (['beginTransaction', 'commit', 'rollback'].includes(String(name))) return async () => {};
    if (name === 'release') return () => {};
    if (name === 'query') return (sql: any, ...args: any[]) => typeof sql === 'string' && sql.startsWith('SET TRANSACTION ISOLATION LEVEL')
      ? Promise.resolve([[], []]) : (target.query as any).call(target, sql, ...args);
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { getConnection: async () => lease } as unknown as Pool;
}

export class AttentionStore {
  private readonly authorization: OperationsAuthorization;
  private readonly investigations: InvestigationAuthorization;
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool(),
    private readonly contexts = new ActorContextService(),
    private readonly evidence: RelationEvidence = { check: async () => 'unavailable' },
    /** Trusted deployment registry; classification strings alone are not a known signature. */
    private readonly signatures: Readonly<Record<string, string>> = {},
    private readonly flags: () => Readonly<OperationsFlags> = operationsFlags,
    private readonly clock = () => new Date()) {
    this.authorization = new OperationsAuthorization(contexts); this.investigations = new InvestigationAuthorization(contexts);
  }
  private async transaction<T>(work: (c: PoolConnection) => Promise<T>): Promise<T> {
    const pool = this.poolProvider(); if (!pool) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const c = await pool.getConnection();
    try {
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
      // P04 and formal metrics control use this same durable serialization lock.
      if (!(await rows(c, 'SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE')).length) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
      const result = await work(c); await c.commit(); return result;
    } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
  }
  private async principal(c: PoolConnection, actor: ActorContext) {
    try {
      const current = await this.contexts.loadInvestigationActorFrom(c as never, actor.userId, actor.principalKind ?? 'user', actor.sessionVersion, actor.requestId);
      if (![actor, current].every(a => hasPermission(new Set(a.permissions), 'operations:context:view'))) throw absent();
      return current;
    } catch (error) { if (error instanceof ActorAuthenticationError) throw absent(); throw error; }
  }
  private async readable(c: PoolConnection, actor: ActorContext, resources: readonly ResourceRef[], investigationIds: readonly string[], manage = false) {
    await this.authorization.authorize(c as never, actor, resources, manage ? 'context:manage' : 'context:read');
    for (const id of [...investigationIds].sort(compareId)) {
      try { const investigation = await this.investigations.load(c as never, id);
        await this.investigations.authorize(c as never, actor, investigation, 'content');
      } catch (error) { if (error instanceof InvestigationStoreError) throw absent(); throw error; }
    }
  }
  /** Row locks prevent concurrent revocation, but cannot freeze time. Capture
   * the live SQL grant horizon before projection IO. Anchor each TTL BEFORE its
   * query using a monotonic clock, so slow SQL/network IO only shortens access.
   * Conservatively reject the whole response if any captured grant expires;
   * counts, cursor, overrides and recorded explanations share this fence. */
  private async deliveryExpiryFence(c: PoolConnection, actor: ActorContext, investigationIds: string[]) {
    let deadline = Infinity;
    const capture = async (sql: string, values: any[]) => {
      const started = performance.now();
      for (const row of await rows(c, sql, values)) if (row.remaining !== null)
        deadline = Math.min(deadline, started + Number(row.remaining));
    };
    for (const table of ['user_roles', 'instance_permissions']) await capture(`SELECT
      TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),grant_expiry)/1000 remaining FROM ${table}
      WHERE user_id=? AND (grant_expiry IS NULL OR grant_expiry>CURRENT_TIMESTAMP(3)) FOR SHARE`, [actor.userId]);
    if (investigationIds.length) await capture(`SELECT
      TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),expires_at)/1000 remaining FROM investigation_members
      WHERE user_id=? AND investigation_id IN (${investigationIds.map(() => '?').join(',')})
      AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP(3)) FOR SHARE`, [actor.userId, ...investigationIds]);
    return () => { if (performance.now() >= deadline) throw absent(); };
  }
  private assertDeliveryResources(actor: ActorContext, resources: readonly ResourceRef[]) {
    const types = { instance: ['instanceIds', 'instance:view'], server: ['serverIds', 'servers:view'],
      network_device: ['networkDeviceIds', 'network_devices:view'] } as const;
    for (const ref of resources) {
      const [boundary, permission] = types[ref.type];
      if (!hasPermission(new Set(actor.permissions), permission)
        || actor.resourceBoundary && !actor.resourceBoundary[boundary].includes(ref.id)
        || ref.type === 'instance' && !actor.instanceScopes[ref.id]
          && (actor.resourceBoundary || !actor.permissions.some(p => p === '*' || p === 'instance:*'))) throw absent();
    }
  }
  private async loadEvents(c: PoolConnection, actor: ActorContext, resources: readonly ResourceRef[], from: string, until: string): Promise<AttentionEvent[]> {
    await this.readable(c, actor, resources, []);
    const current = await this.principal(c, actor), scopeValues: any[] = [], scopeTerms: string[] = [];
    const types = { instance: ['instanceIds', 'instance:view', 'database_instances'], server: ['serverIds', 'servers:view', 'servers'],
      network_device: ['networkDeviceIds', 'network_devices:view', 'network_devices'] } as const;
    for (const type of ['instance', 'server', 'network_device'] as const) {
      const [boundary, permission, table] = types[type], terms = [`r.resource_type='${type}'`];
      for (const principal of [actor, current]) {
        if (!hasPermission(new Set(principal.permissions), permission)) terms.push('FALSE');
        if (principal.resourceBoundary) {
          const ids = principal.resourceBoundary[boundary];
          terms.push(ids.length ? `r.resource_id IN (${ids.map(() => '?').join(',')})` : 'FALSE'); scopeValues.push(...ids);
        }
        if (type === 'instance' && (principal.resourceBoundary || !principal.permissions.some(p => p === '*' || p === 'instance:*'))) {
          const ids = Object.keys(principal.instanceScopes).map(Number);
          terms.push(ids.length ? `r.resource_id IN (${ids.map(() => '?').join(',')})` : 'FALSE'); scopeValues.push(...ids);
        }
      }
      terms.push(`EXISTS(SELECT 1 FROM ${table} target WHERE target.id=r.resource_id${type === 'instance' ? " AND target.lifecycle_state='available'" : ''})`);
      scopeTerms.push(`(${terms.join(' AND ')})`);
    }
    const memberAllowed = [actor, current].every(a => hasPermission(new Set(a.permissions), 'chat:view'));
    const systemAllowed = [actor, current].every(a => hasPermission(new Set(a.permissions), 'config:view'));
    const subject = resources.map(() => "(JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.subject.resource.type'))=? AND JSON_EXTRACT(envelope,'$.subject.resource.id')=?)").join(' OR ');
    const source = await rows(c, `SELECT id,envelope,classification,investigation_id,occurred_at,received_at FROM operational_events e
      WHERE occurred_at>=? AND occurred_at<? AND occurred_at<=received_at AND occurred_at<=UTC_TIMESTAMP(3)
      AND JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.subject.kind'))='resource' AND (${subject})
      AND (disposition IN ('accepted','linked') OR suppression_reason IN ('BELOW_THRESHOLD','COOLDOWN'))
      AND (investigation_id IS NULL OR (${memberAllowed ? 'TRUE' : 'FALSE'} AND EXISTS(SELECT 1 FROM investigations i
        WHERE i.id=e.investigation_id AND ${systemAllowed ? 'TRUE' : "i.profile_id<>'system'"}
        AND (i.owner_kind=? AND i.owner_id=? OR EXISTS(SELECT 1 FROM investigation_members im WHERE im.investigation_id=i.id AND im.user_id=?
          AND (im.expires_at IS NULL OR im.expires_at>UTC_TIMESTAMP(3))))
        AND NOT EXISTS(SELECT 1 FROM investigation_resources r WHERE r.investigation_id=i.id AND NOT (${scopeTerms.join(' OR ')})))))
      ORDER BY occurred_at,id LIMIT 1001 FOR SHARE`, [sqlDate(from), sqlDate(until), ...resources.flatMap(r => [r.type, r.id]),
        actor.principalKind ?? 'user', actor.userId, actor.principalKind === 'service' ? 0 : actor.userId, ...scopeValues]);
    if (source.length > 1000) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const events: AttentionEvent[] = [];
    for (const row of source) {
      const envelope = decode(row.envelope), classification = decode(row.classification);
      if (!validateOperationalEvent(envelope).ok || envelope.subject.kind !== 'resource' || envelope.origin === 'investigation_engine'
        || envelope.id !== row.id || Date.parse(envelope.occurredAt) !== +new Date(row.occurred_at)
        || Date.parse(envelope.occurredAt) > +this.clock()) continue;
      try { await this.readable(c, actor, [envelope.subject.resource], row.investigation_id ? [row.investigation_id] : []); }
      catch (error) { if (error instanceof OperationsError && error.code === 'OPERATIONS_NOT_FOUND') continue; throw error; }
      const signatureKey = operationsContentHash({ code: classification.stableErrorCode ?? null, callsite: classification.callsite ?? null, kind: envelope.kind });
      events.push({ id: row.id, resource: envelope.subject.resource, investigationId: row.investigation_id,
        occurredAt: new Date(row.occurred_at).toISOString(), severity: envelope.severity, signature: this.signatures[signatureKey] ?? null });
      if (events.length > 1000) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    }
    return events;
  }
  private async facts(c: PoolConnection, actor: ActorContext, resources: readonly ResourceRef[]) {
    const pool = leasedPool(c), edges = new Map<string, AttentionEdge>(), baseline: Record<string, number | null> = {};
    const references: AttentionSnapshot['baselines'] = [];
    let partial = false;
    const relationStore = new MysqlRelationStore(() => pool);
    await relationStore.transaction(async session => {
      const relations = new RelationService({ transaction: work => work(session) }, this.authorization, this.evidence, this.flags, this.clock);
      for (const resource of [...resources].sort((a, b) => compareId(resourceKey(a), resourceKey(b)))) {
        if (edges.size >= 100) { partial = true; break; }
        const graph = await relations.graph(actor, resource, { hops: 2, maxEdges: 100 - edges.size, factsOnly: true });
        partial ||= graph.partial;
        for (const edge of graph.edges) {
          const head = await session.head(edge.relationId); if (!head || !head.evidence.length) continue;
          const legacy = await session.legacyValidity(head, this.clock()); if (!legacy) continue;
          const validUntil = new Date(Math.min(...head.evidence.map(e => Date.parse(e.validUntil)),
            Date.parse(head.validUntil ?? '9999-01-01T00:00:00.000Z'), Date.parse(legacy.validUntil ?? '9999-01-01T00:00:00.000Z'))).toISOString();
          edges.set(edge.relationId, { id: edge.relationId, version: edge.version, hash: edge.contentHash, source: edge.source, target: edge.target, validUntil });
        }
        // P02 partial may include unauthorized or unreturned inspected edges;
        // never spend another traversal budget on another root in that case.
        if (graph.partial) break;
      }
    });
    const baselines = new BaselineStore(() => pool, undefined, this.authorization, this.flags, this.clock);
    for (const resource of resources) {
      const candidates = await rows(c, `SELECT DISTINCT id FROM behavior_baseline_versions WHERE resource_type=? AND resource_id=? ORDER BY id LIMIT 101`, [resource.type, resource.id]);
      baseline[resourceKey(resource)] = null;
      if (candidates.length > 100) { partial = true; continue; }
      const values: number[] = [];
      for (const row of candidates) {
        const b = await baselines.read(actor, row.id), result = b.result;
        if (result.state === 'qualified' && result.status === 'known' && result.comparison.baselineAnomaly !== null
          && result.comparison.deviationRatio !== null && Number.isFinite(result.comparison.deviationRatio))
          { values.push(Math.min(1, Math.abs(result.comparison.deviationRatio)));
            references.push({ id: b.id, version: b.version, hash: b.contentHash, validUntil: result.validUntil, resource }); }
      }
      if (values.length) baseline[resourceKey(resource)] = Math.max(...values);
    }
    return { edges: [...edges.values()].sort((a, b) => compareId(a.id, b.id)).slice(0, 100), baseline, baselines: references,
      partial: partial || edges.size > 100 };
  }
  private async head(c: PoolConnection, actor: ActorContext, id: string, wanted?: number): Promise<AttentionSnapshot> {
    parse(key, id); await this.principal(c, actor);
    const result = await rows(c, `SELECT snapshot FROM attention_correlation_snapshots WHERE id=?${wanted ? ' AND version=?' : ''} ORDER BY version DESC LIMIT 1 FOR SHARE`, wanted ? [id, wanted] : [id]);
    if (!result.length) throw absent();
    const stored: AttentionSnapshot = decode(result[0].snapshot);
    if (stored.principal.id !== actor.userId || stored.principal.kind !== (actor.principalKind ?? 'user')) throw absent();
    return stored;
  }
  private async append(c: PoolConnection, value: AttentionSnapshot) {
    value.contentHash = operationsContentHash({ ...value, contentHash: '' });
    const first = value.groups[0];
    await c.execute(`INSERT INTO attention_correlation_snapshots(id,version,rule_version,content_hash,observed_from,observed_until,severity,
      score_lower,score_upper,coverage,partial,snapshot,override_of_id,override_of_version,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [value.id, value.version, value.ruleVersion, value.contentHash, sqlDate(value.from), sqlDate(value.until), first?.severity ?? 'info',
      first?.score.lower ?? 0, first?.score.upper ?? 100, first?.score.coverage ?? 0, value.partial, JSON.stringify(value),
      value.override ? value.id : null, value.override?.ofVersion ?? null, value.principal.id]);
    for (const [type, ids] of [['event', value.events.map(e => e.id)], ['investigation', [...new Set(value.events.flatMap(e => e.investigationId ? [e.investigationId] : []))]]] as const)
      for (const id of ids) await c.execute('INSERT INTO attention_snapshot_members(snapshot_id,snapshot_version,member_type,member_id,member_version) VALUES(?,?,?,?,?)', [value.id, value.version, type, id, 1]);
    for (const edge of value.edges) await c.execute('INSERT INTO attention_snapshot_members(snapshot_id,snapshot_version,member_type,member_id,member_version) VALUES(?,?,?,?,?)', [value.id, value.version, 'relation', edge.id, edge.version]);
    for (const baseline of value.baselines) await c.execute('INSERT INTO attention_snapshot_members(snapshot_id,snapshot_version,member_type,member_id,member_version) VALUES(?,?,?,?,?)', [value.id, value.version, 'baseline', baseline.id, baseline.version]);
    await new OutboxService({ getConnection: async () => c as never }).append(c as never, {
      eventType: 'operations.attention.versioned', schemaVersion: 1, aggregateType: 'attention', aggregateId: value.id, aggregateVersion: value.version,
      idempotencyKey: `attention:${value.id}:${value.version}`, payload: { schemaVersion: 1, eventId: randomUUID(), objectType: 'attention', objectId: value.id,
        version: value.version, occurredAt: this.clock().toISOString() } });
  }
  async compute(caller: ActorContext, input: unknown, deliver?: (page: AttentionPage) => void): Promise<AttentionPage> {
    assertOperationsEnabled(this.flags(), 'attention');
    const body = parse(requestSchema, input), actor = freezeInvestigationCaller(caller), window = observationWindow(body.observedAt);
    if (Date.parse(body.observedAt) > +this.clock() || new Set(body.resources.map(resourceKey)).size !== body.resources.length) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const resources = [...body.resources].sort((a, b) => compareId(resourceKey(a), resourceKey(b)));
    const id = operationsContentHash({ principal: [actor.principalKind ?? 'user', actor.userId], resources, from: window.from });
    const saved = await this.transaction(async c => {
      await this.principal(c, actor); const events = await this.loadEvents(c, actor, resources, window.from, window.until);
      const facts = await this.facts(c, actor, resources);
      const existing = await rows(c, 'SELECT snapshot FROM attention_correlation_snapshots WHERE id=? ORDER BY version DESC LIMIT 1 FOR UPDATE', [id]);
      const previous: AttentionSnapshot | null = existing.length ? decode(existing[0].snapshot) : null;
      const result = correlate(events, facts.edges, window.from, facts.baseline, previous?.groups);
      const value: AttentionSnapshot = { ...result, schemaVersion: 1, id, version: (previous?.version ?? 0) + 1,
        contentHash: '', principal: { id: actor.userId, kind: actor.principalKind ?? 'user' }, resources, events, ...facts, override: previous?.override ?? null };
      if (previous?.override) this.applyPartitions(value, previous.override.partitions, previous.groups, true);
      await this.readable(c, actor, resources, [...new Set(events.flatMap(e => e.investigationId ? [e.investigationId] : []))]);
      assertOperationsEnabled(this.flags(), 'attention'); await this.append(c, value);
      return { id: value.id, version: value.version };
    });
    // Never acknowledge a new version before its durable commit. The following
    // read opens a fresh, locked final source/ACL projection for delivery.
    return this.read(actor, saved.id, { version: saved.version }, deliver);
  }
  private applyPartitions(value: AttentionSnapshot, partitions: string[][], previous: AttentionGroup[], allowNew: boolean) {
    const known = new Set(value.events.map(e => e.id)), assigned = new Set<string>(), groups: AttentionGroup[] = [];
    for (const partition of partitions) {
      const members = value.events.filter(e => partition.includes(e.id)); if (!members.length) continue;
      for (const e of members) { if (assigned.has(e.id)) throw new OperationsError('OPERATIONS_INPUT_INVALID'); assigned.add(e.id); }
      const old = previous.find(g => g.eventIds.length === members.length && g.eventIds.every(id => partition.includes(id)));
      const id = old?.id ?? operationsContentHash({ snapshot: value.id, partition: members.map(e => e.id).sort(compareId) });
      groups.push(buildGroup(id, members, [{ kind: 'manual', eventIds: members.map(e => e.id).sort(compareId), relationIds: [], signature: null }], value.baseline));
    }
    if (!allowNew && (assigned.size !== known.size || partitions.flat().some(id => !known.has(id)))) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    // Late events cannot undo a human split: new events remain separate until
    // a new audited human decision. Never silently rejoin partitions.
    for (const event of value.events) if (!assigned.has(event.id)) groups.push(buildGroup(operationsContentHash({ snapshot: value.id, event: event.id }), [event], [], value.baseline));
    value.groups = groups.sort(compareAttention);
  }
  async override(caller: ActorContext, id: string, input: unknown, deliver?: (page: AttentionPage) => void) {
    assertOperationsEnabled(this.flags(), 'attention'); const actor = freezeInvestigationCaller(caller), body = parse(overrideSchema, input);
    if (actor.principalKind === 'service' || new Set(body.partitions.flat()).size !== body.partitions.flat().length) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const saved = await this.transaction(async c => {
      const previous = await this.head(c, actor, id);
      if (previous.version !== body.expectedVersion) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      await this.readable(c, actor, previous.resources, [...new Set(previous.events.flatMap(e => e.investigationId ? [e.investigationId] : []))], true);
      const currentEvents = await this.loadEvents(c, actor, previous.resources, previous.from, previous.until);
      if (previous.events.some(old => !currentEvents.some(event => operationsContentHash(event) === operationsContentHash(old))))
        throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
      const facts = await this.facts(c, actor, previous.resources);
      const value: AttentionSnapshot = { ...previous, ...facts, version: previous.version + 1, contentHash: '',
        override: { ofVersion: previous.version, actorId: actor.userId, reason: body.reason, partitions: body.partitions } };
      this.applyPartitions(value, body.partitions, previous.groups, false);
      await this.readable(c, actor, previous.resources, [...new Set(previous.events.flatMap(e => e.investigationId ? [e.investigationId] : []))], true);
      assertOperationsEnabled(this.flags(), 'attention'); await this.append(c, value);
      return { id: value.id, version: value.version };
    });
    return this.read(actor, saved.id, { version: saved.version }, deliver);
  }
  async read(caller: ActorContext, id: string, query: unknown = {}, deliver?: (page: AttentionPage) => void) {
    const options = parse(pageSchema, query), actor = freezeInvestigationCaller(caller);
    return this.transaction(async c => this.page(c, actor, await this.head(c, actor, id, options.version), options, deliver));
  }
  private async page(c: PoolConnection, actor: ActorContext, value: AttentionSnapshot,
    options: { limit: number; cursor?: string }, deliver?: (page: AttentionPage) => void): Promise<AttentionPage> {
    const checkExpiry = await this.deliveryExpiryFence(c, actor, [...new Set(value.events.flatMap(e => e.investigationId ? [e.investigationId] : []))]);
    const visible: AttentionGroup[] = [];
    for (const group of value.groups) {
      try { await this.readable(c, actor, group.resources, group.investigationIds); visible.push(group); }
      catch (error) { if (error instanceof OperationsError && error.code === 'OPERATIONS_NOT_FOUND') continue; throw error; }
    }
    const resources = [...new Map(visible.flatMap(g => g.resources).map(r => [resourceKey(r), r])).values()];
    const currentEvents = resources.length ? await this.loadEvents(c, actor, resources, value.from, value.until) : [];
    const currentById = new Map(currentEvents.map(e => [e.id, e]));
    const permitted = visible.filter(group => group.eventIds.every(id => {
      const stored = value.events.find(e => e.id === id), current = currentById.get(id);
      return stored && current && operationsContentHash({ ...stored, signature: null }) === operationsContentHash({ ...current, signature: null });
    }));
    const facts = await this.facts(c, actor, resources);
    const active = new Map(facts.edges.map(e => [e.id, e]));
    const historicalEdges = new Set<string>();
    for (const edge of value.edges) {
      try { await this.readable(c, actor, [edge.source, edge.target], []); historicalEdges.add(edge.id); }
      catch (error) { if (!(error instanceof OperationsError && error.code === 'OPERATIONS_NOT_FOUND')) throw error; }
    }
    // All asynchronous authorization/source reads precede the final time/flag
    // projection. Locks remain held through synchronous delivery and commit.
    const deliveryResources = [...permitted.flatMap(g => g.resources), ...facts.edges.flatMap(e => [e.source, e.target]),
      ...value.edges.filter(e => historicalEdges.has(e.id)).flatMap(e => [e.source, e.target])];
    const investigations = [];
    for (const id of [...new Set(permitted.flatMap(g => g.investigationIds))].sort(compareId)) {
      const investigation = await this.investigations.load(c as never, id);
      investigations.push(investigation); deliveryResources.push(...investigation.resources);
    }
    for (const group of permitted) await this.readable(c, actor, group.resources, group.investigationIds);
    const current = await this.principal(c, actor);
    // The last async principal result is part of the decision, never discarded.
    // No further IO may occur before this projection's synchronous delivery.
    for (const principal of [actor, current]) {
      this.assertDeliveryResources(principal, deliveryResources);
      if (investigations.length && !hasPermission(new Set(principal.permissions), 'chat:view')
        || investigations.some(i => i.profileId === 'system') && !hasPermission(new Set(principal.permissions), 'config:view')) throw absent();
    }
    for (const reference of facts.baselines) if (Date.parse(reference.validUntil) <= +this.clock()) facts.baseline[resourceKey(reference.resource)] = null;
    const items = permitted.map(group => {
      const missing: string[] = [];
      const validReasons = group.reasons.filter(reason => reason.kind === 'known_signature'
        ? reason.eventIds.every(id => currentById.get(id)?.signature === reason.signature)
        : reason.kind !== 'relation_path' || reason.relationIds.every(id => {
        const old = value.edges.find(e => e.id === id), current = active.get(id);
        return old && current && old.version === current.version && old.hash === current.hash && Date.parse(current.validUntil) > +this.clock();
      }));
      if (validReasons.length !== group.reasons.length) missing.push('relation_no_longer_valid');
      if (!this.flags().attention) missing.push('feature_disabled');
      if (+this.clock() >= Date.parse(value.until) + 15 * 60_000) missing.push('historical_observation_window');
      const members = value.events.filter(e => group.eventIds.includes(e.id));
      const projected = buildGroup(group.id, members, validReasons, facts.baseline);
      if (missing.includes('relation_no_longer_valid')) projected.score = scoreAttention({ severity: projected.severity, impact: null,
        persistence: null, baseline: projected.score.components.baseline === null ? null : projected.score.components.baseline / 15 });
      if (projected.score.components.baseline === null) missing.push('baseline_unknown');
      missing.push('confirmed_impact_unknown');
      return { ...projected, recordedScore: group.score, recordedReasons: group.reasons.filter(reason => reason.relationIds.every(id => historicalEdges.has(id))),
        currentValidity: missing.some(reason => ['relation_no_longer_valid', 'feature_disabled', 'historical_observation_window'].includes(reason)) ? 'unknown' as const : 'current' as const, missing };
    }).sort(compareAttention);
    // ACL/source changes invalidate a cursor rather than returning shifted or
    // hidden offsets. IDs and counts are exclusively from authorized groups.
    const fingerprint = operationsContentHash({ principal: [actor.userId, actor.sessionVersion], id: value.id, version: value.version, items });
    let after = -1;
    if (options.cursor) {
      let cursor: any; try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()); } catch { throw new OperationsError('OPERATIONS_INPUT_INVALID'); }
      if (cursor.fingerprint !== fingerprint) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      after = items.findIndex(g => g.id === cursor.after); if (after < 0) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    }
    const selected = items.slice(after + 1, after + 1 + options.limit);
    const page: AttentionPage = { id: value.id, version: value.version, from: value.from, until: value.until, ruleVersion: value.ruleVersion, scoreRule: value.scoreRule,
      items: selected, authorizedCounts: { total: items.length }, modelCalls: 0, partial: value.partial || facts.partial,
      override: permitted.length === value.groups.length && value.override?.partitions.flat().every(id => permitted.some(g => g.eventIds.includes(id))) ? value.override : null,
      nextCursor: after + 1 + selected.length < items.length ? Buffer.from(JSON.stringify({ fingerprint, after: selected[selected.length - 1].id })).toString('base64url') : null };
    checkExpiry();
    deliver?.(page); return page;
  }
}
