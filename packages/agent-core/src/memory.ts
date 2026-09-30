/**
 * MemoryStore + Consolidator — TypeScript persistence implemented for Slide.
 *
 * MemoryStore: persists MEMORY.md and session context files with atomic writes.
 * Consolidator: simplified history compaction (archival concatenation, no LLM).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MemoryScope } from './memory-record.js';
import type { MemoryQuery, MemoryRetrievalLimits, MemoryRetrievalResult } from './memory-retrieval.js';
import { MemoryHistory, type MemoryHistoryEntry, withMemoryLock, writeMemoryFile } from './memory-history.js';

// ── Constants ──

// ── MemoryStore ──

export class MemoryStore {
  private workspace: string;
  private history: MemoryHistory;

  constructor(workspace: string) {
    this.workspace = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
    this.history = new MemoryHistory(this.workspace);
  }

  /** Read the MEMORY.md file content. */
  async readMemory(): Promise<string | null> {
    return this._readFile('MEMORY.md');
  }

  /** Write MEMORY.md with atomic tmp+fsync+rename at workspace root. */
  async writeMemory(content: string): Promise<void> {
    const filePath = path.join(this.workspace, 'MEMORY.md');
    await withMemoryLock(filePath, () => this._atomicWrite(filePath, content));
  }

  /** Read SOUL.md content. */
  async readSoul(): Promise<string | null> {
    return this._readFile('SOUL.md');
  }

  /** Read AGENTS.md content. */
  async readAgents(): Promise<string | null> {
    return this._readFile('AGENTS.md');
  }

  /** Read USER.md content (if exists). */
  async readUserProfile(): Promise<string | null> {
    return this._readFile('USER.md');
  }

  /** Append a message to history.jsonl. */
  async appendHistory(entry: Record<string, unknown>): Promise<void> {
    await this.history.append(entry);
  }

  /** Read unprocessed history entries (after a cursor). */
  async readUnprocessedHistory(cursor: number): Promise<MemoryHistoryEntry[]> {
    return this.history.list(cursor);
  }

  /** Archive prefixes durably before retaining recent entries; append can continue. */
  async compactHistory(keepCount: number): Promise<void> {
    await this.history.compact(keepCount, (id, entries) => this.publishArchive(id, entries));
  }

  /** Recover a pending batch first; each new batch contains at most 50 sources. */
  async archiveHistoryBatch(limit = 50): Promise<number> {
    return this.history.archiveBatch(limit, (id, entries) => this.publishArchive(id, entries));
  }

  private async publishArchive(id: string, entries: Array<{ id: string; entry: Record<string, unknown> }>): Promise<void> {
    const filePath = path.join(this.workspace, 'MEMORY.md');
    await withMemoryLock(filePath, async () => {
      let existing: string;
      try { existing = await fsp.readFile(filePath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existing = '# Memory\n';
      }
      const marker = `<!-- slide-memory-archive:${id} -->`;
      if (existing.split('\n').includes(marker)) return;
      const sources = entries.map(item => JSON.stringify(item)).join('\n');
      await this._atomicWrite(filePath, `${existing.trimEnd()}\n\n${marker}\n${sources}\n`);
    });
  }

  /** Compatibility reference only. Empty query/scope never returns the entire file. */
  async getMemoryContext(query?: string, scope?: MemoryScope, limits?: Partial<MemoryRetrievalLimits>): Promise<string | null> {
    if (!query || !scope) return null;
    const result = await this.retrieveLegacy(scope, { text: query }, limits);
    return result.count ? JSON.stringify({ records: result.items }) : null;
  }

  /** File ownership is explicitly supplied by the authenticated caller, never inferred from cwd. */
  async retrieveLegacy(scope: MemoryScope, query: MemoryQuery, config?: Partial<MemoryRetrievalLimits>): Promise<MemoryRetrievalResult> {
    // Persistence/archive recovery remains independent of context projection dependencies.
    const { emptyRetrieval, legacyMemoryRecords, projectMemory, retrievalLimits } = await import('./memory-retrieval.js');
    const limits = retrievalLimits(config);
    let handle;
    try {
      handle = await fsp.open(path.join(this.workspace, 'MEMORY.md'), 'r');
      if ((await handle.stat()).size > 65536) return emptyRetrieval(limits, 'degraded', 'MEMORY_SCAN_LIMIT');
      // A fixed-size read also bounds a concurrent file append after stat().
      const bytes = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65536) return emptyRetrieval(limits, 'degraded', 'MEMORY_SCAN_LIMIT');
      const records = legacyMemoryRecords(bytes.subarray(0, bytesRead).toString('utf8'), scope, limits.maxRecords);
      if (records.length > limits.maxRecords) return emptyRetrieval(limits, 'degraded', 'MEMORY_SCAN_LIMIT');
      return projectMemory(records, query, limits);
    } catch (error) {
      return emptyRetrieval(limits, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'empty' : 'degraded',
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'MEMORY_RETRIEVAL_FAILED');
    } finally { await handle?.close(); }
  }

  /** Check if MEMORY.md file exists. */
  async hasMemory(): Promise<boolean> {
    return fs.existsSync(path.join(this.workspace, 'MEMORY.md'));
  }

  /** Delete the MEMORY.md file. */
  async deleteMemory(): Promise<void> {
    const filePath = path.join(this.workspace, 'MEMORY.md');
    await withMemoryLock(filePath, async () => {
      try { await fsp.unlink(filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  }

  /** Append content to the MEMORY.md file (creates if not exists). */
  async updateMemory(append: string): Promise<void> {
    const filePath = path.join(this.workspace, 'MEMORY.md');
    await withMemoryLock(filePath, async () => {
      let existing: string | null;
      try { existing = await fsp.readFile(filePath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        existing = null;
      }
      const now = new Date().toISOString().split('T')[0];
      const entry = `\n\n### ${now}\n${append.trim()}`;
      const content = existing ? `${existing.trimEnd()}${entry}` : `# Memory\n${entry}`;
      await this._atomicWrite(filePath, content);
    });
  }

  /** Get the total count of entries in the history file. */
  async getHistoryCount(): Promise<number> {
    return (await this.history.list()).length;
  }

  /** Read history entries after a given ISO timestamp. */
  async readHistorySince(since: string): Promise<Array<{ index: number; entry: Record<string, unknown> }>> {
    const all = await this.readUnprocessedHistory(0);
    return all.filter(item => {
      const ts = item.entry.timestamp as string | undefined;
      return ts && ts > since;
    });
  }

  /** Clear all history entries (truncate the history file). */
  async clearHistory(): Promise<void> {
    await this.history.clear();
  }

  /** Get the full path to the history file. */
  getHistoryPath(): string {
    return this.history.file;
  }

  /** Get the path to the .slide memory directory. */
  getMemoryDir(): string {
    return this.history.directory;
  }

  /** Get the workspace path used by this store. */
  getWorkspace(): string {
    return this.workspace;
  }

  /** Write SOUL.md with atomic safety. */
  async writeSoul(content: string): Promise<void> {
    const filePath = path.join(this.workspace, 'SOUL.md');
    await this._atomicWrite(filePath, content);
  }

  /** Write AGENTS.md with atomic safety. */
  async writeAgents(content: string): Promise<void> {
    const filePath = path.join(this.workspace, 'AGENTS.md');
    await this._atomicWrite(filePath, content);
  }

  // ── Private ──

  private async _readFile(filename: string): Promise<string | null> {
    const filePath = path.join(this.workspace, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      return await fsp.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private async _atomicWrite(filePath: string, content: string): Promise<void> {
    await writeMemoryFile(filePath, content);
  }
}

// ── Simplified Consolidator ──

export class Consolidator {
  /**
   * Summarize memory (simplified: no LLM call, just extracts recent entries).
   * This lightweight implementation archives recent history entries without
   * requiring an LLM summarization pass.
   */
  async summarize(store: MemoryStore, maxEntries?: number): Promise<string> {
    const recent = await store.readUnprocessedHistory(0);
    if (recent.length === 0) return 'No recent memory entries.';

    const keep = recent.slice(-(maxEntries ?? 50));
    const lines = keep.map(r => JSON.stringify(r.entry));
    return lines.join('\n');
  }

  /**
   * Consolidate: archive recent history then compact.
   */
  async consolidate(store: MemoryStore, keepCount?: number): Promise<void> {
    await store.compactHistory(keepCount ?? 100);
  }

  /**
   * Archive one oldest-first batch into MEMORY.md and immutable source files.
   * keepCount is a batch limit (default/maximum 50), not a destructive retention
   * cursor. Repeated calls drain pending entries without deleting later appends.
   */
  async consolidateToMemory(store: MemoryStore, keepCount?: number): Promise<void> {
    await store.archiveHistoryBatch(keepCount ?? 50);
  }

  /**
   * Estimate the number of entities referenced in memory.
   * Simple heuristic: count lines starting with "- " in MEMORY.md.
   */
  async estimateEntityCount(store: MemoryStore): Promise<number> {
    const memory = await store.readMemory();
    if (!memory) return 0;
    const lines = memory.split('\n');
    return lines.filter(l => /^\s*[-*]\s/.test(l)).length;
  }

  /**
   * Check whether consolidation is needed based on history entry count.
   * Returns true if history has more entries than the given threshold.
   */
  async shouldConsolidate(store: MemoryStore, threshold?: number): Promise<boolean> {
    const count = await store.getHistoryCount();
    return count > (threshold ?? 200);
  }
}
