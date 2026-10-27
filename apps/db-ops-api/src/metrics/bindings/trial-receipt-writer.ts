/**
 * MAX-238 / B2G — the fixture-capable trial-receipt writer.
 *
 * It inserts one compiled v2 receipt into `metric_policy_trial_receipts` through
 * the **same** policy pool provider and the **same** exported
 * `withPolicyAdmission` gate as `MysqlPolicyStore.transaction`, writing only the
 * two columns the accepted B2E host reads (`receipt_id`, `payload`). It takes one
 * connection, starts no transaction, takes no `metric_policy_lock` and calls no
 * apply/gateway/config path: receipt commit and the later enable are two
 * separate transactions (see `docs/slide/development/MAX-238/b2g-trial-receipt-issuer.md`).
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

export interface TrialReceiptWriterDeps {
  /** The existing `MysqlPolicyStore` pool provider; no other pool is created. */
  readonly pool: () => Pool | null;
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

  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > PAYLOAD_BYTES_LIMIT) {
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITE_INVALID');
  }
  // Never write a payload whose stored form would read back as something else.
  if (stable(JSON.parse(text) as unknown) !== stable(payload)) {
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITE_INVALID');
  }

  // A missing provider is a stable "unavailable" before any connection attempt.
  const pool = deps?.pool?.();
  if (pool === null || pool === undefined || typeof pool.getConnection !== 'function') {
    throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITER_UNAVAILABLE');
  }

  return withPolicyAdmission(pool, async () => {
    let connection: PoolConnection;
    try {
      connection = await pool.getConnection();
    } catch {
      throw new TrialReceiptWriteError('TRIAL_RECEIPT_WRITER_UNAVAILABLE');
    }
    try {
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
        return samePayload(rows[0].payload, text, payload)
          ? { kind: 'replay' as const, persisted: false as const, receipt_id: receiptId }
          : { kind: 'collision' as const, persisted: false as const, receipt_id: receiptId };
      }
      if (affectedRowsOf(inserted) !== 1) {
        throw new TrialReceiptWriteError('TRIAL_RECEIPT_STORE_UNAVAILABLE');
      }
      return { kind: 'inserted' as const, persisted: true as const, receipt_id: receiptId };
    } finally {
      try { connection.release(); } catch { /* released exactly once */ }
    }
  });
}
