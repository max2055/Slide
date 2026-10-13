import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { OutboxService, type TransactionConnection, type TransactionPool } from '../workflows/outbox-service.js';
import { validateInvestigationProfile, type InvestigationProfile } from './contracts.js';
import { investigationProfileHash } from './profiles.js';

/** Internal trusted service ports only: caller owns live authority, lease/fence
 * and dispatch. No HTTP/model may supply a domain, policy, Profile or lane. */
export interface BudgetPolicy {
  currency: string;
  maxConcurrent: number;
  manualReserved: number;
  maxPerResourceConcurrent: number;
  maxAutomaticRequestsPerHour: number;
  maxAutomaticTokensPerDay: number;
  maxTotalTokensPerDay: number;
  maxCostMicrosPerDay: number;
}
/** Integer micro currency units per million tokens. Currency is fixed per domain. */
export interface BudgetPrices { input: number; cachedInput: number; output: number }
export interface BudgetUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface BudgetReservationInput {
  requestId: string;
  /** Stable whole-execution allocation, NOT a refundable per-turn model slot.
   * Caller bounds Runtime tokens to reserveTokens and settles only at execution
   * terminal with aggregate usage; any unknown attempt means usage = null. */
  operationId: string;
  domain: string;
  mode: 'automatic' | 'manual';
  profile: Readonly<InvestigationProfile>;
  reserveTokens: number;
  reserveCostMicros: number;
  prices?: BudgetPrices;
}
export type BudgetState = 'reserved' | 'sent' | 'unknown' | 'settled' | 'cancelled';
export interface BudgetReservation {
  id: string; requestId: string; operationId: string; domain: string; state: BudgetState;
  reservedTokens: number; reservedCostMicros: number; chargedTokens: number; chargedCostMicros: number;
  costStatus: 'reserved' | 'known' | 'unknown'; usage: BudgetUsage | null;
}
export type BudgetSuppression = 'GLOBAL_CONCURRENCY' | 'MANUAL_CAPACITY_RESERVED' | 'RESOURCE_CONCURRENCY'
  | 'REQUEST_ACTIVE' | 'REQUEST_TOKEN_LIMIT' | 'REQUEST_ATTEMPT_LIMIT' | 'AUTOMATIC_FREQUENCY'
  | 'AUTOMATIC_DAILY_TOKENS' | 'TOTAL_DAILY_TOKENS' | 'DAILY_COST';
export type BudgetAdmission = { accepted: true; reused: boolean; reservation: BudgetReservation }
  | { accepted: false; reason: BudgetSuppression };
export class BudgetLedgerError extends Error {
  constructor(readonly code: 'BUDGET_INPUT_INVALID' | 'BUDGET_CONFLICT' | 'BUDGET_POLICY_CONFLICT'
    | 'BUDGET_REQUEST_INVALID' | 'BUDGET_NOT_FOUND' | 'BUDGET_TRANSITION_INVALID' | 'BUDGET_STORE_UNAVAILABLE') { super(code); }
}

const invalid = () => new BudgetLedgerError('BUDGET_INPUT_INVALID');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = "('reserved','sent','unknown')";
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
const key = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 128;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const json = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;
const exactNumber = (value: unknown): number => {
  const number = Number(value);
  if (!integer(number)) throw new BudgetLedgerError('BUDGET_STORE_UNAVAILABLE');
  return number;
};
async function select(connection: TransactionConnection, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  return (await connection.execute(sql, values) as [RowDataPacket[], unknown])[0];
}
function pricesSnapshot(prices: BudgetPrices): BudgetPrices {
  if (!prices || ![prices.input, prices.cachedInput, prices.output].every(value => integer(value))) throw invalid();
  return { input: prices.input, cachedInput: prices.cachedInput, output: prices.output };
}
export function budgetUsage(usage: BudgetUsage): BudgetUsage {
  if (!usage || ![usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].every(value => integer(value))
    || usage.cachedInputTokens > usage.inputTokens || !integer(usage.inputTokens + usage.outputTokens)) throw invalid();
  return { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens };
}
export function measuredBudget(usage: BudgetUsage, prices?: BudgetPrices): { tokens: number; costMicros: number | null } {
  const value = budgetUsage(usage);
  if (!prices) return { tokens: value.inputTokens + value.outputTokens, costMicros: null };
  const rate = pricesSnapshot(prices);
  const numerator = BigInt(value.inputTokens - value.cachedInputTokens) * BigInt(rate.input)
    + BigInt(value.cachedInputTokens) * BigInt(rate.cachedInput) + BigInt(value.outputTokens) * BigInt(rate.output);
  const costMicros = Number((numerator + 999_999n) / 1_000_000n);
  if (!integer(costMicros)) throw invalid();
  return { tokens: value.inputTokens + value.outputTokens, costMicros };
}
function policySnapshot(policy: BudgetPolicy): BudgetPolicy {
  if (!policy || !/^[A-Z]{3}$/.test(policy.currency) || ![policy.maxConcurrent, policy.maxPerResourceConcurrent, policy.maxAutomaticRequestsPerHour,
    policy.maxAutomaticTokensPerDay, policy.maxTotalTokensPerDay, policy.maxCostMicrosPerDay].every(value => integer(value, 1))
    || !integer(policy.manualReserved) || policy.manualReserved > policy.maxConcurrent
    || policy.maxAutomaticTokensPerDay > policy.maxTotalTokensPerDay) throw invalid();
  return { currency: policy.currency, maxConcurrent: policy.maxConcurrent, manualReserved: policy.manualReserved,
    maxPerResourceConcurrent: policy.maxPerResourceConcurrent, maxAutomaticRequestsPerHour: policy.maxAutomaticRequestsPerHour,
    maxAutomaticTokensPerDay: policy.maxAutomaticTokensPerDay, maxTotalTokensPerDay: policy.maxTotalTokensPerDay,
    maxCostMicrosPerDay: policy.maxCostMicrosPerDay };
}
function reservationInput(input: BudgetReservationInput): BudgetReservationInput {
  if (!input || !uuid.test(input.requestId) || !key(input.operationId) || !key(input.domain)
    || !['automatic', 'manual'].includes(input.mode) || !validateInvestigationProfile(input.profile).ok
    || !integer(input.reserveTokens, 1) || input.reserveTokens > input.profile.budget.maxTokens
    || !integer(input.reserveCostMicros, 1)) throw invalid();
  for (const value of Object.values(input.profile.budget)) if (!integer(value, 1)) throw invalid();
  // Copy before the first await: caller mutation cannot change a frozen command.
  const prices = input.prices ? pricesSnapshot(input.prices) : undefined;
  if (prices) {
    const maximum = (BigInt(input.reserveTokens) * BigInt(Math.max(prices.input, prices.cachedInput, prices.output)) + 999_999n) / 1_000_000n;
    if (maximum > BigInt(input.reserveCostMicros)) throw invalid();
  }
  return { requestId: input.requestId, operationId: input.operationId, domain: input.domain, mode: input.mode,
    profile: structuredClone(input.profile), reserveTokens: input.reserveTokens, reserveCostMicros: input.reserveCostMicros,
    ...(prices ? { prices } : {}) };
}
function record(row: RowDataPacket): BudgetReservation {
  return { id: row.id, requestId: row.request_id, operationId: row.operation_id.toString(), domain: row.domain_key.toString(), state: row.state,
    reservedTokens: exactNumber(row.reserved_tokens), reservedCostMicros: exactNumber(row.reserved_cost_micros),
    chargedTokens: exactNumber(row.charged_tokens), chargedCostMicros: exactNumber(row.charged_cost_micros),
    costStatus: row.cost_status, usage: row.usage_snapshot == null ? null : json(row.usage_snapshot) };
}

export class MysqlInvestigationBudgetLedger {
  private readonly policy: BudgetPolicy;
  constructor(private readonly poolProvider: () => Pool | null, policy: BudgetPolicy) {
    this.policy = Object.freeze(policySnapshot(policy));
  }
  /** Trusted ingress may retain the stable domain lock/configuration across an
   * admission savepoint rollback. This creates no allocation and charges nothing. */
  async prepareDomainInTransaction(connection: TransactionConnection, domain: string): Promise<void> {
    if (!key(domain)) throw invalid();
    await this.lockDomain(connection, domain, true);
  }
  /** Shared admission/executor contract. Both manual and automatic consumers
   * use this SAME request operation, never execution:<runId>. Live authority,
   * lease and Runtime limits remain the consumer's responsibility. */
  async reserveExecutionInTransaction(connection: TransactionConnection,
    value: Omit<BudgetReservationInput, 'operationId'>): Promise<BudgetAdmission> {
    const input = reservationInput({ ...value, operationId: `request:${value.requestId}` });
    await select(connection, 'SELECT id FROM investigation_requests WHERE id = ? FOR UPDATE', [input.requestId]);
    const result = await this.reserveInTransaction(connection, input);
    if (!result.accepted) return result;
    const [request] = await select(connection, 'SELECT request_snapshot FROM investigation_requests WHERE id = ? FOR UPDATE', [input.requestId]);
    const snapshot = json<Record<string, unknown>>(request.request_snapshot);
    const receipt = { schemaVersion: 1, requestId: input.requestId, reservationId: result.reservation.id,
      operationId: input.operationId, domain: input.domain, mode: input.mode, commandHash: hash(input) };
    if (snapshot.budgetReceipt) {
      const previous = snapshot.budgetReceipt as typeof receipt;
      if (Object.keys(previous).length !== Object.keys(receipt).length
        || Object.entries(receipt).some(([key, value]) => previous[key as keyof typeof receipt] !== value)) throw new BudgetLedgerError('BUDGET_CONFLICT');
    }
    if (!snapshot.budgetReceipt) await connection.execute('UPDATE investigation_requests SET request_snapshot = ? WHERE id = ?',
      [JSON.stringify({ ...snapshot, budgetReceipt: receipt }), input.requestId]);
    return result;
  }
  reserveExecution(value: Omit<BudgetReservationInput, 'operationId'>): Promise<BudgetAdmission> {
    const input = reservationInput({ ...value, operationId: `request:${value.requestId}` });
    return this.transaction(connection => this.reserveExecutionInTransaction(connection, input));
  }
  /** Executor reads the durable ingress allocation, validates the independently
   * selected domain/lane/Profile and reuses its original request operation.
   * Never creates a missing receipt or guesses a new Run allocation. */
  async reuseExecutionInTransaction(connection: TransactionConnection, requestId: string,
    expected: Pick<BudgetReservationInput, 'domain' | 'mode' | 'profile'>): Promise<BudgetReservation> {
    if (!uuid.test(requestId)) throw invalid();
    const ceiling = structuredClone(expected);
    const [request] = await select(connection, 'SELECT request_snapshot FROM investigation_requests WHERE id = ? FOR UPDATE', [requestId]);
    const snapshot = request && json<{ budgetReceipt?: { reservationId: string; operationId: string; domain: string; mode: string; commandHash: string } }>(request.request_snapshot);
    if (!snapshot?.budgetReceipt) throw new BudgetLedgerError('BUDGET_REQUEST_INVALID');
    if (snapshot.budgetReceipt.domain !== ceiling.domain || snapshot.budgetReceipt.mode !== ceiling.mode) throw new BudgetLedgerError('BUDGET_CONFLICT');
    await this.lockDomain(connection, ceiling.domain);
    const [row] = await select(connection, 'SELECT * FROM investigation_budget_ledger WHERE id = ? AND request_id = ? FOR UPDATE',
      [snapshot.budgetReceipt.reservationId, requestId]);
    if (!row) throw new BudgetLedgerError('BUDGET_REQUEST_INVALID');
    const stored = json<BudgetReservationInput>(row.reservation_snapshot);
    if (stored.domain !== ceiling.domain || stored.mode !== ceiling.mode || !isDeepStrictEqual(stored.profile, ceiling.profile)
      || stored.operationId !== `request:${requestId}` || stored.requestId !== requestId) throw new BudgetLedgerError('BUDGET_CONFLICT');
    // mysql JSON normalizes object key order. Rebuild with the resolved Profile
    // and fixed-order prices before checking the original command hash.
    const result = await this.reserveExecutionInTransaction(connection, { ...stored, profile: ceiling.profile });
    if (result.accepted === false || !result.reused || result.reservation.id !== row.id) throw new BudgetLedgerError('BUDGET_CONFLICT');
    return result.reservation;
  }
  /** Compose after request/authority locks in the existing store transaction.
   * No model dispatch or nested transaction; caller persists suppressions. */
  async reserveInTransaction(connection: TransactionConnection, value: BudgetReservationInput): Promise<BudgetAdmission> {
    const input = reservationInput(value);
    const [request] = await select(connection, 'SELECT investigation_id, request_snapshot FROM investigation_requests WHERE id = ? FOR SHARE', [input.requestId]);
    if (!request) throw new BudgetLedgerError('BUDGET_REQUEST_INVALID');
    const snapshot = json<{ profileId?: string; profileVersion?: number; authority?: { profileHash?: string };
      context?: { subject?: { component?: string } } }>(request.request_snapshot);
    if (snapshot.profileId !== input.profile.id || snapshot.profileVersion !== input.profile.version
      || snapshot.authority?.profileHash !== investigationProfileHash(input.profile)) throw new BudgetLedgerError('BUDGET_REQUEST_INVALID');
    const resources = await select(connection, `SELECT resource_type, resource_id FROM investigation_resources
      WHERE investigation_id = ? ORDER BY resource_type, resource_id FOR SHARE`, [request.investigation_id]);
    if ((input.profile.id === 'ops' && !resources.length) || (input.profile.id === 'system' && resources.length)) throw new BudgetLedgerError('BUDGET_REQUEST_INVALID');
    const resourceKeys = resources.length ? resources.map(row => `${row.resource_type}:${row.resource_id}`).sort()
      : [`platform:${hash({ component: snapshot.context?.subject?.component ?? 'platform' })}`];
    const requestHash = hash({ domain: input.domain, mode: input.mode, profile: input.profile, resourceKeys });
    await this.lockDomain(connection, input.domain, true);
    const [existing] = await select(connection, 'SELECT * FROM investigation_budget_ledger WHERE request_id = ? AND operation_id = ? FOR UPDATE', [input.requestId, input.operationId]);
    const commandHash = hash(input);
    if (existing) {
      if (existing.command_hash !== commandHash || existing.request_budget_hash !== requestHash) throw new BudgetLedgerError('BUDGET_CONFLICT');
      return { accepted: true, reused: true, reservation: record(existing) };
    }
    const previous = await select(connection, 'SELECT * FROM investigation_budget_ledger WHERE request_id = ? FOR UPDATE', [input.requestId]);
    if (previous.some(row => row.request_budget_hash !== requestHash)) throw new BudgetLedgerError('BUDGET_CONFLICT');
    const refuse = (reason: BudgetSuppression): BudgetAdmission => ({ accepted: false, reason });
    if (previous.some(row => ['reserved', 'sent', 'unknown'].includes(row.state))) return refuse('REQUEST_ACTIVE');
    if (previous.length >= input.profile.budget.maxProviderAttempts) return refuse('REQUEST_ATTEMPT_LIMIT');
    if (previous.reduce((sum, row) => sum + BigInt(row.charged_tokens), 0n) + BigInt(input.reserveTokens) > BigInt(input.profile.budget.maxTokens)) return refuse('REQUEST_TOKEN_LIMIT');
    const [time] = await select(connection, "SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d') AS day, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d %H:00:00') AS hour");
    // Domain lock serializes every mutation. FOR UPDATE is a current read, even
    // when this caller already established an earlier REPEATABLE READ snapshot.
    const rows = await select(connection, `SELECT request_id, mode, state, cost_status, budget_day, budget_hour,
      charged_tokens, charged_cost_micros, DATE_FORMAT(budget_day, '%Y-%m-%d') AS day,
      DATE_FORMAT(budget_hour, '%Y-%m-%d %H:00:00') AS hour FROM investigation_budget_ledger
      WHERE domain_key = ? AND (state IN ${active} OR cost_status = 'unknown' OR budget_day = ?) FOR UPDATE`, [input.domain, time.day]);
    const running = rows.filter(row => ['reserved', 'sent', 'unknown'].includes(row.state));
    if (running.length >= this.policy.maxConcurrent) return refuse('GLOBAL_CONCURRENCY');
    if (input.mode === 'automatic' && running.filter(row => row.mode === 'automatic').length >= this.policy.maxConcurrent - this.policy.manualReserved) return refuse('MANUAL_CAPACITY_RESERVED');
    for (const resourceKey of resourceKeys) {
      const occupied = await select(connection, `SELECT l.id FROM investigation_budget_resources r
        JOIN investigation_budget_ledger l ON l.id = r.reservation_id
        WHERE l.domain_key = ? AND l.state IN ${active} AND r.resource_key = ? FOR UPDATE`, [input.domain, resourceKey]);
      if (occupied.length >= this.policy.maxPerResourceConcurrent) return refuse('RESOURCE_CONCURRENCY');
    }
    const hourly = new Set(rows.filter(row => row.mode === 'automatic' && row.hour === time.hour).map(row => row.request_id));
    if (input.mode === 'automatic' && !hourly.has(input.requestId) && hourly.size >= this.policy.maxAutomaticRequestsPerHour) return refuse('AUTOMATIC_FREQUENCY');
    const tokenRows = rows.filter(row => row.day === time.day || ['reserved', 'sent', 'unknown'].includes(row.state));
    const tokens = (lane?: string) => tokenRows.filter(row => !lane || row.mode === lane).reduce((sum, row) => sum + BigInt(row.charged_tokens), 0n);
    if (input.mode === 'automatic' && tokens('automatic') + BigInt(input.reserveTokens) > BigInt(this.policy.maxAutomaticTokensPerDay)) return refuse('AUTOMATIC_DAILY_TOKENS');
    if (tokens() + BigInt(input.reserveTokens) > BigInt(this.policy.maxTotalTokensPerDay)) return refuse('TOTAL_DAILY_TOKENS');
    const costs = rows.filter(row => row.day === time.day || row.state === 'reserved' || row.state === 'sent' || row.cost_status === 'unknown')
      .reduce((sum, row) => sum + BigInt(row.charged_cost_micros), 0n);
    if (costs + BigInt(input.reserveCostMicros) > BigInt(this.policy.maxCostMicrosPerDay)) return refuse('DAILY_COST');
    const id = randomUUID();
    await connection.execute(`INSERT INTO investigation_budget_ledger (id, request_id, operation_id, domain_key, mode,
      command_hash, request_budget_hash, reservation_snapshot, reserved_tokens, reserved_cost_micros,
      charged_tokens, charged_cost_micros, budget_day, budget_hour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.requestId, input.operationId, input.domain, input.mode, commandHash, requestHash, JSON.stringify(input),
      input.reserveTokens, input.reserveCostMicros, input.reserveTokens, input.reserveCostMicros, time.day, time.hour]);
    for (const resourceKey of resourceKeys) await connection.execute('INSERT INTO investigation_budget_resources (reservation_id, resource_key) VALUES (?, ?)', [id, resourceKey]);
    return { accepted: true, reused: false, reservation: await this.readInTransaction(connection, id) };
  }
  async reserve(input: BudgetReservationInput): Promise<BudgetAdmission> {
    // Validate/copy synchronously before transaction acquisition.
    const copy = reservationInput(input);
    return this.transaction(connection => this.reserveInTransaction(connection, copy));
  }
  /** Commit intent BEFORE any external call. Restart never automatically replays sent. */
  async markSent(id: string): Promise<BudgetReservation & { dispatchAllowed: boolean }> {
    let dispatchAllowed = false;
    const reservation = await this.mutate(id, async (connection, row) => {
      if (row.state === 'reserved') {
        await connection.execute("UPDATE investigation_budget_ledger SET state = 'sent', sent_at = UTC_TIMESTAMP(3) WHERE id = ?", [id]);
        dispatchAllowed = true;
      }
      else if (!['sent', 'unknown'].includes(row.state)) throw new BudgetLedgerError('BUDGET_TRANSITION_INVALID');
    });
    return { ...reservation, dispatchAllowed };
  }
  cancelUnsent(id: string): Promise<BudgetReservation> {
    return this.transaction(connection => this.cancelUnsentInTransaction(connection, id));
  }
  /** Same-connection port. Caller proves no durable execution could have sent.
   * Domain/row locks serialize this transition against markSent. */
  cancelUnsentInTransaction(connection: TransactionConnection, id: string): Promise<BudgetReservation> {
    return this.mutateInTransaction(connection, id, (c, row) => this.cancelReserved(c, row));
  }
  /** Cancellation of an unowned retry is NOT proof of unsent execution. Keep
   * original token/cost/concurrency until a trusted terminal receipt resolves it.
   * Known settlements and previous cancellations are immutable here. */
  retainUnknownInTransaction(connection: TransactionConnection, id: string): Promise<BudgetReservation> {
    return this.mutateInTransaction(connection, id, async (c, row) => {
      if (['settled', 'cancelled'].includes(row.state)) return;
      if (!['reserved', 'sent', 'unknown'].includes(row.state)) throw new BudgetLedgerError('BUDGET_TRANSITION_INVALID');
      await c.execute("UPDATE investigation_budget_ledger SET state = 'unknown', cost_status = 'unknown' WHERE id = ?", [id]);
    });
  }
  private async cancelReserved(connection: TransactionConnection, row: RowDataPacket): Promise<void> {
    if (row.state === 'cancelled') return;
    if (row.state !== 'reserved') throw new BudgetLedgerError('BUDGET_TRANSITION_INVALID');
    await connection.execute(`UPDATE investigation_budget_ledger SET state = 'cancelled', charged_tokens = 0,
      charged_cost_micros = 0, cost_status = 'known', settled_at = UTC_TIMESTAMP(3) WHERE id = ?`, [row.id]);
  }
  /** Trusted terminal receipt only. A per-provider-turn receipt must NOT release
   * an execution's concurrency slot or remaining allocation. */
  async settle(id: string, usage: BudgetUsage | null): Promise<BudgetReservation> {
    const value = usage === null ? null : budgetUsage(usage);
    return this.mutate(id, async (connection, row) => {
      const settlementHash = hash(value);
      if (row.state === 'settled') {
        if (row.settlement_hash !== settlementHash) throw new BudgetLedgerError('BUDGET_CONFLICT');
        return;
      }
      if (!['sent', 'unknown'].includes(row.state)) throw new BudgetLedgerError('BUDGET_TRANSITION_INVALID');
      if (value === null) {
        await connection.execute("UPDATE investigation_budget_ledger SET state = 'unknown', cost_status = 'unknown' WHERE id = ?", [id]);
        return;
      }
      const snapshot = json<BudgetReservationInput>(row.reservation_snapshot);
      const measured = measuredBudget(value, snapshot.prices);
      await connection.execute(`UPDATE investigation_budget_ledger SET state = 'settled', charged_tokens = ?,
        charged_cost_micros = ?, cost_status = ?, usage_snapshot = ?, settlement_hash = ?, settled_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [measured.tokens, measured.costMicros ?? row.reserved_cost_micros, measured.costMicros === null ? 'unknown' : 'known', JSON.stringify(value), settlementHash, id]);
    });
  }
  async read(id: string): Promise<BudgetReservation> {
    if (!uuid.test(id)) throw invalid();
    return this.transaction(connection => this.readInTransaction(connection, id));
  }
  private async readInTransaction(connection: TransactionConnection, id: string): Promise<BudgetReservation> {
    const [row] = await select(connection, 'SELECT * FROM investigation_budget_ledger WHERE id = ?', [id]);
    if (!row) throw new BudgetLedgerError('BUDGET_NOT_FOUND');
    return record(row);
  }
  private async lockDomain(connection: TransactionConnection, domain: string, create = false): Promise<void> {
    if (create) await connection.execute(`INSERT INTO investigation_budget_domains (domain_key, policy_hash, policy_snapshot)
      VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE domain_key = domain_key`, [domain, hash(this.policy), JSON.stringify(this.policy)]);
    const [row] = await select(connection, 'SELECT policy_hash FROM investigation_budget_domains WHERE domain_key = ? FOR UPDATE', [domain]);
    if (!row) throw new BudgetLedgerError('BUDGET_NOT_FOUND');
    // Settlement must remain possible after config changes; frozen prices live
    // on the row. Only NEW allocation requires matching admission policy.
    if (create && row.policy_hash !== hash(this.policy)) throw new BudgetLedgerError('BUDGET_POLICY_CONFLICT');
  }
  private async mutate(id: string, work: (connection: TransactionConnection, row: RowDataPacket) => Promise<void>): Promise<BudgetReservation> {
    return this.transaction(connection => this.mutateInTransaction(connection, id, work));
  }
  private async mutateInTransaction(connection: TransactionConnection, id: string,
    work: (connection: TransactionConnection, row: RowDataPacket) => Promise<void>): Promise<BudgetReservation> {
    if (!uuid.test(id)) throw invalid();
    const [location] = await select(connection, 'SELECT domain_key FROM investigation_budget_ledger WHERE id = ?', [id]);
    if (!location) throw new BudgetLedgerError('BUDGET_NOT_FOUND');
    await this.lockDomain(connection, location.domain_key.toString());
    const [row] = await select(connection, 'SELECT * FROM investigation_budget_ledger WHERE id = ? FOR UPDATE', [id]);
    if (!row) throw new BudgetLedgerError('BUDGET_NOT_FOUND');
    await work(connection, row);
    const [updated] = await select(connection, 'SELECT * FROM investigation_budget_ledger WHERE id = ? FOR UPDATE', [id]);
    return record(updated);
  }
  private async transaction<T>(work: (connection: TransactionConnection) => Promise<T>): Promise<T> {
    const pool = this.poolProvider();
    if (!pool) throw new BudgetLedgerError('BUDGET_STORE_UNAVAILABLE');
    return new OutboxService(pool as unknown as TransactionPool).transaction(work);
  }
}
