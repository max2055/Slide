import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { ChatDatabaseService, type ChatMessageRecord } from '../chat-database-service.js';
import { recordMessageParts } from '../adapter/message-parts.js';
import { InvestigationAuthorization, freezeInvestigationCaller, type InvestigationAuthoritySnapshot } from './authorization.js';
import { MysqlInvestigationStore, InvestigationStoreError, type InvestigationAdmission, type InvestigationCreate,
  type InvestigationAcceptance, type InvestigationRecord } from './store.js';
import type { TransactionConnection, OutboxInput } from '../workflows/outbox-service.js';

type RequestCommand = Omit<InvestigationAdmission, 'actor'>;
type CreateCommand = Omit<InvestigationCreate, 'actor'>;

/** Server-owned bridge. The actor is a verified ActorContext, never the actor
 * field of a client command. One store owns admission/queue delivery. */
export class InvestigationSessionBridge {
  private readonly chat: ChatDatabaseService;
  constructor(private readonly poolProvider: () => Pool | null,
    private readonly authorization = new InvestigationAuthorization()) {
    this.chat = new ChatDatabaseService(poolProvider, authorization);
  }

  storeFor(actor: ActorContext): MysqlInvestigationStore {
    return new MysqlInvestigationStore(this.poolProvider, this.authorization.forActor(actor));
  }

  async create(actor: ActorContext, command: CreateCommand,
    firstRequest?: Omit<RequestCommand, 'investigationId' | 'expectedVersion'>): Promise<{ investigation: InvestigationRecord; acceptance?: InvestigationAcceptance }> {
    actor = freezeInvestigationCaller(actor);
    const input = { ...command, actor: { kind: actor.principalKind ?? 'user', id: actor.userId },
      resources: command.resources.map(ref => ({ ...ref })) };
    const first = firstRequest && { ...firstRequest };
    const store = this.storeFor(actor);
    return store.transaction(async (connection, append) => {
      const investigation = await store.createInTransaction(connection, input);
      if (!first) return { investigation };
      const acceptance = await this.admitOnConnection(actor, store, connection, append,
        { ...first, investigationId: investigation.id, expectedVersion: investigation.version });
      return { investigation: { ...investigation, version: acceptance.version, activeRequestId: acceptance.requestId }, acceptance };
    });
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
    const authority = this.authorization.freeze(await this.authorization.authorize(connection, actor, investigation, 'continue'));
    const [rows] = await connection.execute('SELECT request_snapshot FROM investigation_requests WHERE id = ? FOR UPDATE', [acceptance.requestId]) as [RowDataPacket[], unknown];
    const snapshot = typeof rows[0].request_snapshot === 'string' ? JSON.parse(rows[0].request_snapshot) : rows[0].request_snapshot;
    await connection.execute('UPDATE investigation_requests SET request_snapshot = ? WHERE id = ?',
      [JSON.stringify({ ...snapshot, authority }), acceptance.requestId]);
    await this.chat.appendInvestigationMessage(actor, acceptance.investigationId, acceptance.version, acceptance.requestId,
      { messageId: randomUUID(), role: 'user', content: command.message }, connection);
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
