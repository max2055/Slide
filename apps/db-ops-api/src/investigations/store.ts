import { createHash, randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { INVESTIGATION_ERROR_STATUS } from './contracts.js';
import { OutboxService, type TransactionConnection, type TransactionPool } from '../workflows/outbox-service.js';

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
export interface AdmissionInvestigation {
  id: string;
  sessionId: string;
  profileId: string;
  profileVersion: number;
  scopeVersion: string;
  lifecycle: 'open' | 'waiting' | 'closed' | 'archived';
  version: number;
}
/** Mandatory trusted server port, executed inside the transaction even on
 * idempotent retries. T03 must implement live actor/resource/Profile authority;
 * this hook must not append messages or perform other acceptance side effects.
 * Session append belongs only in the new-request branch when T03 integrates it.
 * A model or HTTP payload cannot supply this callback. Invisible objects must
 * throw NOT_FOUND; visible non-operators FORBIDDEN. */
export type AdmissionAuthorizer = (connection: TransactionConnection, actor: InvestigationActor,
  investigation: Readonly<AdmissionInvestigation>) => Promise<void>;

const invalid = () => new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validate(input: InvestigationAdmission): void {
  if (!input || !uuid.test(input.investigationId) || !input.actor
    || !['user', 'service'].includes(input.actor.kind) || !Number.isSafeInteger(input.actor.id) || input.actor.id <= 0
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || Buffer.byteLength(input.idempotencyKey) > 255
    || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 2_000
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw invalid();
}
async function select<T extends RowDataPacket>(connection: TransactionConnection, sql: string, values: unknown[]): Promise<T[]> {
  const [rows] = await connection.execute(sql, values) as [T[], unknown];
  return rows;
}

/** Isolated admission kernel only. No routes, production schema registration,
 * Profile execution or Chat append are installed by this module. Callers must
 * complete T03 authority/Session integration before accepting business input. */
export class MysqlInvestigationStore {
  constructor(private readonly poolProvider: () => Pool | null, private readonly authorize: AdmissionAuthorizer) {}

  async admit(input: InvestigationAdmission): Promise<InvestigationAcceptance> {
    validate(input);
    input = { ...input, actor: { ...input.actor } };
    if (typeof this.authorize !== 'function') throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    const pool = this.poolProvider();
    if (!pool) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    // All fields are primitives in fixed order. Freeze the caller's command,
    // not a newly resolved Profile version that could change on a retry.
    const requestHash = createHash('sha256').update(JSON.stringify([
      input.investigationId, input.message, input.expectedVersion,
    ])).digest('hex');
    const key = Buffer.from(input.idempotencyKey, 'utf8');
    const keyValues = [input.actor.kind, input.actor.id, key];
    try {
      return await new OutboxService(pool as unknown as TransactionPool).transaction(async (connection, append) => {
        // Lock order: actor/key -> investigation -> request. An actor/key lock
        // also serializes first-use retries across different investigations.
        await connection.execute(`INSERT INTO investigation_admission_keys (actor_kind, actor_id, idempotency_key)
          VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE request_id = request_id`, keyValues);
        const [reservation] = await select(connection, `SELECT request_id FROM investigation_admission_keys
          WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ? FOR UPDATE`, keyValues);
        const [row] = await select(connection, 'SELECT * FROM investigations WHERE id = ? FOR UPDATE', [input.investigationId]);
        if (!row) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
        const investigation: AdmissionInvestigation = { id: row.id, sessionId: row.session_id,
          profileId: row.profile_id, profileVersion: Number(row.profile_version), scopeVersion: row.scope_version,
          lifecycle: row.lifecycle, version: Number(row.version) };
        await this.authorize(connection, input.actor, investigation);
        if (reservation.request_id) {
          const [previous] = await select(connection,
            'SELECT * FROM investigation_requests WHERE id = ? FOR UPDATE', [reservation.request_id]);
          if (!previous) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
          if (previous.request_hash !== requestHash) throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
          return { investigationId: previous.investigation_id, sessionId: investigation.sessionId,
            requestId: previous.id, jobId: previous.job_id, version: Number(previous.accepted_version) };
        }
        if (row.active_request_id) throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
        if (investigation.version !== input.expectedVersion) throw new InvestigationStoreError('VERSION_CONFLICT');
        if (['closed', 'archived'].includes(investigation.lifecycle)) throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
        const version = investigation.version + 1;
        if (!Number.isSafeInteger(version)) throw new InvestigationStoreError('VERSION_CONFLICT');
        const requestId = randomUUID();
        const jobId = randomUUID();
        const jobKey = `investigation.execute:${requestId}`;
        // Only IDs go in the Workflow queue; the immutable request owns the
        // execution snapshot. No Agent Run is fabricated at admission time.
        const snapshot = { ...investigation, actor: { ...input.actor }, message: input.message };
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
        await connection.execute(`UPDATE investigations SET active_request_id = ?, version = ?, lifecycle = 'open' WHERE id = ?`,
          [requestId, version, investigation.id]);
        await connection.execute(`UPDATE investigation_admission_keys SET request_id = ?
          WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ?`, [requestId, ...keyValues]);
        return { investigationId: investigation.id, sessionId: investigation.sessionId, requestId, jobId, version };
      });
    } catch (error) {
      if (error instanceof InvestigationStoreError) throw error;
      throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE', error);
    }
  }
}
