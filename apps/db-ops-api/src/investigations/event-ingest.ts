import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { OutboxService, type TransactionConnection, type TransactionPool } from '../workflows/outbox-service.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import { MysqlInvestigationBudgetLedger, type BudgetSuppression } from './budget-ledger.js';
import { resolveInvestigationProfile } from './profiles.js';
import { EventIngestError, freezeTriggerBinding, normalizeEvent, policyExclusion, scopeSupported, stableHash, triggerIdentity,
  type EventInput, type TriggerBinding, type TriggerSuppression } from './trigger-policy.js';

export interface EventReceipt {
  eventId: string; duplicate: boolean; disposition: 'accepted' | 'linked' | 'suppressed';
  suppressionReason: TriggerSuppression | BudgetSuppression | null;
  investigationId: string | null; requestId: string | null; previousInvestigationId: string | null;
}
export interface StoredOperationalEvent extends EventReceipt { envelope: ReturnType<typeof normalizeEvent> }
const sqlTime = (value: string) => value.replace('T', ' ').replace('Z', '');
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;
async function rows(connection: Pick<TransactionConnection, 'execute'>, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  return (await connection.execute(sql, values) as [RowDataPacket[], unknown])[0];
}
function receipt(row: RowDataPacket, duplicate = false): EventReceipt {
  return { eventId: row.id, duplicate, disposition: row.disposition, suppressionReason: row.suppression_reason,
    investigationId: row.investigation_id, requestId: row.request_id, previousInvestigationId: row.previous_investigation_id };
}

/** Internal source-bound port. Composition root supplies trusted binding,
 * service identity, ACL bridge and shared domain ledger. No HTTP registration,
 * Worker, model invocation or externally selectable actor/policy/grants. */
export class MysqlOperationalEventIngest {
  private readonly binding: TriggerBinding;
  constructor(private readonly poolProvider: () => Pool | null, binding: TriggerBinding,
    private readonly ledger: MysqlInvestigationBudgetLedger,
    private readonly authorization = new InvestigationAuthorization(),
    private readonly bridge = new InvestigationSessionBridge(poolProvider, authorization)) {
    this.binding = freezeTriggerBinding(binding);
  }

  async ingest(value: EventInput): Promise<EventReceipt> {
    const input = structuredClone(value); // Freeze producer mutation before connection acquisition.
    // Validate including absence of producer-supplied server fields BEFORE IO.
    normalizeEvent(input, this.binding, randomUUID(), new Date().toISOString());
    const pool = this.poolProvider();
    if (!pool) throw new EventIngestError('EVENT_STORE_UNAVAILABLE');
    // Bounded transaction retry only. External calls never occur in this port.
    for (let attempt = 0; ; attempt++) {
      try {
        return await new OutboxService(pool as unknown as TransactionPool).transaction(async (connection, append) => {
          const [clock] = await rows(connection, "SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS now");
          const now = new Date(clock.now).toISOString();
          const event = normalizeEvent(input, this.binding, randomUUID(), now);
          const { scopeHash, fingerprint, policyHash } = triggerIdentity(event, this.binding);
          const triggerKey = fingerprint;
          const commandHash = stableHash(input);
          await connection.execute(`INSERT INTO operational_events
            (id, source, source_event_id, command_hash, envelope, occurred_at, received_at, fingerprint, trigger_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
          [event.id, event.source, event.sourceEventId, commandHash, JSON.stringify(event), sqlTime(event.occurredAt), sqlTime(now), fingerprint, triggerKey]);
          const [stored] = await rows(connection, 'SELECT * FROM operational_events WHERE source = ? AND source_event_id = ? FOR UPDATE', [event.source, event.sourceEventId]);
          if (stored.command_hash !== commandHash) throw new EventIngestError('EVENT_DELIVERY_CONFLICT');
          if (stored.id !== event.id) {
            if (stored.investigation_id) {
              const investigation = await this.authorization.load(connection, stored.investigation_id);
              await this.authorization.authorize(connection, this.binding.policy.actor, investigation, 'content');
            }
            return receipt(stored, true);
          }
          const p = this.binding.policy;
          await connection.execute(`INSERT INTO investigation_trigger_keys
            (trigger_key, policy_id, policy_version, scope_hash, fingerprint, policy_hash, window_started_at, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE trigger_key = trigger_key`,
          [triggerKey, p.id, p.version, scopeHash, fingerprint, policyHash, sqlTime(now), sqlTime(now)]);
          const [aggregate] = await rows(connection, `SELECT *, DATE_FORMAT(window_started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS window_time
            FROM investigation_trigger_keys WHERE trigger_key = ? FOR UPDATE`, [triggerKey]);
          if (aggregate.policy_hash !== policyHash) throw new EventIngestError('TRIGGER_POLICY_CONFLICT');
          const exclusion = policyExclusion(event, this.binding);
          const reset = Date.parse(now) - Date.parse(aggregate.window_time) >= p.windowMs;
          const windowCount = (reset ? 0 : Number(aggregate.window_count)) + (exclusion ? 0 : 1);
          await connection.execute(`UPDATE investigation_trigger_keys SET event_count = event_count + 1,
            window_count = ?, window_started_at = ?, last_seen = GREATEST(last_seen, ?) WHERE trigger_key = ?`,
          [windowCount, reset ? sqlTime(now) : sqlTime(new Date(aggregate.window_time).toISOString()), sqlTime(now), triggerKey]);
          let investigationId: string | null = null;
          let requestId: string | null = null;
          let previousId: string | null = null;
          const outcome = async (disposition: EventReceipt['disposition'], reason: EventReceipt['suppressionReason']) => {
            await connection.execute(`UPDATE operational_events SET disposition = ?, suppression_reason = ?,
              investigation_id = ?, request_id = ?, previous_investigation_id = ? WHERE id = ?`,
            [disposition, reason, investigationId, requestId, previousId, event.id]);
            if (investigationId) await connection.execute('INSERT INTO investigation_event_links (investigation_id, event_id) VALUES (?, ?)', [investigationId, event.id]);
            return { eventId: event.id, duplicate: false, disposition, suppressionReason: reason,
              investigationId, requestId, previousInvestigationId: previousId };
          };
          if (exclusion) return outcome('suppressed', exclusion);
          // MySQL SAVEPOINT is text-protocol only. The underlying connection
          // is the SAME mysql2 connection owned by OutboxService.
          const control = connection as TransactionConnection & Pick<PoolConnection, 'query'>;
          await control.query('SAVEPOINT event_admission');
          try {
            await this.authorizeSubject(connection, event);
            if (aggregate.active_investigation_id) {
              const [binding] = await rows(connection, 'SELECT session_id FROM investigations WHERE id = ?', [aggregate.active_investigation_id]);
              if (!binding) throw new EventIngestError('EVENT_STORE_UNAVAILABLE');
              await connection.execute('SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE', [binding.session_id]);
              await connection.execute('SELECT id FROM investigations WHERE id = ? FOR UPDATE', [aggregate.active_investigation_id]);
              const investigation = await this.authorization.load(connection, aggregate.active_investigation_id);
              await this.authorization.authorize(connection, p.actor, investigation, 'continue');
              if (['open', 'waiting'].includes(investigation.lifecycle)) {
                investigationId = investigation.id; requestId = aggregate.first_request_id;
                return outcome('linked', 'OPEN_INVESTIGATION');
              }
              previousId = investigation.id;
            }
            if (windowCount < p.threshold && !(p.criticalSingle && event.severity === 'critical')) return outcome('suppressed', 'BELOW_THRESHOLD');
            await this.ledger.prepareDomainInTransaction(connection, p.domain);
            // Same domain/all resources as ledger; cooldown crosses fingerprints,
            // policy versions and releases. Sorted lock order prevents inversion.
            const resourceKeys = p.resources.length ? p.resources.map(ref => `${ref.type}:${ref.id}`).sort()
              : [`platform:${stableHash(p.component)}`];
            for (const resource of resourceKeys) {
              await connection.execute(`INSERT INTO investigation_trigger_cooldowns (domain_key, resource_key, cooldown_until)
                VALUES (?, ?, '1970-01-01 00:00:00') ON DUPLICATE KEY UPDATE resource_key = resource_key`, [p.domain, resource]);
              const [cooldown] = await rows(connection, `SELECT cooldown_until > ? AS blocked FROM investigation_trigger_cooldowns
                WHERE domain_key = ? AND resource_key = ? FOR UPDATE`, [sqlTime(now), p.domain, resource]);
              if (Number(cooldown.blocked) > 0) return outcome('suppressed', 'COOLDOWN');
            }
            // Retain initialized serialization rows when quota refuses. Rolling
            // back a first cooldown INSERT leaves InnoDB supremum gap locks
            // that can deadlock many simultaneous refused insertions.
            await control.query('SAVEPOINT event_admission');
            const key = `event:${event.id}`;
            const created = await this.bridge.createOnConnection(p.actor, connection, append,
              { idempotencyKey: key, title: event.summary.slice(0, 200), goal: '只读调查持久事件，引用事实并说明证据缺口。',
                profileId: p.profileId, profileVersion: p.profileVersion, resources: p.resources,
                context: { subject: event.subject, from: event.occurredAt, to: now } },
              { idempotencyKey: key, message: `事件 ${event.id}：${event.summary}`.slice(0, 2_000) });
            if (!created.acceptance) throw new EventIngestError('EVENT_STORE_UNAVAILABLE');
            const budget = await this.ledger.reserveExecutionInTransaction(connection,
              { requestId: created.acceptance.requestId, domain: p.domain, mode: 'automatic',
                profile: resolveInvestigationProfile(p.profileId, p.profileVersion), reserveTokens: p.reserveTokens,
                reserveCostMicros: p.reserveCostMicros, ...(p.prices ? { prices: p.prices } : {}) });
            if (budget.accepted === false) {
              await control.query('ROLLBACK TO SAVEPOINT event_admission');
              return outcome('suppressed', budget.reason);
            }
            investigationId = created.investigation.id; requestId = created.acceptance.requestId;
            const until = sqlTime(new Date(Date.parse(now) + p.cooldownMs).toISOString());
            for (const resource of resourceKeys) await connection.execute(`UPDATE investigation_trigger_cooldowns SET cooldown_until = ?
              WHERE domain_key = ? AND resource_key = ?`, [until, p.domain, resource]);
            await connection.execute(`UPDATE investigation_trigger_keys SET active_investigation_id = ?, first_request_id = ? WHERE trigger_key = ?`,
              [investigationId, requestId, triggerKey]);
            return outcome('accepted', null);
          } catch (error) {
            if (error instanceof InvestigationStoreError && ['INVESTIGATION_NOT_FOUND', 'INVESTIGATION_OPERATION_FORBIDDEN'].includes(error.code)) {
              await control.query('ROLLBACK TO SAVEPOINT event_admission');
              investigationId = null; requestId = null; previousId = null;
              return outcome('suppressed', 'AUTHORITY_DENIED');
            }
            throw error; // Infrastructure faults roll back the complete transaction; safe same-key retry.
          }
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_LOCK_DEADLOCK' && attempt < 3) continue;
        throw error;
      }
    }
  }

  private async authorizeSubject(connection: TransactionConnection, event: ReturnType<typeof normalizeEvent>) {
    const p = this.binding.policy;
    const investigation: AdmissionInvestigation = { id: event.id, sessionId: event.id, profileId: p.profileId,
      profileVersion: p.profileVersion, scopeVersion: triggerIdentity(event, this.binding).scopeHash,
      lifecycle: 'open', version: 1, owner: { kind: 'service', id: p.actor.userId }, resources: p.resources };
    await this.authorization.authorize(connection, p.actor, investigation, 'create');
  }

  /** Internal exact-source query; rechecks the whole required scope even for
   * suppressed events. Never returns another source's payload or follows rawRef. */
  async get(eventId: string): Promise<StoredOperationalEvent | null> {
    if (!/^[a-f0-9-]{36}$/.test(eventId)) throw new EventIngestError('EVENT_INPUT_INVALID');
    const pool = this.poolProvider();
    if (!pool) throw new EventIngestError('EVENT_STORE_UNAVAILABLE');
    return new OutboxService(pool as unknown as TransactionPool).transaction(async connection => {
      const [row] = await rows(connection, 'SELECT * FROM operational_events WHERE id = ? AND source = ? FOR SHARE', [eventId, this.binding.source]);
      if (!row) return null;
      const envelope = parse<ReturnType<typeof normalizeEvent>>(row.envelope);
      // Only this bound policy's scope may query, including origin exclusions.
      if (!scopeSupported(envelope, this.binding))
        throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
      await this.authorizeSubject(connection, envelope);
      return { ...receipt(row), envelope };
    });
  }
}
