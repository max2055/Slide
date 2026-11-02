import { actorContextService, type ActorContext } from '../auth/actor-context.js';
import { canReadResource, canManageResource } from '../resources/resource-service.js';
import { rule } from '../metrics/policy/model.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { dbConnection, encryptData, decryptData } from '../db-connection.js';
import type { NotificationChannel } from '../notification-database-service.js';
import type { ClaimedJob, JobExecutionContext } from './worker-runtime.js';
import type { RolloutAlertFence } from '../metrics/rollout/alert-publication-fence.js';

export interface DeliveryRequest { channel: NotificationChannel; message: unknown; rolloutFence?: RolloutAlertFence }
export interface DeliveryClaim { key: string; attemptId: string; request: DeliveryRequest; retryDeadline?: number }
export type DeliveryFinishState = 'sent' | 'unknown' | 'retryable' | 'skipped';
export interface DeliveryGate {
  preflightFailed(job: ClaimedJob, context: JobExecutionContext): Promise<void>;
  snapshot(key: string): Promise<DeliveryRequest | null>;
  acquire(job: ClaimedJob, context: JobExecutionContext, request: DeliveryRequest | null): Promise<DeliveryClaim | null>;
  finish(job: ClaimedJob, context: JobExecutionContext, claim: DeliveryClaim, state: DeliveryFinishState, error?: string): Promise<void>;
}
export function deliveryIdentity(job: Pick<ClaimedJob, 'type' | 'payload'>) {
  const kind = job.type === 'notification.deliver' ? 'notification' : job.type === 'report.notify' ? 'report' : null;
  const sourceId = Number(kind === 'notification' ? job.payload.alertId : job.payload.reportId);
  const channelId = Number(job.payload.channelId);
  if (!kind || !Number.isSafeInteger(sourceId) || sourceId <= 0 || !Number.isSafeInteger(channelId) || channelId <= 0) throw new Error('DELIVERY_PAYLOAD_INVALID');
  const transition = kind === 'notification' ? job.payload.transition as import('./notification-dispatch.js').NotificationTransition | undefined : undefined;
  if (transition && (!['recovery','escalation'].includes(transition.phase) || !/^[a-z0-9-]{1,48}$/.test(transition.id) || !Number.isFinite(Date.parse(transition.at)))) throw new Error('DELIVERY_PAYLOAD_INVALID');
  return { key: `${kind}:${sourceId}:${channelId}${transition ? `:${transition.id}` : ''}`, kind, sourceId, channelId, transition };
}

// Existing attempt tables remain the audit. fencing_token never resets on replay.
const attemptTable = (kind: string) => kind === 'notification' ? 'notification_delivery_attempts' : 'report_notification_deliveries';
const sourceColumn = (kind: string) => kind === 'notification' ? 'alert_id' : 'report_id';

export class MysqlDeliveryStore implements DeliveryGate {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool()) {}
  private pool(): Pool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('DELIVERY_STORE_UNAVAILABLE');
    return pool;
  }
  private async transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.pool().getConnection();
    try { await c.beginTransaction(); const result = await work(c); await c.commit(); return result; }
    catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  private async owned(c: PoolConnection, job: ClaimedJob, context: JobExecutionContext) {
    context.signal.throwIfAborted();
    const [rows] = await c.execute<any[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
      AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`,
    [job.id, context.workerId, context.fencingToken]);
    if (!rows.length || job.fencingToken !== context.fencingToken) throw new Error('DELIVERY_LEASE_LOST');
  }
  async snapshot(key: string): Promise<DeliveryRequest | null> {
    const [rows] = await this.pool().execute<any[]>('SELECT request_encrypted FROM notification_delivery_states WHERE business_key = ?', [key]);
    return rows[0]?.request_encrypted ? JSON.parse(decryptData(rows[0].request_encrypted)) : null;
  }
  async preflightFailed(job: ClaimedJob, context: JobExecutionContext): Promise<void> {
    const identity = deliveryIdentity(job);
    await this.transaction(async c => {
      await this.owned(c, job, context);
      await c.execute(`INSERT INTO notification_delivery_states
        (business_key,kind,source_id,channel_id,state,workflow_job_id,fencing_token,error_code)
        VALUES (?,?,?,?,'retryable',?,?,'DELIVERY_PREPARATION_FAILED') ON DUPLICATE KEY UPDATE business_key = business_key`,
      [identity.key, identity.kind, identity.sourceId, identity.channelId, job.id, job.fencingToken]);
      await c.execute(`INSERT INTO ${attemptTable(identity.kind)}
        (workflow_job_id,${sourceColumn(identity.kind)},channel_id,attempt_number,status,error_code,finished_at)
        VALUES (?,?,?,?,'failed','DELIVERY_PREPARATION_FAILED',NOW())`, [job.id, identity.sourceId, identity.channelId, job.fencingToken]);
    });
  }
  async acquire(job: ClaimedJob, context: JobExecutionContext, request: DeliveryRequest | null): Promise<DeliveryClaim | null> {
    const identity = deliveryIdentity(job);
    // Freeze secrets encrypted at rest. Query routes never return this field.
    const serialized = request ? JSON.stringify(request) : null;
    const acquisitionStarted = Date.now();
    let uncertain = false;
    const result = await this.transaction(async c => {
      await this.owned(c, job, context);
      await c.execute(`INSERT INTO notification_delivery_states
        (business_key,kind,source_id,channel_id,state,workflow_job_id,fencing_token,request_encrypted,request_digest)
        VALUES (?,?,?,?,'ready',?,?,?,?) ON DUPLICATE KEY UPDATE request_encrypted = IF(state = 'retryable' AND request_encrypted IS NULL, VALUES(request_encrypted), request_encrypted),
        request_digest = IF(state = 'retryable' AND request_digest IS NULL, VALUES(request_digest), request_digest)`,
      [identity.key, identity.kind, identity.sourceId, identity.channelId, job.id, job.fencingToken,
        serialized ? encryptData(serialized) : null, serialized ? createHash('sha256').update(serialized).digest('hex') : null]);
      const [rows] = await c.execute<any[]>('SELECT *, idempotent_until > NOW(3) AS can_retry, TIMESTAMPDIFF(MICROSECOND,NOW(3),idempotent_until) DIV 1000 AS retry_remaining_ms FROM notification_delivery_states WHERE business_key = ? FOR UPDATE', [identity.key]);
      const row = rows[0];
      if (!identity.transition && ['ready', 'retryable'].includes(row.state) && !row.attempt_id && row.error_code !== 'RECOVERY_RETRY') {
        // Upgrade safety: old accepted or uncertain sends must not become fresh sends.
        const [legacy] = await c.execute<any[]>(`SELECT status FROM ${attemptTable(identity.kind)}
          WHERE ${sourceColumn(identity.kind)} = ? AND channel_id = ?
          AND COALESCE(error_code, '') <> 'DELIVERY_PREPARATION_FAILED' ORDER BY id DESC LIMIT 1`, [identity.sourceId, identity.channelId]);
        let legacyState = legacy[0] ? (legacy[0].status === 'sent' ? 'sent' : 'unknown') : null;
        if (identity.kind === 'notification') {
          const [sent] = await c.execute<any[]>("SELECT id FROM notification_records WHERE alert_id = ? AND channel_id = ? AND status = 'sent' LIMIT 1", [identity.sourceId, identity.channelId]);
          if (sent.length) legacyState = 'sent';
        }
        if (legacyState) {
          await c.execute('UPDATE notification_delivery_states SET state = ?, version = version + 1, error_code = ? WHERE business_key = ?', [legacyState, 'LEGACY_DELIVERY', identity.key]);
          row.state = legacyState;
        }
      }
      if (['sent', 'skipped', 'failed'].includes(row.state)) return null;
      if (row.state === 'sending') {
        const [owner] = await c.execute<any[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
          AND fencing_token = ? AND lease_expires_at > NOW()`, [row.workflow_job_id, row.fencing_token]);
        if (owner.length) throw new Error('DELIVERY_IN_FLIGHT');
        await this.attemptResult(c, row, 'unknown', 'DELIVERY_INTERRUPTED');
        await c.execute("UPDATE notification_delivery_states SET state = 'unknown', version = version + 1, error_code = 'DELIVERY_INTERRUPTED' WHERE business_key = ?", [identity.key]);
        row.state = 'unknown';
      }
      if (row.state === 'unknown' && !row.can_retry) { uncertain = true; return null; }
      if (!row.request_encrypted) {
        await c.execute("UPDATE notification_delivery_states SET state = 'skipped', version = version + 1, error_code = 'DELIVERY_SOURCE_UNAVAILABLE' WHERE business_key = ?", [identity.key]);
        return null;
      }
      const frozen: DeliveryRequest = JSON.parse(decryptData(row.request_encrypted));
      const retention = frozen.channel.type === 'webhook' && frozen.channel.config.idempotency_contract === 'receiver-deduplicates'
        ? frozen.channel.config.idempotency_retention_seconds : undefined;
      const attemptId = randomUUID();
      context.signal.throwIfAborted();
      await c.execute(`UPDATE notification_delivery_states SET state = 'sending', version = version + 1,
        workflow_job_id = ?, fencing_token = ?, attempt_id = ?, error_code = NULL,
        idempotent_until = COALESCE(idempotent_until, IF(? > 0, DATE_ADD(NOW(3), INTERVAL ? SECOND), NULL)) WHERE business_key = ?`,
      [job.id, job.fencingToken, attemptId, retention ?? 0, retention ?? 0, identity.key]);
      await c.execute(`INSERT INTO ${attemptTable(identity.kind)}
        (workflow_job_id,${sourceColumn(identity.kind)},channel_id,attempt_number,status) VALUES (?,?,?,?,'started')`,
      [job.id, identity.sourceId, identity.channelId, job.fencingToken]);
      return { key: identity.key, attemptId, request: frozen, retryDeadline: row.state === 'unknown' ? acquisitionStarted + Number(row.retry_remaining_ms) : undefined };
    });
    if (uncertain) throw new Error('DELIVERY_RECONCILIATION_REQUIRED');
    return result;
  }
  private async attemptResult(c: PoolConnection, row: any, state: string, error: string | null) {
    await c.execute(`UPDATE ${attemptTable(row.kind)} SET status = ?, error_code = ?, finished_at = NOW()
      WHERE workflow_job_id = ? AND attempt_number = ? AND status = 'started'`, [state, error, row.workflow_job_id, row.fencing_token]);
  }
  async finish(job: ClaimedJob, context: JobExecutionContext, claim: DeliveryClaim, state: DeliveryFinishState, error?: string): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job, context);
      const [rows] = await c.execute<any[]>('SELECT * FROM notification_delivery_states WHERE business_key = ? FOR UPDATE', [claim.key]);
      const row = rows[0];
      if (!row || row.state !== 'sending' || row.attempt_id !== claim.attemptId || row.workflow_job_id !== job.id || Number(row.fencing_token) !== job.fencingToken) throw new Error('DELIVERY_ATTEMPT_STALE');
      if (state === 'sent' && row.kind === 'notification') {
        await c.execute("INSERT INTO notification_records (alert_id,channel_id,status,sent_at) VALUES (?,?,'sent',NOW())", [row.source_id, row.channel_id]);
      }
      await c.execute('UPDATE notification_delivery_states SET state = ?, error_code = ?, version = version + 1 WHERE business_key = ?', [state, error ?? null, claim.key]);
      await this.attemptResult(c, row, state === 'retryable' ? 'failed' : state, error ?? null);
    });
  }
  private async authorize(c:Pool | PoolConnection,job:{type:string;payload:any},actor:ActorContext,write=false,lock=false){
    const live=await actorContextService.revalidateActorOn(c as any,actor,actor.requestId,lock);
    rule(live.permissions.includes('*')||live.permissions.includes(write?'notification:manage':'notification:view')||live.permissions.includes('admin:*'),'DELIVERY_FORBIDDEN',403);
    const identity=deliveryIdentity(job);
    const [rows]=await c.execute<any[]>(`SELECT * FROM ${identity.kind==='notification'?'alerts':'reports'} WHERE id=?`,[identity.sourceId]);
    rule(rows.length,'DELIVERY_NOT_FOUND',404);const a=rows[0];
    const ref=a.instance_id?{type:'instance' as const,id:Number(a.instance_id)}:a.server_id?{type:'server' as const,id:Number(a.server_id)}:a.network_device_id?{type:'network_device' as const,id:Number(a.network_device_id)}:null;
    rule(ref?(write?canManageResource(live,ref):canReadResource(live,ref)):live.permissions.includes('*')&&!live.resourceBoundary,'DELIVERY_FORBIDDEN',403);
    return ref;
  }
  async replay(jobId:string,actor:ActorContext,reason:string){
    rule(typeof reason==='string'&&reason.trim().length>0&&reason.length<=512,'DELIVERY_RECOVERY_INVALID');
    return this.transaction(async c=>{
      const [jobs]=await c.execute<any[]>('SELECT job_type AS type,payload,state FROM workflow_jobs WHERE id=? FOR UPDATE',[jobId]);
      rule(jobs.length,'DELIVERY_NOT_FOUND',404);const job=jobs[0];job.payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
      await this.authorize(c,job,actor,true);rule(job.state==='dead_letter','DELIVERY_RECOVERY_CONFLICT',409);
      const identity=deliveryIdentity(job);
      const [states]=await c.execute<any[]>('SELECT state FROM notification_delivery_states WHERE business_key=? FOR UPDATE',[identity.key]);
      rule(!states.length||!['unknown','sending','sent','skipped','failed'].includes(states[0].state),'DELIVERY_RECOVERY_CONFLICT',409);
      await c.execute('INSERT INTO notification_delivery_replays(workflow_job_id,actor_id,reason) VALUES(?,?,?)',[jobId,actor.userId,reason.trim()]);
      await c.execute("UPDATE workflow_jobs SET state='queued',attempts=0,available_at=NOW(),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL WHERE id=?",[jobId]);
      await this.authorize(c,job,actor,true,true);return {success:true,job_id:jobId,state:'queued'};
    });
  }
  async list(actor:ActorContext){
    const [jobs]=await this.pool().execute<any[]>("SELECT id,job_type AS type,payload,state,attempts,last_error FROM workflow_jobs WHERE job_type='notification.deliver' ORDER BY created_at DESC LIMIT 200");
    const result=[],refs=new Map<string,any>();
    for(const j of jobs){j.payload=typeof j.payload==='string'?JSON.parse(j.payload):j.payload;
      try{refs.set(j.id,await this.authorize(this.pool(),j,actor));const state=await this.inspect(j.id,actor);result.push({id:j.id,alert_id:j.payload.alertId,channel_id:j.payload.channelId,phase:j.payload.transition?.phase??'problem',job_state:j.state,attempts:j.attempts,error_code:j.last_error,...state});}
      catch(e){if((e as any).code!=='DELIVERY_FORBIDDEN')throw e;}
    }
    const final=await actorContextService.revalidateActor(actor);
    rule(final.permissions.includes('*')||final.permissions.includes('notification:view')||final.permissions.includes('admin:*'),'DELIVERY_FORBIDDEN',403);
    return result.filter(r=>{const ref=refs.get(r.id);return ref?canReadResource(final,ref):final.permissions.includes('*')&&!final.resourceBoundary;});
  }

  async inspect(jobId: string,actor?:ActorContext) {
    const [jobs] = await this.pool().execute<any[]>('SELECT job_type AS type, payload FROM workflow_jobs WHERE id = ?', [jobId]);
    if (!jobs.length) return null;
    const job = jobs[0];
    job.payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
    if(actor)await this.authorize(this.pool(),job,actor);
    const identity = deliveryIdentity(job);
    const [rows] = await this.pool().execute<any[]>(`SELECT d.business_key, d.kind, d.source_id, d.channel_id,
      IF(d.state = 'sending' AND NOT EXISTS (SELECT 1 FROM workflow_jobs j WHERE j.id = d.workflow_job_id
        AND j.state = 'running' AND j.fencing_token = d.fencing_token AND j.lease_expires_at > NOW()), 'unknown', d.state) AS state,
      d.version, d.workflow_job_id, d.attempt_id, d.request_digest, d.idempotent_until, d.error_code, d.updated_at
      FROM notification_delivery_states d WHERE d.business_key = ?`, [identity.key]);
    const [attempts] = await this.pool().execute<any[]>(`SELECT workflow_job_id, attempt_number, status, error_code, created_at, finished_at
      FROM ${attemptTable(identity.kind)} WHERE workflow_job_id = ? ORDER BY id DESC LIMIT 100`, [jobId]);
    const [decisions] = await this.pool().execute<any[]>('SELECT actor_id, reason, state_version, decision, reconciliation, created_at FROM notification_delivery_replays WHERE business_key = ? ORDER BY id DESC LIMIT 100', [identity.key]);
    if(actor)await this.authorize(this.pool(),job,actor);
    return { delivery: rows[0] ?? null, attempts, decisions };
  }
  async recover(jobId: string, actorId: number, input: { version: number; decision: 'sent' | 'abandon' | 'retry'; reason: string; reconciliation: string; acceptDuplicateRisk?: boolean },actor?:ActorContext) {
    if (!Number.isSafeInteger(actorId) || actorId < 1 || !Number.isSafeInteger(input.version) || input.version < 1 || !['sent', 'abandon', 'retry'].includes(input.decision)
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 512
      || typeof input.reconciliation !== 'string' || !input.reconciliation.trim() || input.reconciliation.length > 1024
      || (input.decision === 'retry' && input.acceptDuplicateRisk !== true)) throw new Error('DELIVERY_RECOVERY_INVALID');
    return this.transaction(async c => {
      const [jobs] = await c.execute<any[]>('SELECT *, lease_expires_at > NOW() AS active FROM workflow_jobs WHERE id = ? FOR UPDATE', [jobId]);
      if (!jobs.length) throw new Error('DELIVERY_NOT_FOUND');
      const job = jobs[0];
      const authJob={type:job.job_type,payload:typeof job.payload==='string'?JSON.parse(job.payload):job.payload};
      if(actor)await this.authorize(c,authJob,actor,true);
      const identity = deliveryIdentity({ type: job.job_type, payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload });
      const [rows] = await c.execute<any[]>('SELECT * FROM notification_delivery_states WHERE business_key = ? FOR UPDATE', [identity.key]);
      const row = rows[0];
      if (!row || Number(row.version) !== input.version || !['unknown', 'sending'].includes(row.state)
        || row.workflow_job_id !== jobId || (job.state === 'running' && job.active)) throw new Error('DELIVERY_RECOVERY_CONFLICT');
      await this.attemptResult(c, row, 'unknown', 'DELIVERY_RECONCILED');
      await c.execute(`INSERT INTO notification_delivery_replays
        (workflow_job_id,actor_id,reason,business_key,state_version,decision,reconciliation) VALUES (?,?,?,?,?,?,?)`,
      [jobId, actorId, input.reason.trim(), identity.key, input.version, input.decision, input.reconciliation.trim()]);
      const state = input.decision === 'sent' ? 'sent' : input.decision === 'abandon' ? 'failed' : 'retryable';
      await c.execute('UPDATE notification_delivery_states SET state = ?, version = version + 1, error_code = ? WHERE business_key = ?', [state, `RECOVERY_${input.decision.toUpperCase()}`, identity.key]);
      if (input.decision === 'retry') {
        await c.execute(`UPDATE workflow_jobs SET state = 'queued', attempts = 0, available_at = NOW(), lease_owner = NULL,
          lease_expires_at = NULL, last_error = NULL WHERE id = ?`, [jobId]);
      } else {
        await c.execute(`UPDATE workflow_jobs SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
          completed_at = IF(? = 'sent', NOW(), completed_at), last_error = ? WHERE id = ?`,
        [input.decision === 'sent' ? 'completed' : 'cancelled', input.decision, `RECOVERY_${input.decision.toUpperCase()}`, jobId]);
      }
      if(actor)await this.authorize(c,authJob,actor,true,true);
      return { state, version: input.version + 1 };
    });
  }
}
export const deliveryStore = new MysqlDeliveryStore();
