import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface MemoryHistoryEntry {
  id: string;
  index: number;
  entry: Record<string, unknown>;
}

interface HistoryEnvelope {
  _type: 'memory-history-v1';
  id: string;
  entry: Record<string, unknown>;
}
interface ArchiveBatch {
  version: 1;
  id: string;
  entries: Array<{ id: string; entry: Record<string, unknown> }>;
}

// Shared by all Store instances in this process. Concurrent processes must not
// write the same workspace; journal recovery supports a sequential restart.
const writers = new Map<string, Promise<void>>();
export async function withMemoryLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = writers.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ticket = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => ticket);
  writers.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writers.get(key) === tail) writers.delete(key);
  }
}

/** Publish only after both file contents and directory rename are synced. */
export async function writeMemoryFile(file: string, content: string, mode?: number): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, content, { encoding: 'utf8', mode });
    const handle = await fsp.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(temporary, file);
    const directory = await fsp.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await fsp.unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class MemoryHistory {
  readonly directory: string;
  readonly file: string;
  constructor(workspace: string) {
    const root = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
    this.directory = path.join(root, '.slide');
    this.file = path.join(this.directory, 'history.jsonl');
  }

  private async read(): Promise<{ entries: HistoryEnvelope[]; legacy: boolean }> {
    const content = await readOptional(this.file);
    const seen = new Set<string>();
    const occurrences = new Map<string, number>();
    let legacy = false;
    const entries = (content ?? '').split('\n').filter(line => line.trim()).map(line => {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid memory history entry');
      let envelope: HistoryEnvelope;
      if (value._type === 'memory-history-v1') {
        if (typeof value.id !== 'string' || !value.id || !value.entry || typeof value.entry !== 'object' || Array.isArray(value.entry)) {
          throw new Error('Invalid memory history envelope');
        }
        envelope = value;
      } else {
        legacy = true;
        const occurrence = occurrences.get(line) ?? 0;
        occurrences.set(line, occurrence + 1);
        // Deterministic during read-only access, then persisted before any
        // mutation. Duplicate legacy payloads remain distinct source entries.
        envelope = { _type: 'memory-history-v1', id: `legacy-${hash([line, occurrence])}`, entry: value };
      }
      if (seen.has(envelope.id)) throw new Error('Duplicate memory history ID');
      seen.add(envelope.id);
      return envelope;
    });
    return { entries, legacy };
  }

  private async write(entries: HistoryEnvelope[]): Promise<void> {
    await writeMemoryFile(this.file, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  }

  async list(cursor = 0): Promise<MemoryHistoryEntry[]> {
    return withMemoryLock(this.file, async () => (await this.read()).entries
      .map(({ id, entry }, index) => ({ id, entry, index })).filter(item => item.index >= cursor));
  }

  async append(entry: Record<string, unknown>): Promise<void> {
    // Serialize once, before acquiring the lock; caller mutation cannot alter
    // the data while the append waits for another writer.
    const envelope: HistoryEnvelope = JSON.parse(JSON.stringify({ _type: 'memory-history-v1', id: crypto.randomUUID(), entry }));
    await withMemoryLock(this.file, async () => {
      const { entries, legacy } = await this.read();
      if (legacy) await this.write(entries);
      await fsp.mkdir(this.directory, { recursive: true });
      const handle = await fsp.open(this.file, 'a');
      try {
        await handle.writeFile(JSON.stringify(envelope) + '\n', 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      const directory = await fsp.open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const root = await fsp.open(path.dirname(this.directory), 'r');
      try { await root.sync(); } finally { await root.close(); }
    });
  }

  async clear(): Promise<void> {
    await withMemoryLock(`${this.file}:consume`, () => withMemoryLock(this.file, async () => {
      // Explicit deletion is separate from consolidation. Complete an existing
      // journal first, rather than resurrecting deleted entries on restart.
      if (await readOptional(path.join(this.directory, 'consolidation-pending.json'))) {
        throw new Error('Memory consolidation pending; recover it before clearing history');
      }
      await this.write([]);
    }));
  }

  /** Finite oldest-first batch. Journal remains until exact source IDs are acked. */
  async archiveBatch(limit: number, publish: (id: string, entries: ArchiveBatch['entries']) => Promise<void>): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Memory archive batch limit must be a positive integer');
    return withMemoryLock(`${this.file}:consume`, () => this.consume(limit, publish));
  }

  async compact(keepCount: number, publish: (id: string, entries: ArchiveBatch['entries']) => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(keepCount) || keepCount < 0) throw new Error('Memory retention count must be a nonnegative integer');
    await withMemoryLock(`${this.file}:consume`, async () => {
      // Recover an interrupted transaction before freezing the compaction
      // high-water mark. Other consumers cannot overtake this finite prefix.
      if (await readOptional(path.join(this.directory, 'consolidation-pending.json'))) await this.consume(50, publish);
      let remaining = Math.max(0, (await this.list()).length - keepCount);
      while (remaining > 0) {
        const consumed = await this.consume(Math.min(50, remaining), publish);
        if (consumed === 0) break;
        remaining -= consumed;
      }
    });
  }

  private async consume(limit: number, publish: (id: string, entries: ArchiveBatch['entries']) => Promise<void>): Promise<number> {
    const journal = path.join(this.directory, 'consolidation-pending.json');
    const pending = await readOptional(journal);
    let batch: ArchiveBatch;
    if (pending !== null) {
      batch = JSON.parse(pending);
      if (batch.version !== 1 || !Array.isArray(batch.entries) || batch.entries.length === 0 ||
          batch.entries.some(e => !e || typeof e.id !== 'string' || !e.entry || typeof e.entry !== 'object') ||
          new Set(batch.entries.map(e => e.id)).size !== batch.entries.length || batch.id !== hash(batch.entries)) {
        throw new Error('Invalid memory consolidation journal');
      }
    } else {
      const entries = await withMemoryLock(this.file, async () => {
        const snapshot = await this.read();
        if (snapshot.legacy) await this.write(snapshot.entries);
        return snapshot.entries.slice(0, Math.min(limit, 50)).map(({ id, entry }) => ({ id, entry }));
      });
      if (entries.length === 0) return 0;
      batch = { version: 1, id: hash(entries), entries };
      await writeMemoryFile(journal, JSON.stringify(batch));
    }

    const archive = path.join(this.directory, 'memory-archive', `${batch.id}.json`);
    const serialized = JSON.stringify(batch);
    const existing = await readOptional(archive);
    if (existing !== null && existing !== serialized) throw new Error('Memory archive content mismatch');
    if (existing === null) await writeMemoryFile(archive, serialized);
    await publish(batch.id, batch.entries);
    await writeMemoryFile(path.join(this.directory, 'consolidation-cursor.json'), JSON.stringify({
      version: 1, batchId: batch.id, lastSourceId: batch.entries[batch.entries.length - 1].id,
    }));
    await withMemoryLock(this.file, async () => {
      const current = await this.read();
      const selected = new Map(batch.entries.map(entry => [entry.id, entry.entry]));
      for (const row of current.entries) {
        if (selected.has(row.id) && hash(row.entry) !== hash(selected.get(row.id))) {
          throw new Error('Memory source changed before acknowledgment');
        }
      }
      await this.write(current.entries.filter(entry => !selected.has(entry.id)));
    });
    await fsp.unlink(journal);
    const directory = await fsp.open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return batch.entries.length;
  }
}
