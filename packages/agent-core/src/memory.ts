/**
 * MemoryStore + Consolidator — ported from nanobot agent/memory.py
 *
 * MemoryStore: persists MEMORY.md and session context files with atomic writes.
 * Consolidator: simplified history compaction (archival concatenation, no LLM).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ── Constants ──

const MEMORY_DIR = '.slide';
const HISTORY_FILE = 'history.jsonl';

// ── MemoryStore ──

export class MemoryStore {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  /** Read the MEMORY.md file content. */
  async readMemory(): Promise<string | null> {
    return this._readFile('MEMORY.md');
  }

  /** Write MEMORY.md with atomic tmp+fsync+rename at workspace root. */
  async writeMemory(content: string): Promise<void> {
    const filePath = path.join(this.workspace, 'MEMORY.md');
    await this._atomicWrite(filePath, content);
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
    const filePath = path.join(this.workspace, MEMORY_DIR, HISTORY_FILE);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    await fsp.appendFile(filePath, line, 'utf-8');
  }

  /** Read unprocessed history entries (after a cursor). */
  async readUnprocessedHistory(cursor: number): Promise<Array<{ index: number; entry: Record<string, unknown> }>> {
    const filePath = path.join(this.workspace, MEMORY_DIR, HISTORY_FILE);
    if (!fs.existsSync(filePath)) return [];

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines
        .map((line: string, index: number) => ({
          index,
          entry: JSON.parse(line) as Record<string, unknown>,
        }))
        .filter((item: { index: number; entry: Record<string, unknown> }) => item.index >= cursor);
    } catch {
      return [];
    }
  }

  /** Compact history file, keeping only the most recent entries. */
  async compactHistory(keepCount: number): Promise<void> {
    const filePath = path.join(this.workspace, MEMORY_DIR, HISTORY_FILE);
    if (!fs.existsSync(filePath)) return;

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length <= keepCount) return;

      const kept = lines.slice(-keepCount);
      const tmpPath = filePath + '.tmp';
      await fsp.writeFile(tmpPath, kept.join('\n') + '\n', 'utf-8');
      await fsp.rename(tmpPath, filePath);
    } catch {
      // Best-effort compaction
    }
  }

  /** Get memory context string for system prompt injection. */
  async getMemoryContext(): Promise<string | null> {
    const memory = await this.readMemory();
    if (!memory) return null;
    return `## Memory\n\n${memory.trim()}`;
  }

  /** Check if MEMORY.md file exists. */
  async hasMemory(): Promise<boolean> {
    return fs.existsSync(path.join(this.workspace, 'MEMORY.md'));
  }

  /** Delete the MEMORY.md file. */
  async deleteMemory(): Promise<void> {
    const filePath = path.join(this.workspace, 'MEMORY.md');
    try {
      await fsp.unlink(filePath);
    } catch {
      // File doesn't exist — already deleted
    }
  }

  /** Append content to the MEMORY.md file (creates if not exists). */
  async updateMemory(append: string): Promise<void> {
    const existing = await this.readMemory();
    const now = new Date().toISOString().split('T')[0];
    const entry = `\n\n### ${now}\n${append.trim()}`;
    const content = existing ? `${existing.trimEnd()}${entry}` : `# Memory\n${entry}`;
    await this.writeMemory(content);
  }

  /** Get the total count of entries in the history file. */
  async getHistoryCount(): Promise<number> {
    const filePath = path.join(this.workspace, MEMORY_DIR, HISTORY_FILE);
    if (!fs.existsSync(filePath)) return 0;
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      return content.trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
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
    const filePath = path.join(this.workspace, MEMORY_DIR, HISTORY_FILE);
    await this._atomicWrite(filePath, '');
  }

  /** Get the full path to the history file. */
  getHistoryPath(): string {
    return path.join(this.workspace, MEMORY_DIR, HISTORY_FILE);
  }

  /** Get the path to the .slide memory directory. */
  getMemoryDir(): string {
    return path.join(this.workspace, MEMORY_DIR);
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
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fsp.writeFile(tmpPath, content, 'utf-8');
    await fsp.rename(tmpPath, filePath);
  }
}

// ── Simplified Consolidator ──

export class Consolidator {
  /**
   * Summarize memory (simplified: no LLM call, just extracts recent entries).
   * Full nanobot Consolidator uses LLM summarization; this is a lightweight
   * version that archives recent history entries.
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
   * Merge recent history into MEMORY.md as structured entries,
   * then compact the history file to prevent unbounded growth.
   * This is the nanobot-style consolidation pipeline.
   */
  async consolidateToMemory(store: MemoryStore, keepCount?: number): Promise<void> {
    const summary = await this.summarize(store);
    if (summary && summary !== 'No recent memory entries.') {
      await store.updateMemory(summary);
    }
    await store.clearHistory();
    // Any future entries start fresh after the consolidation point
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
