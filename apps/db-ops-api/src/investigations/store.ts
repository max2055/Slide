import { assertKnownPartial, type InvestigationContinuation } from './continuation.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { INVESTIGATION_ERROR_STATUS, type InvestigationSubject } from './contracts.js';
import { OutboxService, type TransactionConnection, type TransactionPool, type OutboxInput } from '../workflows/outbox-service.js';

type ErrorCode = keyof typeof INVESTIGATION_ERROR_STATUS;
export class InvestigationStoreError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ErrorCode, cause?: unknown) {
    super(code, { cause });
    this.statusCode = INVESTIGATION_ERROR_STATUS[code];
  }
}
export type InvestigationActor = { kind: 'user' | 'service'; id: number };
export interface InvestigationAdmission {
  continuationOf?: InvestigationContinuation;
  investigationId: string;
  actor: InvestigationActor;
  idempotencyKey: string;
  message: string;
  expectedVersion: number;
}
export interface InvestigationAcceptance {
  investigationId: string;
  sessionId: string;
  requestId: string;
  jobId: string;
  version: number;
}
export interface InvestigationResource {
  type: 'instance' | 'server' | 'network_device';
  id: number;
  role: 'primary' | 'related';
}
export interface InvestigationAdmissionResult {
  acceptance: InvestigationAcceptance;
  isNew: boolean;
}
export interface AdmissionInvestigation {
  id: string;
  sessionId: string;
  profileId: string;
  profileVersion: number;
  scopeVersion: string;
  lifecycle: 'open' | 'waiting' | 'closed' | 'archived';
  version: number;
  owner: Readonly<InvestigationActor>;
  resources: readonly Readonly<InvestigationResource>[];
}
export interface InvestigationRecord extends AdmissionInvestigation {
  title: string;
  goal: string;
  context?: { subject: InvestigationSubject; from?: string; to?: string };
  problemStatus: 'unconfirmed' | 'in_progress' | 'resolved' | 'not_applicable';
  activeRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface InvestigationCreate {
  /** Trusted HTTP command, recovered before allocating a new investigation. */
  idempotencyKey?: string;
  context?: { subject: InvestigationSubject; from?: string; to?: string };
  actor: InvestigationActor;
  title: string;
  goal: string;
  sessionId?: string;
  /** Resolved by the trusted Profile service before calling this port. */
  profileId: 'ops' | 'system';
  profileVersion: number;
  resources: readonly InvestigationResource[];
}
export interface InvestigationPatch {
  expectedVersion: number;
  title?: string;
  goal?: string;
  lifecycle?: AdmissionInvestigation['lifecycle'];
}
export interface InvestigationList {
  lifecycle?: AdmissionInvestigation['lifecycle'];
  profileId?: 'ops' | 'system';
  resource?: Pick<InvestigationResource, 'type' | 'id'>;
  query?: string;
  limit?: number;
  offset?: number;
}
export type InvestigationOperation = 'create' | 'read' | 'patch' | 'admit' | 'cancel';
/** Trusted server port, never accepted from HTTP/model input. T03 supplies live
 * actor + ACL + Profile + tool/resource intersection, covering EVERY resource.
 * Runs inside the same transaction on every read/write, including retries.
 * Invisible objects throw NOT_FOUND; visible non-operators throw FORBIDDEN.
 * Resources and Profile/scope versions are immutable in this store. No callback
 * may append messages or execute a model. Use this connection for authority
 * reads/locks; do not substitute a previous request's authorization. The service
 * actor ID must be the real numeric disabled-login user, validated by T03 before
 * this call. prepareReadList may lock the same predicates once for a list. */
export interface AdmissionAuthorizer {
  (connection: TransactionConnection, actor: Readonly<InvestigationActor>,
    investigation: Readonly<AdmissionInvestigation>, operation: InvestigationOperation): Promise<void>;
  prepareReadList?(connection: TransactionConnection, actor: Readonly<InvestigationActor>,
    investigations: readonly Readonly<AdmissionInvestigation>[]): Promise<void>;
  clearReadList?(connection: TransactionConnection): void;
}

/** Only trusted server composition supplies this hook. Session/Investigation/
 * Request/Job are locked and live cancel authority is checked before invocation.
 * Hook must use this connection, perform SQL only, and never terminate a Run. */
export interface InvestigationCancellation {
  investigation: Readonly<InvestigationRecord>;
  requestId: string;
  actor: Readonly<InvestigationActor>;
  messageId: string | null;
  snapshot: unknown;
  job: { id: string; state: string; attempts: number; fencingToken: number; leaseActive: boolean };
}
export type InvestigationCancellationHook = (connection: TransactionConnection,
  cancellation: Readonly<InvestigationCancellation>) => Promise<void>;
const requireCancellationHook: InvestigationCancellationHook = async (connection, value) => {
  const snapshot = typeof value.snapshot === 'string' ? JSON.parse(value.snapshot) : value.snapshot;
  const [allocations] = await connection.execute('SELECT id FROM investigation_budget_ledger WHERE request_id = ? FOR UPDATE',
    [value.requestId]) as [RowDataPacket[], unknown];
  if (value.actor.kind === 'service' || snapshot?.budgetReceipt || allocations.length)
    throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
};

const invalid = () => new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validate(input: InvestigationAdmission): void {
  if (!input || !uuid.test(input.investigationId) || !input.actor
    || !validActor(input.actor)
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || Buffer.byteLength(input.idempotencyKey) > 255
    || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 2_000
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw invalid();
}
async function select<T extends RowDataPacket>(connection: TransactionConnection, sql: string, values: unknown[]): Promise<T[]> {
  const [rows] = await connection.execute(sql, values) as [T[], unknown];
  return rows;
}

function validActor(actor: InvestigationActor): boolean {
  return !!actor && ['user', 'service'].includes(actor.kind) && Number.isSafeInteger(actor.id) && actor.id > 0 && actor.id <= 4_294_967_295;
}
function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max;
}
const lifecycles = ['open', 'waiting', 'closed', 'archived'];

/** T02-B persistence port. T03 must implement authority/Session append before
 * T02-C registers HTTP. This module creates no Agent Run or Chat messages. */
export class MysqlInvestigationStore {
  constructor(private readonly poolProvider: () => Pool | null, private readonly authorize: AdmissionAuthorizer,
    private readonly cancelBudget: InvestigationCancellationHook = requireCancellationHook) {}

  async transaction<T>(work: (connection: TransactionConnection, append: (event: OutboxInput) => Promise<string>) => Promise<T>): Promise<T> {
    if (typeof this.authorize !== 'function') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    const pool = this.poolProvider();
    if (!pool) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    try {
      return await new OutboxService(pool as unknown as TransactionPool).transaction(work);
    } catch (error) {
      if (error instanceof InvestigationStoreError) throw error;
      throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE', error);
    }
  }

  private toRecord(row: RowDataPacket, resources: readonly RowDataPacket[], creation?: RowDataPacket): InvestigationRecord {
    const context = creation?.command_snapshot?.context;
    return { ...(context ? { context } : {}), id: row.id, sessionId: row.session_id, title: row.title, goal: row.goal,
      profileId: row.profile_id, profileVersion: Number(row.profile_version), scopeVersion: row.scope_version,
      lifecycle: row.lifecycle, problemStatus: row.problem_status, version: Number(row.version),
      owner: Object.freeze({ kind: row.owner_kind, id: Number(row.owner_id) }),
      resources: Object.freeze(resources.map(resource => Object.freeze({ type: resource.resource_type,
        id: Number(resource.resource_id), role: resource.role }))),
      activeRequestId: row.active_request_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private async map(connection: TransactionConnection, row: RowDataPacket): Promise<InvestigationRecord> {
    const resources = await select(connection, `SELECT resource_type, resource_id, role FROM investigation_resources
      WHERE investigation_id = ? ORDER BY resource_type, resource_id FOR SHARE`, [row.id]);
    const [creation] = await select(connection, 'SELECT command_snapshot FROM investigation_create_keys WHERE investigation_id = ?', [row.id]);
    return this.toRecord(row, resources, creation);
  }

  private async attachContexts(connection: TransactionConnection, items: InvestigationRecord[]): Promise<InvestigationRecord[]> {
    if (!items.length) return items;
    const snapshots = await select(connection, `SELECT investigation_id, command_snapshot FROM investigation_create_keys
      WHERE investigation_id IN (${items.map(() => '?').join(',')})`, items.map(item => item.id));
    const contexts = new Map<string, InvestigationRecord['context']>();
    for (const snapshot of snapshots) {
      if (contexts.has(snapshot.investigation_id) || !snapshot.command_snapshot?.context) continue;
      contexts.set(snapshot.investigation_id, snapshot.command_snapshot.context);
    }
    return items.map(item => {
      const context = contexts.get(item.id);
      return context ? { ...item, context } : item;
    });
  }

  private async load(connection: TransactionConnection, id: string, lock: 'UPDATE' | 'SHARE'): Promise<InvestigationRecord> {
    const [row] = await select(connection, `SELECT * FROM investigations WHERE id = ? FOR ${lock}`, [id]);
    if (!row) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
    return this.map(connection, row);
  }

  async create(input: InvestigationCreate): Promise<InvestigationRecord> {
    input = input && { ...input, actor: { ...input.actor }, resources: Array.isArray(input.resources)
      ? input.resources.map(resource => ({ ...resource })) : input.resources };
    return this.transaction(connection => this.createInTransaction(connection, input));
  }

  /** Compose with admitInTransaction under ONE transaction to create and admit
   * atomically. Connection/inputs are trusted server service ports only. */
  async createInTransaction(connection: TransactionConnection, input: InvestigationCreate): Promise<InvestigationRecord> {
    if (typeof this.authorize !== 'function') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    if (!input || !validActor(input.actor) || !validText(input.title, 200) || !validText(input.goal, 2_000)
      || !['ops', 'system'].includes(input.profileId) || !Number.isSafeInteger(input.profileVersion) || input.profileVersion < 1
      || input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || Buffer.byteLength(input.idempotencyKey) > 255)
      || input.sessionId !== undefined && !validText(input.sessionId, 100)
      || !Array.isArray(input.resources) || input.resources.length > 20
      || input.resources.some(resource => !resource || !['instance', 'server', 'network_device'].includes(resource.type)
        || !Number.isSafeInteger(resource.id) || resource.id <= 0 || resource.id > 4_294_967_295 || !['primary', 'related'].includes(resource.role))) throw invalid();
    if (input.profileId === 'ops' && !input.resources.length || input.profileId === 'system' && input.resources.length)
      throw new InvestigationStoreError('PROFILE_SUBJECT_UNSUPPORTED');
    input = { ...input, actor: { ...input.actor }, resources: input.resources.map(resource => ({ ...resource })) };
    const resources = input.resources.map(({ type, id, role }) => ({ type, id, role }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);
    if (new Set(resources.map(resource => `${resource.type}:${resource.id}`)).size !== resources.length) throw invalid();
    const command = { title: input.title, goal: input.goal, profileId: input.profileId,
      profileVersion: input.profileVersion, resources, sessionId: input.sessionId ?? null,
      context: input.context ?? null };
    const commandHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const createKey = input.idempotencyKey === undefined ? undefined : [input.actor.kind, input.actor.id, Buffer.from(input.idempotencyKey)];
    if (createKey) {
      await connection.execute(`INSERT INTO investigation_create_keys
        (actor_kind, actor_id, idempotency_key, command_hash, command_snapshot) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE investigation_id = investigation_id`, [...createKey, commandHash, JSON.stringify(command)]);
      const [previous] = await select(connection, `SELECT * FROM investigation_create_keys
        WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ? FOR UPDATE`, createKey);
      // Match admit's actor/key -> Session -> investigation order even when
      // a retry arrives simultaneously through the /runs entrance.
      await connection.execute(`INSERT INTO investigation_admission_keys (actor_kind, actor_id, idempotency_key)
        VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id`, createKey);
      await connection.execute(`SELECT request_id FROM investigation_admission_keys
        WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ? FOR UPDATE`, createKey);
      if (previous.investigation_id) {
        // Preserve the common lock order with admission. Never create a second
        // Session and never use an old acceptance as reusable authorization.
        const [binding] = await select(connection, 'SELECT session_id FROM investigations WHERE id = ?', [previous.investigation_id]);
        if (!binding) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
        await connection.execute('SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE', [binding.session_id]);
        const record = await this.load(connection, previous.investigation_id, 'UPDATE');
        await this.authorize(connection, Object.freeze(input.actor), Object.freeze(record), 'create');
        if (previous.command_hash !== commandHash) throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
        // Bridge.create passes this ORIGINAL creation version to the original
        // first admission; later patches/runs must not change its request hash.
        return { ...record, version: 1 };
      }
    }
    const scopeVersion = createHash('sha256').update(JSON.stringify(resources)).digest('hex');
    const sessionId = input.sessionId ?? randomUUID();
    if (input.sessionId) {
      const [session] = await select(connection, 'SELECT user_id FROM chat_sessions WHERE session_id = ? FOR UPDATE', [sessionId]);
      // Conversion is owner-only, regardless of ordinary read shares.
      if (!session || Number(session.user_id) !== input.actor.id) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      const linked = await select(connection, 'SELECT id FROM investigations WHERE session_id = ? FOR UPDATE', [sessionId]);
      const running = await select(connection, "SELECT id FROM agent_runs WHERE session_id = ? AND state = 'running' FOR UPDATE", [sessionId]);
      if (linked.length || running.length) throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
    } else {
      await connection.execute(`INSERT INTO chat_sessions (session_id, user_id, title, message_count, last_message_at)
        VALUES (?, ?, ?, 0, NOW())`, [sessionId, input.actor.id, input.title]);
      }
    const now = new Date();
    const record: InvestigationRecord = { id: randomUUID(), sessionId, title: input.title, goal: input.goal,
      profileId: input.profileId, profileVersion: input.profileVersion, scopeVersion, lifecycle: 'open',
      problemStatus: 'unconfirmed', version: 1, owner: Object.freeze({ ...input.actor }),
      resources: Object.freeze(resources.map(resource => Object.freeze(resource))), activeRequestId: null, createdAt: now, updatedAt: now };
    await this.authorize(connection, Object.freeze(input.actor), Object.freeze(record), 'create');
    await connection.execute(`INSERT INTO investigations
      (id, title, goal, profile_id, profile_version, session_id, owner_kind, owner_id, scope_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [record.id, record.title, record.goal, record.profileId,
      record.profileVersion, sessionId, record.owner.kind, record.owner.id, scopeVersion]);
    for (const resource of resources) await connection.execute(`INSERT INTO investigation_resources
      (investigation_id, resource_type, resource_id, role) VALUES (?, ?, ?, ?)`, [record.id, resource.type, resource.id, resource.role]);
    if (createKey) await connection.execute(`UPDATE investigation_create_keys SET investigation_id = ?
      WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ?`, [record.id, ...createKey]);
    return this.load(connection, record.id, 'UPDATE');
  }

  async detail(actor: InvestigationActor, id: string): Promise<InvestigationRecord> {
    if (!validActor(actor) || !uuid.test(id)) throw invalid();
    actor = Object.freeze({ ...actor });
    return this.transaction(async connection => {
      const record = await this.load(connection, id, 'SHARE');
      await this.authorize(connection, actor, Object.freeze(record), 'read');
      return record;
    });
  }

  async list(actor: InvestigationActor, options: InvestigationList = {}): Promise<{ items: InvestigationRecord[]; total: number }> {
    const { limit = 20, offset = 0, lifecycle, profileId, query, resource } = { ...options, resource: options.resource ? { ...options.resource } : undefined };
    if (!validActor(actor) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || !Number.isSafeInteger(offset) || offset < 0 || lifecycle !== undefined && !lifecycles.includes(lifecycle)
      || profileId !== undefined && !['ops', 'system'].includes(profileId) || query !== undefined && !validText(query, 200)
      || resource !== undefined && (!['instance', 'server', 'network_device'].includes(resource.type) || !Number.isSafeInteger(resource.id) || resource.id <= 0)) throw invalid();
    actor = Object.freeze({ ...actor });
    const filters = { limit, offset, lifecycle, profileId, query, resource };
    // Test-only switch so a same-process V1 sample can time the per-row path.
    // Production and ordinary tests keep the aggregated locking reads.
    const legacy = process.env.NODE_ENV === 'test' && process.env.INVESTIGATION_LIST_AGGREGATION === '0';
    return this.transaction(connection => legacy ? this.listPerRow(connection, actor, filters) : this.listAggregated(connection, actor, filters));
  }

  private async listPerRow(connection: TransactionConnection, actor: Readonly<InvestigationActor>,
    options: Required<Pick<InvestigationList, 'limit' | 'offset'>> & Omit<InvestigationList, 'limit' | 'offset'>): Promise<{ items: InvestigationRecord[]; total: number }> {
    const { limit, offset, lifecycle, profileId, query, resource } = options;
    const rows = await select(connection, `SELECT * FROM investigations ${lifecycle ? 'WHERE lifecycle = ?' : ''}
      ORDER BY updated_at DESC, id DESC FOR SHARE`, lifecycle ? [lifecycle] : []);
    const visible: InvestigationRecord[] = [];
    for (const row of rows) {
      const record = await this.map(connection, row);
      if (!await this.keepReadable(connection, actor, record, profileId, query, resource)) continue;
      visible.push(record);
    }
    return { total: visible.length, items: visible.slice(offset, offset + limit) };
  }

  private async listAggregated(connection: TransactionConnection, actor: Readonly<InvestigationActor>,
    options: Required<Pick<InvestigationList, 'limit' | 'offset'>> & Omit<InvestigationList, 'limit' | 'offset'>): Promise<{ items: InvestigationRecord[]; total: number }> {
    const { limit, offset, lifecycle, profileId, query, resource } = options;
    // No SQL LIMIT or COUNT before every row has passed the authorizer.
    // One locking read per predicate must not admit a row the per-object port rejects.
    const rows = await select(connection, `SELECT * FROM investigations ${lifecycle ? 'WHERE lifecycle = ?' : ''}
      ORDER BY updated_at DESC, id DESC FOR SHARE`, lifecycle ? [lifecycle] : []);
    const resourceRows = await select(connection, `SELECT r.investigation_id, r.resource_type, r.resource_id, r.role
      FROM investigations i STRAIGHT_JOIN investigation_resources r ON r.investigation_id = i.id
      ${lifecycle ? 'WHERE i.lifecycle = ?' : ''}
      ORDER BY r.investigation_id, r.resource_type, r.resource_id FOR SHARE`, lifecycle ? [lifecycle] : []);
    const grouped = new Map<string, RowDataPacket[]>();
    for (const resourceRow of resourceRows) {
      const bucket = grouped.get(resourceRow.investigation_id) ?? [];
      bucket.push(resourceRow);
      grouped.set(resourceRow.investigation_id, bucket);
    }
    const records = rows.map(row => this.toRecord(row, grouped.get(row.id) ?? []));
    try {
      if (this.authorize.prepareReadList) await this.authorize.prepareReadList(connection, actor, records);
      const visible: InvestigationRecord[] = [];
      for (const record of records) {
        if (!await this.keepReadable(connection, actor, record, profileId, query, resource)) continue;
        visible.push(record);
      }
      return { total: visible.length, items: await this.attachContexts(connection, visible.slice(offset, offset + limit)) };
    } finally {
      this.authorize.clearReadList?.(connection);
    }
  }

  private async keepReadable(connection: TransactionConnection, actor: Readonly<InvestigationActor>, record: InvestigationRecord,
    profileId: InvestigationList['profileId'], query: string | undefined, resource: InvestigationList['resource']): Promise<boolean> {
    try { await this.authorize(connection, actor, Object.freeze(record), 'read'); }
    catch (error) {
      if (error instanceof InvestigationStoreError && error.code === 'INVESTIGATION_NOT_FOUND') return false;
      throw error;
    }
    return !(profileId && record.profileId !== profileId || resource && !record.resources.some(ref => ref.type === resource.type && ref.id === resource.id)
      || query && !`${record.title} ${record.goal}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  }

  async patch(actor: InvestigationActor, id: string, patch: InvestigationPatch): Promise<InvestigationRecord> {
    if (!validActor(actor) || !uuid.test(id) || !patch || !Number.isSafeInteger(patch.expectedVersion) || patch.expectedVersion < 1
      || Object.keys(patch).some(key => !['expectedVersion', 'title', 'goal', 'lifecycle'].includes(key))
      || patch.title !== undefined && !validText(patch.title, 200) || patch.goal !== undefined && !validText(patch.goal, 2_000)
      || patch.lifecycle !== undefined && !lifecycles.includes(patch.lifecycle)
      || patch.title === undefined && patch.goal === undefined && patch.lifecycle === undefined) throw invalid();
    patch = { ...patch }; actor = Object.freeze({ ...actor });
    return this.transaction(async connection => {
      const record = await this.load(connection, id, 'UPDATE');
      await this.authorize(connection, actor, Object.freeze(record), 'patch');
      if (record.version !== patch.expectedVersion || !Number.isSafeInteger(record.version + 1)) throw new InvestigationStoreError('VERSION_CONFLICT');
      if (record.activeRequestId && (patch.goal !== undefined && patch.goal !== record.goal
        || patch.lifecycle !== undefined && patch.lifecycle !== record.lifecycle))
        throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
      const reopening = ['closed', 'archived'].includes(record.lifecycle)
        && patch.lifecycle !== undefined && ['open', 'waiting'].includes(patch.lifecycle);
      await connection.execute(`UPDATE investigations SET title = ?, goal = ?, lifecycle = ?, problem_status = ?, version = version + 1 WHERE id = ?`,
        [patch.title ?? record.title, patch.goal ?? record.goal, patch.lifecycle ?? record.lifecycle,
          reopening ? 'unconfirmed' : record.problemStatus, id]);
      return this.load(connection, id, 'UPDATE');
    });
  }

  /** Only persists intent for a running owner. T04 consumes that intent and
   * owns Run termination; queued jobs can be cancelled without an executor. */
  async cancel(actor: InvestigationActor, id: string, requestId: string): Promise<{ accepted: true }> {
    if (!validActor(actor) || !uuid.test(id) || !uuid.test(requestId)) throw invalid();
    return this.cancelTransaction(async connection => {
      const [binding] = await select(connection, 'SELECT session_id FROM investigations WHERE id = ?', [id]);
      if (!binding) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      await connection.execute('SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE', [binding.session_id]);
      const record = await this.load(connection, id, 'UPDATE');
      await this.authorize(connection, Object.freeze({ ...actor }), Object.freeze(record), 'cancel');
      const [request] = await select(connection, 'SELECT * FROM investigation_requests WHERE id = ? AND investigation_id = ? FOR UPDATE', [requestId, id]);
      if (!request) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      const [job] = await select(connection, `SELECT *, (lease_expires_at > NOW() AND lease_owner IS NOT NULL) AS lease_active
        FROM workflow_jobs WHERE id = ? FOR UPDATE`, [request.job_id]);
      if (!job) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
      await connection.execute('UPDATE investigation_requests SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()) WHERE id = ?', [requestId]);
      if (['queued', 'retry'].includes(job.state)) {
        await this.cancelBudget(connection, { investigation: record, requestId,
          actor: Object.freeze({ kind: request.actor_kind, id: Number(request.actor_id) }), messageId: request.message_id,
          snapshot: request.request_snapshot, job: { id: request.job_id, state: job.state, attempts: Number(job.attempts),
            fencingToken: Number(job.fencing_token), leaseActive: !!job.lease_active } });
        await connection.execute("UPDATE workflow_jobs SET state = 'cancelled' WHERE id = ?", [request.job_id]);
        if (record.activeRequestId === requestId) await connection.execute(`UPDATE investigations
          SET active_request_id = NULL, lifecycle = 'waiting', version = version + 1 WHERE id = ?`, [id]);
      }
      return { accepted: true };
    });
  }

  private async cancelTransaction<T>(work: (connection: TransactionConnection) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.transaction(work); }
      catch (error) {
        const cause = error instanceof InvestigationStoreError ? error.cause : error;
        if (attempt >= 2 || (cause as { code?: string })?.code !== 'ER_LOCK_DEADLOCK') throw error;
      }
    }
  }

  async admit(input: InvestigationAdmission): Promise<InvestigationAcceptance> {
    input = input && { ...input, actor: { ...input.actor } };
    return this.transaction(async (connection, append) => (await this.admitInTransaction(connection, append, input)).acceptance);
  }

  /** T03 may compose its authorized append using this same connection, after
   * checking isNew; never append on an idempotent retry. Attach message_id to
   * the new request in that same transaction; its snapshot contains the message.
   * No nested transaction and no second queue owner. */
  async admitInTransaction(connection: TransactionConnection,
    append: (event: OutboxInput) => Promise<string>,
    input: InvestigationAdmission): Promise<InvestigationAdmissionResult> {
    validate(input);
    input = { ...input, actor: { ...input.actor } };
    if (typeof this.authorize !== 'function') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    // All fields are primitives in fixed order. Freeze the caller's command,
    // not a newly resolved Profile version that could change on a retry.
    const requestHash = createHash('sha256').update(JSON.stringify([
      input.investigationId, input.message, input.expectedVersion,
      ...(input.continuationOf ? [input.continuationOf.requestId, input.continuationOf.runId, input.continuationOf.resultVersion, input.continuationOf.notAfter ?? null] : []),
    ])).digest('hex');
    const key = Buffer.from(input.idempotencyKey, 'utf8');
    const keyValues = [input.actor.kind, input.actor.id, key];
    // Lock order: actor/key -> Session -> investigation -> request. An actor/key lock
    // also serializes first-use retries across different investigations.
    await connection.execute(`INSERT INTO investigation_admission_keys (actor_kind, actor_id, idempotency_key)
      VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id`, keyValues);
    const [reservation] = await select(connection, `SELECT request_id FROM investigation_admission_keys
      WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ? FOR UPDATE`, keyValues);
    const [binding] = await select(connection, 'SELECT session_id FROM investigations WHERE id = ?', [input.investigationId]);
    if (!binding) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
    await connection.execute('SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE', [binding.session_id]);
    const [row] = await select(connection, 'SELECT * FROM investigations WHERE id = ? FOR UPDATE', [input.investigationId]);
    if (!row) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
    const investigation = await this.map(connection, row);
    await this.authorize(connection, Object.freeze(input.actor), Object.freeze(investigation), 'admit');
    if (reservation.request_id) {
      const [previous] = await select(connection,
        'SELECT * FROM investigation_requests WHERE id = ? FOR UPDATE', [reservation.request_id]);
      if (!previous) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
      if (previous.request_hash !== requestHash) throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
      return { isNew: false, acceptance: { investigationId: previous.investigation_id, sessionId: investigation.sessionId,
        requestId: previous.id, jobId: previous.job_id, version: Number(previous.accepted_version) } };
    }
    if (row.active_request_id) throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
    if (investigation.version !== input.expectedVersion) throw new InvestigationStoreError('VERSION_CONFLICT');
    if (['closed', 'archived'].includes(investigation.lifecycle)) throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    const [latestRun] = await select(connection, `SELECT r.state FROM agent_runs r JOIN investigation_requests q
      ON r.idempotency_key=CONCAT('investigation:',q.id) WHERE q.investigation_id=? ORDER BY q.accepted_version DESC LIMIT 1 FOR UPDATE`, [investigation.id]);
    if (input.continuationOf) await assertKnownPartial(connection, investigation.id, input.continuationOf);
    else if (latestRun?.state === 'partial') throw new InvestigationStoreError('VERSION_CONFLICT');
    const version = investigation.version + 1;
    if (!Number.isSafeInteger(version)) throw new InvestigationStoreError('VERSION_CONFLICT');
    const requestId = randomUUID();
    const jobId = randomUUID();
    const jobKey = `investigation.execute:${requestId}`;
    // Only IDs go in the Workflow queue; the immutable request owns the
    // execution snapshot. No Agent Run is fabricated at admission time.
    const snapshot = { ...investigation, problemStatus: 'unconfirmed' as const, actor: { ...input.actor }, message: input.message,
      ...(input.continuationOf ? { continuationOf: structuredClone(input.continuationOf) } : {}) };
    await connection.execute(`INSERT INTO investigation_requests
      (id, investigation_id, actor_kind, actor_id, idempotency_key, request_hash, request_snapshot, job_id, accepted_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [requestId, input.investigationId, ...keyValues, requestHash, JSON.stringify(snapshot), jobId, version]);
    const eventId = await append({ eventType: 'investigation.request.accepted', schemaVersion: 1,
      aggregateType: 'investigation', aggregateId: investigation.id, aggregateVersion: version,
      payload: { requestId, jobId, version }, idempotencyKey: jobKey });
    await connection.execute(`INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key)
      VALUES (?, 'investigation.execute', 1, ?, ?)`, [jobId, JSON.stringify({ investigationId: investigation.id, requestId }), jobKey]);
    // Match the existing report/Analysis durable-delivery pattern: the job
    // and outbox publication are committed together by this single owner.
    await connection.execute('UPDATE outbox_events SET published_at = NOW() WHERE id = ?', [eventId]);
    await connection.execute(`UPDATE investigations SET active_request_id = ?, version = ?, lifecycle = 'open', problem_status = 'unconfirmed' WHERE id = ?`,
      [requestId, version, investigation.id]);
    await connection.execute(`UPDATE investigation_admission_keys SET request_id = ?
      WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ?`, [requestId, ...keyValues]);
    return { isNew: true, acceptance: { investigationId: investigation.id, sessionId: investigation.sessionId, requestId, jobId, version } };
  }
}
