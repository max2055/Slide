/**
 * MAX-238 / B2G — the fixture-capable trial-receipt writer.
 *
 * It inserts one compiled v2 receipt into `metric_policy_trial_receipts` through
 * the **same** policy pool provider and the **same** exported
 * `withPolicyAdmission` gate as `MysqlPolicyStore.transaction`, writing only the
 * two columns the accepted B2E host reads (`receipt_id`, `payload`). It takes one
 * connection and one short transaction of its own: it never takes
 * `metric_policy_lock` and calls no apply/gateway/config path (see
 * `docs/slide/development/MAX-238/b2g-trial-receipt-issuer.md`).
 *
 * MAX-238 / COLLECTION-DISPLAY-E2E-R4: the persistence itself is now the same
 * authorization boundary as the reads that produced it. The admission queue, the
 * pool's connection acquisition and the INSERT (which can wait on a row lock) can
 * all outlive the grant that opened the request, so a caller-supplied
 * `authorize` is re-read after each of those waits — on the held connection, so
 * no second pool connection is taken while one is out. A refusal after the
 * INSERT rolls it back: nothing is autocommitted and then rejected.
 *
 * Idempotency comes from the `PRIMARY KEY (receipt_id)` candidate row, not from a
 * read-then-write gap: a duplicate insert is followed by one exact read on the
 * same connection — identical payload is a replay, a different payload is a
 * collision, and two rows or a failed read fail closed. All three write nothing
 * extra. The fixture models this uniqueness; it is not a real MySQL index.
 */
import type { Pool, PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { stable } from '../packages/model.js';
import { withPolicyAdmission } from '../policy/store.js';
import { MYSQL_BINDING_HOST_SQL } from './mysql-host.js';

/** Stable machine code for every writer rejection; `message` equals the code. */
export type TrialReceiptWriteErrorCode =
  | 'TRIAL_RECEIPT_WRITER_UNAVAILABLE'
  | 'TRIAL_RECEIPT_WRITE_INVALID'
  | 'TRIAL_RECEIPT_STORE_UNAVAILABLE';

export class TrialReceiptWriteError extends Error {
  constructor(public readonly code: TrialReceiptWriteErrorCode) {
    super(code);
    this.name = 'TrialReceiptWriteError';
  }
}

/** The only columns this writer touches; the host reads `payload` by exact id. */
export const TRIAL_RECEIPT_INSERT_SQL =
  'INSERT INTO metric_policy_trial_receipts (receipt_id, payload) VALUES (?, ?)';

/** Mirrors the accepted B2E host payload bound (1 MiB); no value is truncated. */
const PAYLOAD_BYTES_LIMIT = 1024 * 1024;

/** The executor a boundary check runs on: the held connection, never a second one. */
export type TrialReceiptExecutor = Pick<PoolConnection, 'execute'>;

export interface TrialReceiptWriterDeps {
  /** The existing `MysqlPolicyStore` pool provider; no other pool is created. */
  readonly pool: () => Pool | null;
  /**
   * The trusted live grant at every boundary that can wait. An offline/fixture
   * caller omits it; a public caller must supply it, and a missing live source is
   * a refusal, never an implicit pass. The held connection is passed so the check
   * takes no second connection from the pool.
   */
  readonly authorize?: (connection?: TrialReceiptExecutor) => Promise<void>;
}

/**
 * `inserted` wrote exactly one row; `replay` and `collision` wrote nothing.
 * A collision is a conflict the caller must surface, never a silent success.
 */
export type TrialReceiptWriteOutcome =
  | { readonly kind: 'inserted'; readonly persisted: true; readonly receipt_id: string }
  | { readonly kind: 'replay'; readonly persisted: false; readonly receipt_id: string }
  | { readonly kind: 'collision'; readonly persisted: false; readonly receipt_id: string };

const IdTextSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
/** The writer accepts the two columns and nothing else. */
const WriteInputSchema = z.strictObject({
  receipt_id: IdTextSchema,
  payload: z.record(z.string(), z.unknown()),
});

type Rows = [unknown, unknown];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDuplicateEntry = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

function affectedRowsOf(result: unknown): number | null {
  if (!Array.isArray(result) || !isPlainObject(result[0])) return null;
  const affected = result[0].affectedRows;
  return typeof affected === 'number' && Number.isSafeInteger(affected) && affected >= 0 ? affected : null;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) {
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
  }
  return (result[0] as unknown[]).map(row => {
    if (!isPlainObject(row)) throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
    return row;
  });
}

/**
 * Byte comparison of a stored JSON payload against what this writer sent. A
 * driver may return the JSON column as text or already parsed; both are compared
 * exactly, never with a case/space-folding rule. Anything else is corruption.
 */
function samePayload(stored: unknown, text: string, intended: Record<string, unknown>): boolean {
  const storedText = typeof stored === 'string' ? stored
    : Buffer.isBuffer(stored) ? stored.toString('utf8')
      : null;
  if (storedText !== null) return Buffer.from(storedText, 'utf8').equals(Buffer.from(text, 'utf8'));
  if (isPlainObject(stored)) return stable(stored) === stable(intended);
  throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
}

/** The one exact read after a duplicate insert; two/zero rows prove nothing safe. */
function readStoredPayload(connection: PoolConnection, receiptId: string): Promise<Rows> {
  return connection.execute(MYSQL_BINDING_HOST_SQL.receiptRead, [receiptId]) as unknown as Promise<Rows>;
}

/**
 * Insert one compiled receipt; identical repeats are replays and a different
 * payload under the same id is a collision. Both write nothing extra.
 */
export async function writeTrialReceipt(
  input: unknown,
  deps: TrialReceiptWriterDeps,
): Promise<TrialReceiptWriteOutcome> {
  const parsed = WriteInputSchema.safeParse(input);
  if (!parsed.success) throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITE_INVALID');
  const { receipt_id: receiptId, payload } = parsed.data;
  if (payload.receipt_id !== receiptId) throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITE_INVALID');

  let text: string;
  let roundTrip: unknown;
  try {
    text = JSON.stringify(payload);
    roundTrip = JSON.parse(text) as unknown;
  } catch {
    // A value JSON cannot represent is never silently dropped or rewritten.
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITE_INVALID');
  }
  if (Buffer.byteLength(text, 'utf8') > PAYLOAD_BYTES_LIMIT) {
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITE_INVALID');
  }
  // Never write a payload whose stored form would read back as something else.
  if (stable(roundTrip) !== stable(payload)) {
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITE_INVALID');
  }

  // A missing provider is a stable "unavailable" before any connection attempt.
  const pool = deps?.pool?.();
  if (pool === null || pool === undefined || typeof pool.getConnection !== 'function') {
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITER_UNAVAILABLE');
  }

  return withPolicyAdmission(pool, async () => {
    const authorize = deps.authorize;
    // The admission queue can wait arbitrarily; the grant is re-read after it.
    await authorize?.();
    let connection: PoolConnection;
    try {
      connection = await pool.getConnection();
    } catch {
      throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITER_UNAVAILABLE');
    }
    // `settled` means the transaction was confirmed committed or rolled back; only
    // then is the connection safe to reuse instead of discarding.
    let settled = false;
    try {
      // The persistence transaction reads its live grant with a plain SELECT;
      // READ COMMITTED makes that a current read (not the transaction's opening
      // snapshot) without taking the row locks a `FOR SHARE` would hold until
      // commit. A revocation can therefore commit during the INSERT wait.
      try {
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
      } catch {
        throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
      }
      try {
        // Acquiring the connection waited too. From here on every check runs on
        // this connection, so a small pool cannot be exhausted by the check.
        await authorize?.(connection);
        let inserted: Rows;
        try {
          inserted = await connection.execute(TRIAL_RECEIPT_INSERT_SQL, [receiptId, text]) as unknown as Rows;
        } catch (error) {
          // The primary key is the only uniqueness authority; anything else is a store failure.
          if (!isDuplicateEntry(error)) throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
          let rows: Record<string, unknown>[];
          try {
            rows = rowsOf(await readStoredPayload(connection, receiptId));
          } catch (readError) {
            // A failed read proves nothing about the existing row; never treat it as a replay.
            if (readError instanceof TrialReceiptWriteError) throw readError;
            throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
          }
          // Two rows is a broken invariant and zero rows proves nothing; both fail closed.
          if (rows.length !== 1) throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
          // The failed INSERT may also have waited on a row lock; answer the
          // replay/collision only under the grant that held after that wait.
          await authorize?.(connection);
          const outcome = samePayload(rows[0].payload, text, payload)
            ? { kind: 'replay' as const, persisted: false as const, receipt_id: receiptId }
            : { kind: 'collision' as const, persisted: false as const, receipt_id: receiptId };
          // The receipt insert wrote nothing; end the transaction without keeping locks.
          try { await connection.rollback(); } catch { throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE'); }
          settled = true;
          return outcome;
        }
        if (affectedRowsOf(inserted) !== 1) {
          throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
        }
        // The INSERT can wait on a row lock. The row is not visible to anyone
        // until the commit, so this last read is the persistence boundary: a
        // grant revoked during the wait rolls the insert back below.
        await authorize?.(connection);
        // A commit whose outcome was not observed is unknown, not success; the
        // caller gets a stable store failure and the connection is discarded.
        try { await connection.commit(); } catch { throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE'); }
        settled = true;
        return { kind: 'inserted' as const, persisted: true as const, receipt_id: receiptId };
      } catch (error) {
        if (!settled) {
          try { await connection.rollback(); settled = true; } catch { /* discard instead */ }
        }
        throw error;
      }
    } finally {
      if (settled) {
        try { connection.release(); } catch { /* released exactly once */ }
      } else {
        // An unconfirmed transaction must never return to the pool.
        try { connection.destroy(); } catch { /* discarded exactly once */ }
      }
    }
  });
}
