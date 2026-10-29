/**
 * MAX-239 — storage port and caller-supplied file journal for the internal
 * episode package.
 *
 * `catalog.ts` needs two things from the outside: the last record of one
 * identity hash, and somewhere to put the record back. This module is that port.
 * The default implementation stays the in-memory map the accepted catalog tests
 * run against; the file journal is the counterpart that a *new* catalog instance
 * can read back, because the records are in a directory instead of a map.
 *
 * The caller hands over an exclusive directory. The journal keeps one file there,
 * `episodes.json`, holding the last record per identity hash. A write goes to a
 * temporary file in the same directory and is renamed over the journal, so an
 * interrupted write leaves the previous file intact instead of a half file that
 * a reader would have to guess about.
 *
 * Read-back rules, which `journal.test.ts` pins:
 * - a missing journal file is an empty journal: a new problem starts at
 *   occurrence 0. That is the state of a first run, not evidence that a process
 *   has restarted cleanly.
 * - a corrupt file, truncated JSON, a record whose identity hash disagrees with
 *   its key, or a record carrying a field the record type does not have is a
 *   `TriggerEpisodeJournalError`, never an empty journal.
 *
 * There is no acknowledgement, no clock, no notification attempt, no event,
 * outbox or worker here: the journal stores episode records and nothing else, and
 * a read-back into a new instance is not a deployed-process restart acceptance.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TimestampSchema } from '../../contracts/metrics/index.js';
import { TriggerResourceSchema } from '../../contracts/metrics/triggers.js';
import { HashIdSchema } from '../../contracts/metrics/templates.js';
import type { HashId } from '../../contracts/metrics/templates.js';
import type { TriggerEpisodeEvidence, TriggerEpisodeRecord } from './episode.js';

/** The only file an exclusive journal directory holds. */
export const TRIGGER_EPISODE_JOURNAL_FILE = 'episodes.json';
export const TRIGGER_EPISODE_JOURNAL_FORMAT = 'slide.trigger-episode-journal';

/** Exactly the accepted `TriggerEpisodeRecord`; a field it does not have is an error. */
const TriggerEpisodeEvidenceSchema = z.strictObject({
  business: z.enum(['problem', 'healthy', 'unknown']),
  quality: z.enum(['good', 'partial', 'unknown']),
  reason: z.enum([
    'not_applied', 'invalid_input', 'rule_not_found', 'nodata', 'missing_input', 'stale', 'clock_skew',
    'metric_mismatch', 'semantic_version_mismatch', 'unit_mismatch', 'insufficient_evidence', 'gap',
    'series_budget_exceeded', 'problem', 'problem_retained', 'recovered', 'healthy',
  ]),
  nodata: z.boolean(),
  value: z.number().nullable(),
  dimensions: z.record(z.string(), z.string()).nullable(),
  at: TimestampSchema,
});

const TriggerEpisodeRecordSchema = z.strictObject({
  episode_id: HashIdSchema,
  identity_hash: HashIdSchema,
  resource: TriggerResourceSchema,
  rule_id: z.string().min(1),
  version: z.number().int().positive(),
  body_hash: HashIdSchema,
  scope: z.string().min(1),
  state: z.enum(['open', 'closed']),
  occurrence: z.number().int().nonnegative(),
  opened_at: TimestampSchema,
  closed_at: TimestampSchema.nullable(),
  recovery_count: z.union([z.literal(0), z.literal(1)]),
  last: TriggerEpisodeEvidenceSchema,
});

type JournalRecord = z.infer<typeof TriggerEpisodeRecordSchema>;
type JournalEvidence = z.infer<typeof TriggerEpisodeEvidenceSchema>;
/**
 * Compile-time proof that the schema and the accepted record carry the same
 * fields, and that every business state, quality and reason the evaluator can
 * produce is accepted. A new reason must be added here, or a valid record would
 * be reported as corrupt.
 */
const schemaCoversRecord: Exclude<keyof TriggerEpisodeRecord, keyof JournalRecord> extends never ? true : false = true;
const recordCoversSchema: Exclude<keyof JournalRecord, keyof TriggerEpisodeRecord> extends never ? true : false = true;
const evidenceCoversEvaluations: TriggerEpisodeEvidence extends JournalEvidence ? true : false = true;
void schemaCoversRecord;
void recordCoversSchema;
void evidenceCoversEvaluations;

const JournalFileSchema = z.strictObject({
  format: z.literal(TRIGGER_EPISODE_JOURNAL_FORMAT),
  version: z.literal(1),
  records: z.record(z.string(), z.unknown()),
});

export type TriggerEpisodeJournalErrorCode =
  /** Unparseable, truncated, or not a journal envelope at all. */
  | 'TRIGGER_EPISODE_JOURNAL_UNREADABLE'
  /** A record that does not have the episode record shape, including extra fields. */
  | 'TRIGGER_EPISODE_JOURNAL_RECORD'
  /** An entry stored under an identity hash its record does not belong to. */
  | 'TRIGGER_EPISODE_JOURNAL_IDENTITY';

export class TriggerEpisodeJournalError extends Error {
  constructor(public readonly code: TriggerEpisodeJournalErrorCode) {
    super(code);
    this.name = 'TriggerEpisodeJournalError';
  }
}

/**
 * The storage port `TriggerEpisodeCatalog` writes through. One record per
 * identity hash, read by that hash and written back under `record.identity_hash`.
 */
export interface TriggerEpisodeStore {
  read(identityHash: HashId): TriggerEpisodeRecord | null;
  write(record: TriggerEpisodeRecord): void;
  readonly size: number;
}

/** The default port: one process, one map, nothing persisted. */
export class InMemoryTriggerEpisodeStore implements TriggerEpisodeStore {
  private readonly records = new Map<HashId, TriggerEpisodeRecord>();

  read(identityHash: HashId): TriggerEpisodeRecord | null {
    return this.records.get(identityHash) ?? null;
  }

  write(record: TriggerEpisodeRecord): void {
    this.records.set(record.identity_hash, record);
  }

  get size(): number {
    return this.records.size;
  }
}

interface JournalFile {
  format: typeof TRIGGER_EPISODE_JOURNAL_FORMAT;
  version: 1;
  records: Record<HashId, TriggerEpisodeRecord>;
}

let sequence = 0;

/**
 * A file journal over one caller-supplied exclusive directory. It never creates
 * the directory and never writes outside it.
 */
export class TriggerEpisodeJournal implements TriggerEpisodeStore {
  private readonly path: string;

  constructor(private readonly directory: string) {
    this.path = join(directory, TRIGGER_EPISODE_JOURNAL_FILE);
  }

  read(identityHash: HashId): TriggerEpisodeRecord | null {
    return this.load().records[identityHash] ?? null;
  }

  write(record: TriggerEpisodeRecord): void {
    const file = this.load();
    file.records[record.identity_hash] = record;
    const temporary = `${this.path}.${process.pid}.${sequence += 1}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file)}\n`, 'utf8');
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      // Leave exactly one file behind even when the rename fails.
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  get size(): number {
    return Object.keys(this.load().records).length;
  }

  private load(): JournalFile {
    const text = this.readText();
    if (text === null) return { format: TRIGGER_EPISODE_JOURNAL_FORMAT, version: 1, records: {} };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TriggerEpisodeJournalError('TRIGGER_EPISODE_JOURNAL_UNREADABLE');
    }
    const envelope = JournalFileSchema.safeParse(parsed);
    if (!envelope.success) throw new TriggerEpisodeJournalError('TRIGGER_EPISODE_JOURNAL_UNREADABLE');

    const records: Record<HashId, TriggerEpisodeRecord> = {};
    for (const [identityHash, value] of Object.entries(envelope.data.records)) {
      const record = TriggerEpisodeRecordSchema.safeParse(value);
      if (!record.success) throw new TriggerEpisodeJournalError('TRIGGER_EPISODE_JOURNAL_RECORD');
      if (record.data.identity_hash !== identityHash) {
        throw new TriggerEpisodeJournalError('TRIGGER_EPISODE_JOURNAL_IDENTITY');
      }
      // Same field names, same field values; the cast only bridges the nullability
      // that this project's non-strict tsconfig widens inside zod's inferred type.
      records[identityHash] = record.data as TriggerEpisodeRecord;
    }
    return { format: TRIGGER_EPISODE_JOURNAL_FORMAT, version: 1, records };
  }

  private readText(): string | null {
    try {
      return readFileSync(this.path, 'utf8');
    } catch (error) {
      // A missing *file* is an empty journal. A missing *directory* only means
      // the caller did not provide the exclusive directory, and must not read
      // as "this identity has no episode".
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(this.directory)) return null;
      throw error;
    }
  }
}
