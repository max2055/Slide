import { createHash, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { OutboxService, type TransactionPool } from '../workflows/outbox-service.js';
import { ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge, investigationBudgetConfiguration } from './session-bridge.js';
import { MysqlInvestigationBudgetLedger } from './budget-ledger.js';
import { MysqlOperationalEventIngest } from './event-ingest.js';
import { investigationBridgeFlags, databaseAlertPilotConfiguration } from './bridge-flags.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import type { TriggerBinding } from './trigger-policy.js';

export interface DatabaseAlertSource {
  id: number; instance_id: number | null; server_id?: number | null; network_device_id?: number | null;
  title: string; message: string; level: string; created_at: Date | string; metric_name: string | null;
}
export interface AlertBridgeResponse {
  success: boolean; analysisId?: number; sessionKey?: string; status?: string; error?: string;
  investigationId?: string; id?: string; requestId?: string; disposition?: string;
}
type FrozenCommand = { trigger: 'manual' | 'auto'; actor?: ActorContext; alert: DatabaseAlertSource };
const parse = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
const localQueues = new WeakMap<Pool, Map<number, Promise<void>>>();

// These callbacks only commit durable, unsent admission intents. InnoDB
// deadlock victims are rolled back by their transaction owner before retry;
// transport/commit uncertainty and provider failures are never replayed.
async function retryAdmission<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if ((error as { code?: string }).code !== 'ER_LOCK_DEADLOCK' || attempt >= 3) throw error;
      // Desynchronize victims of the same InnoDB gap-lock conflict instead of
      // immediately recreating the whole collision on each bounded attempt.
      await delay(randomInt(10, 31) * 2 ** attempt);
    }
  }
}

/** All database RCA entrances share this source owner. The committed lane is
 * retained even when acceptance is uncertain: rollback never starts a second
 * owner. Named locks serialize the two independent legacy/new transactions;
 * their durable idempotency keys recover a crash before attaching the link. */
export class DatabaseAlertBridge {
  constructor(private readonly poolProvider: () => Pool | null,
    private readonly contexts = new ActorContextService(),
    private readonly authorization = new InvestigationAuthorization(contexts),
    private readonly bridge = new InvestigationSessionBridge(poolProvider, authorization),
    private readonly flags = investigationBridgeFlags,
    private readonly pilot = databaseAlertPilotConfiguration,
    private readonly budget = investigationBudgetConfiguration) {}

  /** legacy is a trusted, durable unsent-admission callback. It must use the
   * supplied idle connection for ALL SQL and never invoke a provider inline. */
  async dispatch(alert: DatabaseAlertSource, trigger: 'manual' | 'auto', caller: ActorContext | undefined,
    legacy: (connection: PoolConnection) => Promise<AlertBridgeResponse>, retryOf?: number): Promise<AlertBridgeResponse> {
    if (!Number.isSafeInteger(alert.id) || alert.id <= 0 || !alert.instance_id || alert.server_id || alert.network_device_id)
      throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
    const pool = this.poolProvider();
    if (!pool) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    // Avoid local GET_LOCK waiters. Every winner uses its reserved connection
    // for admission too, so different sources never wait on a second pool slot.
    const queues = localQueues.get(pool) ?? new Map<number, Promise<void>>(); localQueues.set(pool, queues);
    const previous = queues.get(alert.id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => release = resolve);
    queues.set(alert.id, next); await previous;
    try { return await this.dispatchLocked(pool, alert, trigger, caller, legacy, retryOf); }
    finally { release(); if (queues.get(alert.id) === next) queues.delete(alert.id); }
  }

  private async dispatchLocked(pool: Pool, alert: DatabaseAlertSource, trigger: 'manual' | 'auto', caller: ActorContext | undefined,
    legacy: (connection: PoolConnection) => Promise<AlertBridgeResponse>, retryOf?: number): Promise<AlertBridgeResponse> {
    const c = await pool.getConnection();
    let lock = '';
    const authorityConnection = c as unknown as import('../workflows/outbox-service.js').TransactionConnection;
    let locked = false;
    try {
      const [database] = await c.query<RowDataPacket[]>('SELECT DATABASE() AS name');
      lock = `slide-alert:${createHash('sha256').update(`${database[0].name}:${alert.id}`).digest('hex').slice(0, 48)}`;
      const [locks] = await c.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lock]);
      if (Number(locks[0].acquired) !== 1) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
      locked = true;
      // Before exposing a cached ID, revalidate the actual HTTP user's scope.
      if (caller) await this.authorizeSubject(authorityConnection, caller, alert);
      if (retryOf !== undefined) {
        const [previous] = await c.execute<RowDataPacket[]>(`SELECT a.*, d.request_snapshot FROM ai_analysis a
          LEFT JOIN analysis_dispatches d ON d.analysis_id=a.id WHERE a.id=?`, [retryOf]);
        const row = previous[0], request = row && parse(row.request_snapshot);
        if (!caller || !row || row.analysis_type !== 'alert_rca' || Number(row.related_id) !== alert.id
          || Number(row.instance_id) !== alert.instance_id || row.trigger_type !== 'auto' && Number(request?.actor?.userId) !== caller.userId)
          throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      }
      const [owners] = await c.execute<RowDataPacket[]>('SELECT * FROM investigation_alert_owners WHERE alert_id=?', [alert.id]);
      let owner = owners[0];
      if (!owner) {
        const [historical] = await c.execute<RowDataPacket[]>(`SELECT a.id FROM ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id=a.id
          WHERE a.analysis_type='alert_rca' AND a.related_id=? AND a.instance_id=?
          AND (a.trigger_type='auto' OR JSON_EXTRACT(d.request_snapshot,'$.actor.userId')=? OR a.status IN ('pending','running','unknown'))
          AND a.status IN ('pending','running','unknown','completed') ORDER BY a.id DESC LIMIT 1`, [alert.id, alert.instance_id, caller?.userId ?? 0]);
        const flags = this.flags(), pilot = this.pilot();
        const enabled = trigger === 'manual' ? flags.manual : flags.opsAuto;
        const lane = historical.length || !enabled ? 'legacy' : 'investigation';
        let actor = caller;
        if (lane === 'investigation' && trigger === 'auto') {
          if (!pilot.configured || !pilot.instanceIds.includes(alert.instance_id))
            return { success: false, status: 'suppressed', error: 'DATABASE_ALERT_PILOT_UNCONFIGURED' };
          const live = await this.contexts.loadInvestigationActorFrom(authorityConnection, pilot.serviceUserId, 'service');
          actor = { ...live, resourceBoundary: { instanceIds: [alert.instance_id], serverIds: [], networkDeviceIds: [] } };
          await this.authorizeSubject(authorityConnection, actor, alert);
        }
        if (lane === 'investigation' && !actor) throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
        const command: FrozenCommand = { trigger, actor, alert: structuredClone(alert) };
        // Autocommit precedes execution. Failure cannot erase a chosen lane.
        await c.execute('INSERT INTO investigation_alert_owners (alert_id,lane,command_snapshot,analysis_id) VALUES (?,?,?,?)',
          [alert.id, lane, JSON.stringify(command), historical[0]?.id ?? null]);
        owner = { lane, command_snapshot: command, investigation_id: null, analysis_id: historical[0]?.id ?? null } as RowDataPacket;
      }
      if (owner.lane === 'legacy') {
        // Old active/unknown work is never adopted into an investigation job.
        if (owner.analysis_id) {
          const [old] = await c.execute<RowDataPacket[]>(`SELECT a.status,a.trigger_type,a.session_key,d.request_snapshot
            FROM ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id=a.id WHERE a.id=?`, [owner.analysis_id]);
          const row = old[0], request = row && parse(row.request_snapshot);
          if (row?.trigger_type !== 'auto' && Number(request?.actor?.userId) !== caller?.userId)
            throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
          if (row && ['pending','running','unknown'].includes(row.status) && retryOf !== Number(owner.analysis_id))
            return { success: row.status !== 'unknown', analysisId: Number(owner.analysis_id), sessionKey: row.session_key ?? undefined,
              status: row.status, ...(row.status === 'unknown' ? { error: 'ANALYSIS_PROVIDER_RESULT_UNKNOWN' } : {}) };
        }
        const result = await retryAdmission(() => legacy(c));
        if (result.analysisId) await c.execute('UPDATE investigation_alert_owners SET analysis_id=? WHERE alert_id=? AND lane=\'legacy\'', [result.analysisId, alert.id]);
        return result;
      }
      const command = parse(owner.command_snapshot) as FrozenCommand;
      if (!command.actor) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
      let id = owner.investigation_id as string | null;
      let response: AlertBridgeResponse;
      if (id) response = { success: true, investigationId: id, id };
      else if (command.trigger === 'auto') {
        const config = this.budget();
        const binding: TriggerBinding = { source: 'database-alert-engine', verified: true, allowedOrigins: ['collector'],
          policy: { id: 'database-alert-pilot', version: 1, domain: config.domain, actor: command.actor,
            profileId: 'ops', profileVersion: 1, resources: [{ type: 'instance', id: command.alert.instance_id!, role: 'primary' }],
            kinds: ['database_alert'], threshold: 1, windowMs: 300_000, cooldownMs: 300_000, criticalSingle: true,
            reserveTokens: 32_000, reserveCostMicros: config.reserveCostMicros } };
        const ingest = new MysqlOperationalEventIngest(this.poolProvider, binding,
          new MysqlInvestigationBudgetLedger(this.poolProvider, config.policy), this.authorization, this.bridge);
        const receipt = await ingest.ingest({ schemaVersion: 1, sourceEventId: `alert:${command.alert.id}`, kind: 'database_alert',
          subject: { kind: 'resource', resource: { type: 'instance', id: command.alert.instance_id! } },
          occurredAt: new Date(command.alert.created_at).toISOString(), severity: command.alert.level as 'warning' | 'error' | 'critical',
          summary: command.alert.title.slice(0, 2_000), origin: 'collector', stableErrorCode: command.alert.metric_name ?? 'DATABASE_ALERT', callsite: 'alert-engine' }, authorityConnection);
        id = receipt.investigationId;
        response = { success: !!id, ...(id ? { investigationId: id, id } : {}), requestId: receipt.requestId ?? undefined,
          disposition: receipt.disposition, status: id ? 'pending' : 'suppressed', ...(receipt.suppressionReason ? { error: receipt.suppressionReason } : {}) };
      } else {
        const key = `database-alert:${command.alert.id}`;
        const result = await retryAdmission(() => new OutboxService(pool as unknown as TransactionPool).transactionOnConnection(authorityConnection,
          (connection, append) => this.bridge.createOnConnection(command.actor!, connection, append, { title: command.alert.title.slice(0, 200),
          goal: '只读调查数据库告警，引用事实并说明证据缺口。', profileId: 'ops', profileVersion: 1,
          resources: [{ type: 'instance', id: command.alert.instance_id!, role: 'primary' }], idempotencyKey: key,
          context: { subject: { kind: 'resource', resource: { type: 'instance', id: command.alert.instance_id! } } } },
        { idempotencyKey: key, message: `${command.alert.title}\n${command.alert.message}`.slice(0, 2_000) }))).catch(error => {
          if (error instanceof InvestigationStoreError) throw error;
          throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE', error);
        });
        id = result.investigation.id;
        response = { success: true, id, investigationId: id, requestId: result.acceptance?.requestId, status: 'pending' };
      }
      if (id) {
        await c.execute('UPDATE investigation_alert_owners SET investigation_id=? WHERE alert_id=? AND lane=\'investigation\'', [id, alert.id]);
        const inv = await this.authorization.load(authorityConnection, id);
        // Automatic producers need live source authority even on link reuse.
        await this.authorization.authorize(authorityConnection, command.actor, inv, 'content');
        if (caller) {
          if (inv.owner.id !== caller.userId) await c.execute(`INSERT INTO investigation_members (investigation_id,user_id,role,granted_by)
            VALUES (?,?,'viewer',?) ON DUPLICATE KEY UPDATE user_id=user_id`, [id, caller.userId, inv.owner.id]);
          await this.authorization.authorize(authorityConnection, caller, inv, 'content');
        }
      }
      return response;
    } finally {
      try { if (locked) await c.execute('SELECT RELEASE_LOCK(?)', [lock]); }
      catch { c.destroy(); }
      c.release();
    }
  }

  private authorizeSubject(c: Pick<import('../workflows/outbox-service.js').TransactionConnection, 'execute'>, actor: ActorContext, alert: DatabaseAlertSource) {
    const inv: AdmissionInvestigation = { id: 'alert-read', sessionId: 'alert-read', profileId: 'ops', profileVersion: 1,
      scopeVersion: '', version: 1, lifecycle: 'open', owner: { kind: actor.principalKind ?? 'user', id: actor.userId },
      resources: [{ type: 'instance', id: alert.instance_id!, role: 'primary' }] };
    return this.authorization.authorize(c, actor, inv, 'content');
  }
}
export const databaseAlertBridge = new DatabaseAlertBridge(() => dbConnection.getPool());
