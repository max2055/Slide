import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ActorContextService, ActorAuthenticationError, type ActorContext } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { InvestigationAuthorization, freezeInvestigationCaller } from '../../investigations/authorization.js';
import { validateInvestigationResult } from '../../investigations/contracts.js';
import { resultEvidenceIds } from '../../investigations/result-schema.js';
import { InvestigationStoreError } from '../../investigations/store.js';
import { OutboxService } from '../../workflows/outbox-service.js';
import type { ResourceRef } from '../../resources/types.js';
import { OperationsAuthorization } from '../authorization.js';
import { OperationsError, operationsContentHash, resourceRefSchema, type OperationsPrincipal } from '../contracts.js';
import { CaseCursorCodec, caseTokens, searchFingerprint, type CaseSearch } from './search.js';

export interface CaseContent {
  title: string; symptoms: string; faultType: string; confirmedCause: string;
  actions: string; actualEffect: string; counterexamples: string;
}
export interface CaseApplicability { conditions: string; productVersion: string; resourceVersion: string }
export interface CaseSource {
  investigationId: string; resultVersion: number; resultId: string; resultHash: string;
  requestId: string; runId: string; scopeVersion: string;
  provenance: Record<string, unknown>;
  evidence: { id: string; hash: string; validUntil: string; observedFrom: string | null;
    observedTo: string | null; collectedAt: string;
    quality: { partial: boolean | null; truncated: boolean | null; hasMore: boolean | null };
    page: { limit: number | null; offset: number | null; nextOffset: number | null } }[];
}
export interface StoredCase {
  schemaVersion: 1;
  id: string; revision: number; version: number; state: 'draft' | 'pending_review' | 'published' | 'expired' | 'withdrawn';
  author: OperationsPrincipal; contentHash: string; content: CaseContent; source: CaseSource;
  applicability: CaseApplicability; resources: ResourceRef[]; validUntil: string; redactionPolicyVersion: string;
}
export interface CaseView extends Omit<StoredCase, 'content' | 'source' | 'applicability'> {
  content?: CaseContent; source?: CaseSource; applicability?: CaseApplicability;
  tombstone: boolean; reason?: 'source_unavailable' | 'expired' | 'withdrawn'; referenceOnly: true;
}
export interface CasePage { items: CaseView[]; authorizedCounts: { total: number }; nextCursor: string | null;
  qualification: 'not_qualified'; qualificationReason: 'real_case_cohort_and_quality_not_verified' }
export const json = (value: any): any => typeof value === 'string' ? JSON.parse(value) : value;
export async function rows(c: PoolConnection, sql: string, values: any[] = []): Promise<RowDataPacket[]> {
  return (await c.execute<RowDataPacket[]>(sql, values))[0];
}
const fail = () => new OperationsError('OPERATIONS_PRECONDITION_FAILED');
const absent = () => new OperationsError('OPERATIONS_NOT_FOUND');
const instant = (value: any) => new Date(value).toISOString();
const allowed = (a: ActorContext, code: string) => hasPermission(new Set(a.permissions), code);
const boundary = { instance: 'instanceIds', server: 'serverIds', network_device: 'networkDeviceIds' } as const;
const permission = { instance: 'instance:view', server: 'servers:view', network_device: 'network_devices:view' } as const;

/** SQL authorization is evaluated before COUNT/order/LIMIT, never by loading
 * the global case corpus into JS. Every persisted resource must be visible. */
export function caseVisibility(ceiling: ActorContext, current: ActorContext): { sql: string; values: any[] } {
  const values: any[] = [], predicates: string[] = [];
  for (const type of ['instance', 'server', 'network_device'] as const) {
    const terms = [`r.resource_type = '${type}'`];
    for (const actor of [ceiling, current]) {
      if (!allowed(actor, permission[type])) { terms.push('FALSE'); continue; }
      if (actor.resourceBoundary) {
        const ids = actor.resourceBoundary[boundary[type]];
        terms.push(ids.length ? `r.resource_id IN (${ids.map(() => '?').join(',')})` : 'FALSE'); values.push(...ids);
      }
      if (type === 'instance' && (actor.resourceBoundary || !actor.permissions.some(p => p === '*' || p === 'instance:*'))) {
        const ids = Object.keys(actor.instanceScopes).map(Number);
        terms.push(ids.length ? `r.resource_id IN (${ids.map(() => '?').join(',')})` : 'FALSE'); values.push(...ids);
      }
    }
    const table = type === 'instance' ? 'database_instances' : type === 'server' ? 'servers' : 'network_devices';
    terms.push(`EXISTS(SELECT 1 FROM ${table} target WHERE target.id=r.resource_id${type === 'instance' ? " AND target.lifecycle_state='available'" : ''})`);
    predicates.push(`(${terms.join(' AND ')})`);
  }
  return { sql: `EXISTS(SELECT 1 FROM trusted_case_resources r WHERE r.case_id=c.id AND r.version=v.version)
    AND NOT EXISTS(SELECT 1 FROM trusted_case_resources r WHERE r.case_id=c.id AND r.version=v.version AND NOT (${predicates.join(' OR ')}))`, values };
}

/** Source removal/reopening/new result/evidence expiry invalidates every
 * indexed consumer immediately, with no asynchronous cleanup dependency. */
function sourceVisibility(caller: ActorContext, current: ActorContext): { sql: string; values: any[] } {
  if (![caller, current].every(a => allowed(a, 'chat:view'))) return { sql: 'FALSE', values: [] };
  const system = [caller, current].every(a => allowed(a, 'config:view')) ? 'TRUE' : "i.profile_id <> 'system'";
  return { sql: `EXISTS(SELECT 1 FROM investigations i JOIN investigation_results ir
      ON ir.investigation_id=i.id AND ir.version=c.source_result_version
    WHERE i.id=c.source_investigation_id AND i.lifecycle='closed' AND i.active_request_id IS NULL AND ${system}
      AND i.scope_version=JSON_UNQUOTE(JSON_EXTRACT(v.source_snapshot,'$.scopeVersion'))
      AND (i.owner_kind=? AND i.owner_id=? OR EXISTS(SELECT 1 FROM investigation_members im
        WHERE im.investigation_id=i.id AND im.user_id=? AND (im.expires_at IS NULL OR im.expires_at>UTC_TIMESTAMP(3))))
      AND ir.id=JSON_UNQUOTE(JSON_EXTRACT(v.source_snapshot,'$.resultId'))
      AND ir.payload_hash=JSON_UNQUOTE(JSON_EXTRACT(v.source_snapshot,'$.resultHash'))
      AND ir.version=(SELECT MAX(newer.version) FROM investigation_results newer WHERE newer.investigation_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM investigation_resources sr WHERE sr.investigation_id=i.id
        AND NOT EXISTS(SELECT 1 FROM trusted_case_resources cr WHERE cr.case_id=c.id AND cr.version=v.version
          AND cr.resource_type=sr.resource_type AND cr.resource_id=sr.resource_id))
      AND NOT EXISTS(SELECT 1 FROM trusted_case_resources cr WHERE cr.case_id=c.id AND cr.version=v.version
        AND NOT EXISTS(SELECT 1 FROM investigation_resources sr WHERE sr.investigation_id=i.id
          AND sr.resource_type=cr.resource_type AND sr.resource_id=cr.resource_id))
      AND JSON_LENGTH(v.source_snapshot,'$.evidence')>0
      AND NOT EXISTS(SELECT 1 FROM JSON_TABLE(v.source_snapshot,'$.evidence[*]' COLUMNS(
        evidence_id CHAR(36) PATH '$.id', evidence_hash CHAR(64) PATH '$.hash')) e
        LEFT JOIN investigation_evidence ie ON ie.id=e.evidence_id AND ie.investigation_id=i.id
          AND ie.request_id=ir.request_id AND ie.run_id=ir.run_id
        WHERE ie.id IS NULL OR ie.content_hash<>e.evidence_hash OR ie.expired_at IS NOT NULL OR ie.expires_at<=UTC_TIMESTAMP(3)))`,
    values: [caller.principalKind ?? 'user', caller.userId, caller.principalKind === 'service' ? 0 : caller.userId] };
}

export class KnowledgeStore {
  constructor(private readonly poolProvider: () => Pool | null, readonly cursors: CaseCursorCodec,
    readonly authorization = new OperationsAuthorization(), private readonly contexts = new ActorContextService(),
    private readonly investigations = new InvestigationAuthorization()) {}

  async transaction<T>(caller: ActorContext, work: (c: PoolConnection, actor: ActorContext) => Promise<T>): Promise<T> {
    const actor = freezeInvestigationCaller(caller), pool = this.poolProvider();
    if (!pool) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const c = await pool.getConnection();
    try {
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await c.beginTransaction();
      const value = await work(c, actor);
      await c.commit(); return value;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }

  async liveActor(c: PoolConnection, caller: ActorContext): Promise<ActorContext> {
    if (caller.principalKind === 'service' && !caller.resourceBoundary) throw absent();
    let current: ActorContext;
    try { current = await this.contexts.loadInvestigationActorFrom(c as never, caller.userId,
      caller.principalKind ?? 'user', caller.sessionVersion, caller.requestId); }
    catch (error) { if (error instanceof ActorAuthenticationError) throw absent(); throw error; }
    if (![caller, current].every(a => allowed(a, 'operations:cases:view'))
      || current.sessionVersion !== caller.sessionVersion) throw absent();
    return current;
  }

  async load(c: PoolConnection, id: string, lock = false): Promise<StoredCase> {
    const [row] = await rows(c, `SELECT c.*, v.content_hash, v.content, v.source_snapshot, v.applicability,
      v.redaction_policy_version, v.valid_until FROM trusted_cases c JOIN trusted_case_versions v
      ON v.case_id=c.id AND v.version=c.current_version WHERE c.id=? ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [id]);
    if (!row) throw absent();
    const scope = await rows(c, 'SELECT resource_type, resource_id FROM trusted_case_resources WHERE case_id=? AND version=? ORDER BY resource_type,resource_id FOR SHARE', [id, row.current_version]);
    return { schemaVersion: 1, id, revision: Number(row.version), version: Number(row.current_version), state: row.state,
      author: { kind: row.author_kind, id: Number(row.author_id) }, contentHash: row.content_hash,
      content: json(row.content), source: json(row.source_snapshot), applicability: json(row.applicability),
      resources: scope.map(r => ({ type: r.resource_type, id: Number(r.resource_id) })),
      validUntil: instant(row.valid_until), redactionPolicyVersion: row.redaction_policy_version };
  }

  /** Existing investigation domain remains authoritative. No implicit evidence
   * capture, copied raw body, invented provenance or fallback to latest result. */
  async source(c: PoolConnection, caller: ActorContext, id: string, resultVersion: number): Promise<{ source: CaseSource; resources: ResourceRef[] }> {
    try {
      const investigation = await this.investigations.load(c as never, id);
      await this.investigations.authorize(c as never, caller, investigation, 'content');
      const [head] = await rows(c, 'SELECT lifecycle,active_request_id FROM investigations WHERE id=? FOR SHARE', [id]);
      if (head.lifecycle !== 'closed' || head.active_request_id) throw fail();
      const [result] = await rows(c, `SELECT * FROM investigation_results WHERE investigation_id=? AND version=?
        AND version=(SELECT MAX(version) FROM investigation_results WHERE investigation_id=?) FOR SHARE`, [id, resultVersion, id]);
      if (!result) throw fail();
      const body = json(result.result_json), refs = resultEvidenceIds(body);
      if (!validateInvestigationResult(body, new Set(refs)).ok || !refs.length || refs.length > 100) throw fail();
      const provenance = body.provenance;
      if (![provenance.modelVersion, provenance.promptVersion, ...Object.values(provenance.toolVersions)].every(v =>
        typeof v === 'string' && v.trim() && !/^(unknown|unavailable)$/i.test(v)) || !Object.keys(provenance.toolVersions).length
        || provenance.runtimeRunId !== result.run_id) throw fail();
      const resources = investigation.resources.map(({ type, id }) => resourceRefSchema.parse({ type, id }));
      if (!resources.length || resources.length > 100) throw fail();
      const evidence: CaseSource['evidence'] = [];
      for (const ref of refs) {
        const [row] = await rows(c, `SELECT * FROM investigation_evidence WHERE id=? AND investigation_id=?
          AND request_id=? AND run_id=? AND expired_at IS NULL AND expires_at>UTC_TIMESTAMP(3) FOR SHARE`, [ref, id, result.request_id, result.run_id]);
        if (!row) throw fail();
        const metadata = json(row.metadata_json);
        const raw = json(row.raw_json);
        const flag = (key: string) => typeof raw?.[key] === 'boolean' ? raw[key] : null;
        const ordinal = (key: string) => Number.isSafeInteger(raw?.[key]) && raw[key] >= 0 ? raw[key] : null;
        const evidenceResources = (metadata.resources as unknown[]).map(r => resourceRefSchema.parse(r));
        if (evidenceResources.some(ref => !resources.some(r => r.type === ref.type && r.id === ref.id))) throw fail();
        await this.investigations.authorize(c as never, caller, investigation, 'content', evidenceResources);
        evidence.push({ id: row.id, hash: row.content_hash, validUntil: instant(row.expires_at),
          observedFrom: metadata.observedFrom, observedTo: metadata.observedTo, collectedAt: metadata.collectedAt,
          quality: { partial: flag('partial'), truncated: flag('truncated'), hasMore: flag('hasMore') },
          page: { limit: ordinal('limit'), offset: ordinal('offset'), nextOffset: ordinal('nextOffset') } });
      }
      return { resources, source: { investigationId: id, resultVersion, resultId: result.id, resultHash: result.payload_hash,
        requestId: result.request_id, runId: result.run_id, scopeVersion: investigation.scopeVersion, provenance, evidence } };
    } catch (error) {
      if (error instanceof InvestigationStoreError) {
        if (error.statusCode === 404 || error.statusCode === 403) throw absent();
        throw fail();
      }
      throw error;
    }
  }

  async sourceAvailable(c: PoolConnection, caller: ActorContext, item: StoredCase): Promise<boolean> {
    await this.liveActor(c, caller);
    try {
      // The canonical adapter takes current SHARE locks on membership, source,
      // exact result and evidence. Revocation/withdrawal cannot commit between
      // the final check and the synchronous send in this transaction.
      const fresh = await this.source(c, caller, item.source.investigationId, item.source.resultVersion);
      const binding = ({ provenance: _provenance, ...source }: CaseSource) => source;
      return operationsContentHash(binding(fresh.source)) === operationsContentHash(binding(item.source))
        && operationsContentHash(fresh.resources) === operationsContentHash(item.resources);
    } catch (error) {
      if (error instanceof OperationsError && ['OPERATIONS_NOT_FOUND', 'OPERATIONS_PRECONDITION_FAILED'].includes(error.code)) return false;
      throw error;
    }
  }

  async insertVersion(c: PoolConnection, item: StoredCase): Promise<void> {
    await c.execute(`INSERT INTO trusted_case_versions(case_id,version,content_hash,content,source_snapshot,applicability,redaction_policy_version,valid_until)
      VALUES(?,?,?,?,?,?,?,?)`, [item.id, item.version, item.contentHash, JSON.stringify(item.content), JSON.stringify(item.source),
      JSON.stringify(item.applicability), item.redactionPolicyVersion, new Date(item.validUntil)]);
    for (const ref of item.resources) await c.execute('INSERT INTO trusted_case_resources(case_id,version,resource_type,resource_id) VALUES(?,?,?,?)', [item.id, item.version, ref.type, ref.id]);
  }
  async updateHead(c: PoolConnection, item: StoredCase): Promise<void> {
    await c.execute('UPDATE trusted_cases SET version=?,current_version=?,state=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?',
      [item.revision, item.version, item.state, item.id]);
  }
  async index(c: PoolConnection, item: StoredCase): Promise<void> {
    for (const token of caseTokens([...Object.values(item.content), ...Object.values(item.applicability)].join(' '))) {
      await c.execute('INSERT INTO trusted_case_search_tokens(token,case_id,version) VALUES(?,?,?)', [Buffer.from(token), item.id, item.version]);
    }
  }
  async event(c: PoolConnection, item: StoredCase, action: string, actor: ActorContext, reason?: string): Promise<void> {
    const eventId = randomUUID();
    await new OutboxService({ getConnection: async () => c as never }).append(c as never, {
      eventType: `operations.case.${action}`, schemaVersion: 1, aggregateType: 'trusted_case', aggregateId: item.id,
      aggregateVersion: item.revision, idempotencyKey: `case:${item.id}:${item.revision}`,
      payload: { schemaVersion: 1, eventId, objectType: 'case', objectId: item.id, version: item.revision,
        contentVersion: item.version, contentHash: item.contentHash, state: item.state, occurredAt: new Date().toISOString(),
        actor: { kind: actor.principalKind ?? 'user', id: actor.userId }, ...(reason ? { reason } : {}) },
    });
  }

  async view(c: PoolConnection, caller: ActorContext, item: StoredCase): Promise<CaseView> {
    await this.authorization.authorize(c as never, caller, item.resources, 'cases:read');
    let reason: CaseView['reason'] = item.state === 'withdrawn' ? 'withdrawn' : item.state === 'expired' || Date.parse(item.validUntil) <= Date.now()
      ? 'expired' : !await this.sourceAvailable(c, caller, item) ? 'source_unavailable' : undefined;
    if (item.state !== 'published' && !reason) {
      try { await this.authorization.authorize(c as never, caller, item.resources, 'cases:manage'); }
      catch (error) {
        if (!(error instanceof OperationsError) || error.statusCode !== 403 || item.state !== 'pending_review') throw error;
        await this.authorization.authorize(c as never, caller, item.resources, 'cases:review', { author: item.author });
      }
    }
    // Source checks reload identity and may await SQL; recheck complete scope
    // after them as well, immediately before constructing outbound content.
    await this.authorization.authorize(c as never, caller, item.resources, 'cases:read');
    if (!reason && Date.parse(item.validUntil) <= Date.now()) reason = 'expired';
    if (reason) {
      const { content: _content, source: _source, applicability: _applicability, ...metadata } = item;
      return { ...metadata, state: reason === 'expired' ? 'expired' : metadata.state, tombstone: true, reason, referenceOnly: true };
    }
    return { ...item, tombstone: false, referenceOnly: true };
  }

  async search(c: PoolConnection, caller: ActorContext, input: CaseSearch): Promise<CasePage> {
    const current = await this.liveActor(c, caller);
    const management = [caller, current].every(a => allowed(a, 'operations:cases:manage'));
    const independentReview = input.state === 'pending_review' && caller.principalKind !== 'service'
      && [caller, current].every(a => allowed(a, 'operations:cases:review'));
    if (input.state !== 'published' && !management && !independentReview) throw absent();
    const authority = operationsContentHash([caller.userId, caller.principalKind ?? 'user', caller.sessionVersion,
      [...caller.permissions].sort(), caller.instanceScopes, caller.resourceBoundary ?? null,
      [...current.permissions].sort(), current.instanceScopes, current.resourceBoundary ?? null]);
    const filter = searchFingerprint(input), now = Date.now();
    const position = input.cursor ? this.cursors.decode(input.cursor, filter, authority, now) : null;
    const scope = caseVisibility(caller, current), source = sourceVisibility(caller, current);
    const asOf = position?.asOf ?? new Date(now).toISOString();
    const terms = ['c.state=?', 'v.valid_until>UTC_TIMESTAMP(3)', 'c.updated_at<=?', scope.sql, source.sql];
    const values: any[] = [input.state, new Date(asOf), ...scope.values, ...source.values];
    if (!management && independentReview) { terms.push('c.author_id<>?'); values.push(caller.userId); }
    if (input.state === 'expired') { terms[0] = "c.state IN ('expired','published')"; terms[1] = 'v.valid_until<=UTC_TIMESTAMP(3)'; values.shift(); }
    if (input.faultType) { terms.push("JSON_UNQUOTE(JSON_EXTRACT(v.content,'$.faultType'))=?"); values.push(input.faultType); }
    for (const field of ['productVersion', 'resourceVersion'] as const) if (input[field]) {
      terms.push(`JSON_UNQUOTE(JSON_EXTRACT(v.applicability,'$.${field}'))=?`); values.push(input[field]);
    }
    if (input.resourceType) { terms.push('EXISTS(SELECT 1 FROM trusted_case_resources r WHERE r.case_id=c.id AND r.version=v.version AND r.resource_type=?)'); values.push(input.resourceType); }
    const tokens = caseTokens(input.query, true);
    if (input.query && !tokens.length) terms.push('FALSE');
    for (const token of tokens) { terms.push('EXISTS(SELECT 1 FROM trusted_case_search_tokens t WHERE t.token=? AND t.case_id=c.id AND t.version=v.version)'); values.push(Buffer.from(token)); }
    const from = `FROM trusted_cases c JOIN trusted_case_versions v ON v.case_id=c.id AND v.version=c.current_version WHERE ${terms.join(' AND ')}`;
    const [count] = await rows(c, `SELECT COUNT(*) total ${from}`, values);
    const page = await rows(c, `SELECT c.id ${from}${position ? ' AND c.id>?' : ''} ORDER BY c.id LIMIT ?`,
      [...values, ...(position ? [position.after] : []), input.limit + 1]);
    const items: CaseView[] = [];
    for (const row of page.slice(0, input.limit)) {
      const item = await this.load(c, row.id);
      const view = await this.view(c, caller, item);
      // A change between count and locking reads invalidates this entire page;
      // never return a hidden item's position or a stale count.
      if (view.tombstone && input.state !== 'expired' && input.state !== 'withdrawn'
        || !view.tombstone && item.state !== input.state) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      items.push(view);
    }
    const final = await this.liveActor(c, caller);
    if (operationsContentHash(current) !== operationsContentHash(final)) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    const [finalCount] = await rows(c, `SELECT COUNT(*) total ${from}`, values);
    if (Number(finalCount.total) !== Number(count.total)) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    if (!['expired','withdrawn'].includes(input.state) && items.some(item => Date.parse(item.validUntil) <= Date.now()))
      throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
    return { items, authorizedCounts: { total: Number(count.total) }, nextCursor: page.length > input.limit
      ? this.cursors.encode({ after: items.at(-1)!.id, asOf, filter, authority, expires: position?.expires ?? now + 10 * 60_000 }) : null,
      qualification: 'not_qualified', qualificationReason: 'real_case_cohort_and_quality_not_verified' };
  }
}
