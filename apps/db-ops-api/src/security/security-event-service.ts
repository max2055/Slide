import { createHash } from 'node:crypto';
import { dbConnection } from '../db-connection.js';

export type SecurityEventType =
  | 'database_target_denied'
  | 'server_target_denied'
  | 'approval_execution_denied'
  | 'refresh_replay'
  | 'branding_write_denied'
  | 'agent_sandbox_config_denied'
  | 'login_rate_limited'
  | 'fatal_shutdown';

export interface SecurityEventInput {
  eventType: SecurityEventType;
  reasonCode: string;
  actorId?: number;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  occurredAt?: number;
}

export class SecurityEventService {
  constructor(private readonly poolProvider = () => dbConnection.getPool()) {}

  async record(input: SecurityEventInput): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) return;
    const bucket = Math.floor((input.occurredAt ?? Date.now()) / (5 * 60_000));
    const fingerprint = createHash('sha256').update([
      input.eventType,
      input.reasonCode,
      input.actorId ?? '',
      input.resourceType ?? '',
      input.resourceId ?? '',
      bucket,
    ].join('|')).digest('hex');
    await pool.execute(
      `INSERT INTO security_events
       (event_type, reason_code, actor_id, resource_type, resource_id, request_id, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE occurrence_count = occurrence_count + 1, last_seen_at = CURRENT_TIMESTAMP(3), request_id = VALUES(request_id)`,
      [
        input.eventType,
        input.reasonCode,
        input.actorId ?? null,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.requestId ?? null,
        fingerprint,
      ],
    );
  }
}

export const securityEventService = new SecurityEventService();
