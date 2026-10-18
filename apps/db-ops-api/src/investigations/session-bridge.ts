import { assertContinuationDeadline } from './continuation.js';
import { isDeepStrictEqual } from 'node:util';
import { MysqlInvestigationBudgetLedger, type BudgetPolicy } from './budget-ledger.js';
import { resolveInvestigationProfile } from './profiles.js';
import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { ChatDatabaseService, type ChatMessageRecord } from '../chat-database-service.js';
import { recordMessageParts } from '../adapter/message-parts.js';
import { InvestigationAuthorization, freezeInvestigationCaller, type InvestigationAuthoritySnapshot } from './authorization.js';
import { MysqlInvestigationStore, InvestigationStoreError, type InvestigationAdmission, type InvestigationCreate,
  type InvestigationAcceptance, type InvestigationRecord, type InvestigationCancellation } from './store.js';
import type { TransactionConnection, OutboxInput } from '../workflows/outbox-service.js';
import { InvestigationStreamStore } from './stream.js';
import { InvestigationEvidenceStore } from './evidence-store.js';
import { InvestigationResultStore } from './result-schema.js';
import { CanonicalStore } from '../adapter/canonical-store.js';
import { publicDocument } from './stream.js';

type RequestCommand = Omit<InvestigationAdmission, 'actor'>;
type CreateCommand = Omit<InvestigationCreate, 'actor'>;

/** One trusted configuration for HTTP cancellation and Workflow execution. */
export function investigationBudgetConfiguration() {
  return { domain: 'investigation-v1', reserveCostMicros: Number(process.env.INVESTIGATION_RESERVED_COST_MICROS ?? 1_000_000),
    policy: { currency: 'USD', maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2,
      maxAutomaticRequestsPerHour: 20, maxAutomaticTokensPerDay: 256_000, maxTotalTokensPerDay: 1_000_000,
      maxCostMicrosPerDay: Number(process.env.INVESTIGATION_DAILY_COST_MICROS ?? 10_000_000) } };
}

/** Server-owned bridge. The actor is a verified ActorContext, never the actor
 * field of a client command. One store owns admission/queue delivery. */
export class InvestigationSessionBridge {
  private readonly chat: ChatDatabaseService;
  private readonly ledger: MysqlInvestigationBudgetLedger;
  private readonly budgetDomain: string;
  private readonly reserveCostMicros: number;
  constructor(private readonly poolProvider: () => Pool | null,
    private readonly authorization = new InvestigationAuthorization(),
    cancellationBudget: { domain: string; policy: BudgetPolicy; reserveCostMicros?: number } = investigationBudgetConfiguration()) {
    this.chat = new ChatDatabaseService(poolProvider, authorization);
    this.budgetDomain = cancellationBudget.domain;
    this.reserveCostMicros = cancellationBudget.reserveCostMicros ?? investigationBudgetConfiguration().reserveCostMicros;
    this.ledger = new MysqlInvestigationBudgetLedger(poolProvider, cancellationBudget.policy);
  }

  storeFor(actor: ActorContext): MysqlInvestigationStore {
    return new MysqlInvestigationStore(this.poolProvider, this.authorization.forActor(actor),
      (connection, cancellation) => this.cancelBudgetOnConnection(connection, cancellation));
  }

  /** Minimal read-side composition reuses this exact configured pool and live
   * authority. Tests/workers must never fall back to another global database. */
  observationServices() {
    return { stream: new InvestigationStreamStore(this.poolProvider, this.authorization),
      evidence: new InvestigationEvidenceStore(this.poolProvider, this.authorization),
      results: new InvestigationResultStore(this.poolProvider, this.authorization) };
  }
  async facts(actor: ActorContext, id: string, limit = 200, before?: string) {
    return this.storeFor(actor).transaction(async c => {
      const page = await new CanonicalStore(this.poolProvider as never, this.authorization).getObservationPage(c as never, actor, id, limit, before);
      return { documents: page.messages.flatMap(m => m.messageParts ? [publicDocument(m.messageParts)] : []), nextBefore: page.nextBefore };
    });
  }

  private async cancelBudgetOnConnection(connection: TransactionConnection, value: Readonly<InvestigationCancellation>): Promise<void> {
    const snapshot = typeof value.snapshot === 'string' ? JSON.parse(value.snapshot) : value.snapshot as any;
    const investigation = value.investigation;
    if (!snapshot || snapshot.id !== investigation.id || snapshot.sessionId !== investigation.sessionId
      || snapshot.profileId !== investigation.profileId || snapshot.profileVersion !== investigation.profileVersion
      || !isDeepStrictEqual(snapshot.actor, value.actor) || !isDeepStrictEqual(snapshot.authority?.actor, value.actor)
      || snapshot.authority?.investigationId !== investigation.id || snapshot.authority?.sessionId !== investigation.sessionId
      || !value.messageId || value.job.leaseActive)
      throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    // Run locks come after Job, before the ledger domain, as in the executor.
    // Any prior Run is conservatively uncertain here, even a reserved allocation:
    // cancelling a retry must never erase a persisted/unconfirmed provider intent.
    const [runs] = await connection.execute('SELECT * FROM agent_runs WHERE idempotency_key = ? FOR UPDATE',
      [`investigation:${value.requestId}`]) as [RowDataPacket[], unknown];
    for (const run of runs) {
      const result = typeof run.result_json === 'string' ? JSON.parse(run.result_json) : run.result_json;
      const execution = result?.investigationExecution;
      if (run.actor_id !== value.actor.id || run.session_id !== investigation.sessionId || run.message_id !== value.messageId
        || execution && (execution.requestId !== value.requestId || execution.jobId !== value.job.id
          || !Number.isSafeInteger(execution.fencingToken) || execution.fencingToken > value.job.fencingToken))
        throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    }
    const mode = value.actor.kind === 'service' ? 'automatic' : 'manual';
    if (!snapshot.budgetReceipt) {
      // A trusted manual request before its first reservation stays compatible.
      // A removed receipt on either lane is never interpreted as refundable.
      const [allocations] = await connection.execute('SELECT id FROM investigation_budget_ledger WHERE request_id = ? FOR UPDATE',
        [value.requestId]) as [RowDataPacket[], unknown];
      if (mode === 'automatic' || allocations.length) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
      return;
    }
    const reservation = await this.ledger.reuseExecutionInTransaction(connection, value.requestId,
      { domain: this.budgetDomain, mode, profile: resolveInvestigationProfile(investigation.profileId, investigation.profileVersion) });
    if (reservation.state === 'settled' || reservation.state === 'cancelled') return;
    if (!runs.length && reservation.state === 'reserved')
      await this.ledger.cancelUnsentInTransaction(connection, reservation.id);
    else await this.ledger.retainUnknownInTransaction(connection, reservation.id);
  }

  async create(actor: ActorContext, command: CreateCommand,
    firstRequest?: Omit<RequestCommand, 'investigationId' | 'expectedVersion'>): Promise<{ investigation: InvestigationRecord; acceptance?: InvestigationAcceptance }> {
    actor = freezeInvestigationCaller(actor);
    const input = { ...command, actor: { kind: actor.principalKind ?? 'user', id: actor.userId },
      resources: command.resources.map(ref => ({ ...ref })) };
    const first = firstRequest && { ...firstRequest };
    const store = this.storeFor(actor);
    return store.transaction((connection, append) => this.createOnConnection(actor, connection, append, input, first));
  }

  /** Trusted internal composition only. Caller owns the transaction and may
   * roll back create/admit/message together with budget and event decisions. */
  async createOnConnection(actor: ActorContext, connection: TransactionConnection,
    append: (event: OutboxInput) => Promise<string>, command: CreateCommand,
    firstRequest?: Omit<RequestCommand, 'investigationId' | 'expectedVersion'>): Promise<{ investigation: InvestigationRecord; acceptance?: InvestigationAcceptance }> {
    actor = freezeInvestigationCaller(actor);
    const store = this.storeFor(actor);
    const investigation = await store.createInTransaction(connection,
      { ...command, actor: { kind: actor.principalKind ?? 'user', id: actor.userId }, resources: command.resources.map(ref => ({ ...ref })) });
    if (!firstRequest) return { investigation };
    const acceptance = await this.admitOnConnection(actor, store, connection, append,
      { ...firstRequest, investigationId: investigation.id, expectedVersion: investigation.version });
    return { investigation: { ...investigation, version: acceptance.version, activeRequestId: acceptance.requestId }, acceptance };
  }

  async admit(actor: ActorContext, command: RequestCommand): Promise<InvestigationAcceptance> {
    actor = freezeInvestigationCaller(actor);
    const input = { ...command };
    const store = this.storeFor(actor);
    return store.transaction((connection, append) => this.admitOnConnection(actor, store, connection, append, input));
  }

  private async admitOnConnection(actor: ActorContext, store: MysqlInvestigationStore, connection: TransactionConnection,
    append: (event: OutboxInput) => Promise<string>, command: RequestCommand): Promise<InvestigationAcceptance> {
    const { acceptance, isNew } = await store.admitInTransaction(connection, append,
      { ...command, actor: { kind: actor.principalKind ?? 'user', id: actor.userId } });
    if (!isNew) return acceptance;
    const investigation = await this.authorization.load(connection, acceptance.investigationId);
    // HTTP caller authorizes admission, while an automatic predecessor keeps
    // its original service ceiling. A human JWT never upgrades execution.
    let executionActor = actor;
    let frozen: InvestigationAuthoritySnapshot | undefined;
    if (command.continuationOf) {
      const [previous] = await connection.execute('SELECT actor_kind, actor_id, request_snapshot FROM investigation_requests WHERE id = ? FOR UPDATE',
        [command.continuationOf.requestId]) as [RowDataPacket[], unknown];
      if (previous[0]?.actor_kind === 'service') {
        const prior = typeof previous[0].request_snapshot === 'string' ? JSON.parse(previous[0].request_snapshot) : previous[0].request_snapshot;
        frozen = prior?.authority;
        if (!frozen || frozen.actor.kind !== 'service' || frozen.actor.id !== Number(previous[0].actor_id))
          throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
        const current = await new ActorContextService().loadInvestigationActorFrom(connection,
          frozen.actor.id, 'service', frozen.sessionVersion);
        executionActor = { ...current, permissions: frozen.permissions, instanceScopes: frozen.instanceScopes,
          resourceBoundary: frozen.resourceBoundary };
      }
    }
    const authorized = await this.authorization.authorize(connection, executionActor, investigation, 'continue', [], frozen);
    if (frozen) executionActor = authorized.actor;
    const authority = this.authorization.freeze(authorized);
    const executionSubject = { kind: executionActor.principalKind ?? 'user', id: executionActor.userId };
    const [rows] = await connection.execute('SELECT request_snapshot FROM investigation_requests WHERE id = ? FOR UPDATE', [acceptance.requestId]) as [RowDataPacket[], unknown];
    const snapshot = typeof rows[0].request_snapshot === 'string' ? JSON.parse(rows[0].request_snapshot) : rows[0].request_snapshot;
    await connection.execute('UPDATE investigation_requests SET actor_kind = ?, actor_id = ?, request_snapshot = ? WHERE id = ?',
      [executionSubject.kind, executionSubject.id, JSON.stringify({ ...snapshot, actor: executionSubject, authority,
        ...(frozen ? { continuationOperator: { kind: actor.principalKind ?? 'user', id: actor.userId } } : {}) }), acceptance.requestId]);
    await this.chat.appendInvestigationMessage(executionActor, acceptance.investigationId, acceptance.version, acceptance.requestId,
      { messageId: randomUUID(), role: 'user', content: command.message }, connection);
    if (frozen) {
      const profile = resolveInvestigationProfile(investigation.profileId, investigation.profileVersion);
      const reservation = await this.ledger.reserveExecutionInTransaction(connection, { requestId: acceptance.requestId,
        domain: this.budgetDomain, mode: 'automatic', profile, reserveTokens: profile.budget.maxTokens,
        reserveCostMicros: this.reserveCostMicros });
      if (!reservation.accepted) throw new InvestigationStoreError('INVESTIGATION_BUDGET_EXHAUSTED');
    }
    await assertContinuationDeadline(connection, command.continuationOf?.notAfter);
    return acceptance;
  }

  async messages(actor: ActorContext, investigationId: string, limit = 200): Promise<ChatMessageRecord[]> {
    actor = freezeInvestigationCaller(actor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
    return this.storeFor(actor).transaction(async connection => {
      const investigation = await this.authorization.load(connection, investigationId);
      await this.authorization.authorize(connection, actor, investigation, 'content');
      const [rows] = await connection.execute(`SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
        [investigation.sessionId, limit]) as [RowDataPacket[], unknown];
      return rows.reverse().map(row => ({ ...row, sequence: Number(row.id), messageParts: recordMessageParts(row as never).messageParts })) as ChatMessageRecord[];
    });
  }

  /** Execution consumers revalidate persisted authority immediately before
   * use. This does not run models, cancel workers, or implement WS delivery. */
  async requestAuthority(actor: ActorContext, investigationId: string, requestId: string): Promise<InvestigationAuthoritySnapshot> {
    actor = freezeInvestigationCaller(actor);
    return this.storeFor(actor).transaction(async connection => {
      const investigation = await this.authorization.load(connection, investigationId);
      await this.authorization.authorize(connection, actor, investigation, 'content');
      const [rows] = await connection.execute(`SELECT request_snapshot FROM investigation_requests
        WHERE id = ? AND investigation_id = ? FOR SHARE`, [requestId, investigationId]) as [RowDataPacket[], unknown];
      if (!rows[0]) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      const snapshot = typeof rows[0].request_snapshot === 'string' ? JSON.parse(rows[0].request_snapshot) : rows[0].request_snapshot;
      const authority = snapshot.authority as InvestigationAuthoritySnapshot | undefined;
      if (!authority) throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
      await this.authorization.authorize(connection, actor, investigation, 'content', [], authority);
      return Object.freeze({ ...authority, actor: Object.freeze({ ...authority.actor }),
        permissions: Object.freeze([...authority.permissions]), instanceScopes: Object.freeze({ ...authority.instanceScopes }),
        resourceBoundary: Object.freeze({ instanceIds: Object.freeze([...authority.resourceBoundary.instanceIds]),
          serverIds: Object.freeze([...authority.resourceBoundary.serverIds]), networkDeviceIds: Object.freeze([...authority.resourceBoundary.networkDeviceIds]) }),
        toolAllowlist: Object.freeze([...authority.toolAllowlist]) });
    });
  }
}
