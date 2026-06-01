/**
 * Session + SessionManager — ported from nanobot session/manager.py
 *
 * Session: per-conversation state container with message history and metadata.
 * SessionManager: JSONL-persisted session store with LRU cache.
 *
 * Porting notes:
 * - nanobot's dataclass-based Session → class with slots
 * - nanobot's SessionManager → LRU-cached store with atomic JSONL writes
 * - SHA-256 safeKey for filesystem-safe filenames
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ── Types ──

export interface SessionEntry {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string | null;
  thinking_blocks?: unknown[];
  timestamp?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionMetadata {
  _last_summary?: string;
  runtime_checkpoint?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionData {
  sessionKey: string;
  messages: SessionEntry[];
  metadata: SessionMetadata;
  createdAt: number;
  updatedAt: number;
}

// ── Session ──

export class Session {
  public sessionKey: string;
  public messages: SessionEntry[];
  public metadata: SessionMetadata;
  public createdAt: number;
  public updatedAt: number;
  public last_consolidated: number;

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
    this.messages = [];
    this.metadata = {};
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.last_consolidated = 0;
  }

  /** Backward-compat: session key alias. */
  get key(): string { return this.sessionKey; }

  /** Backward-compat: updated_at as Date object. */
  get updated_at(): Date { return new Date(this.updatedAt); }

  /** Estimate token count for a message text (char-based ~4 chars/token). */
  static estimateTokens(text: string | null): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /** Add a message to the session history. */
  addMessage(
    role: SessionEntry['role'],
    content: string | null,
    extra?: Partial<SessionEntry>,
  ): void {
    const entry: SessionEntry = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    this.messages.push(entry);
    this.updatedAt = Date.now();
  }

  /**
   * Get session history with optional message count and token budget.
   * Mimics nanobot's get_history(msg_count, token_budget).
   * - Skips messages before last_consolidated.
   * - Aligns to first user turn (drops leading assistant/tool messages).
   * - Drops orphan tool results at front (no preceding assistant with matching tool_call).
   */
  getHistory(
    maxMessages?: number,
    tokenBudget?: number,
  ): SessionEntry[] {
    let msgs = this.messages;

    // Skip consolidated messages
    if (this.last_consolidated > 0) {
      msgs = msgs.slice(this.last_consolidated);
    }

    // Align to first user turn: drop leading non-user messages
    const firstUserIdx = msgs.findIndex(m => m.role === 'user');
    if (firstUserIdx > 0) {
      msgs = msgs.slice(firstUserIdx);
    }

    // Drop orphan tool results at front
    while (msgs.length > 0 && msgs[0].role === 'tool') {
      msgs = msgs.slice(1);
    }

    if (maxMessages && maxMessages > 0 && msgs.length > maxMessages) {
      msgs = msgs.slice(-maxMessages);
    }

    if (tokenBudget && tokenBudget > 0) {
      let total = 0;
      const result: SessionEntry[] = [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const text = typeof msgs[i].content === 'string' ? msgs[i].content as string : '';
        const tokens = Session.estimateTokens(text);
        if (total + tokens > tokenBudget && result.length > 0) break;
        total += tokens;
        result.unshift(msgs[i]);
      }
      return result;
    }

    return msgs;
  }

  /** Clear all messages. */
  clear(): void {
    this.messages = [];
    this.last_consolidated = 0;
    this.updatedAt = Date.now();
  }

  /** Retain only a legal suffix of messages that keeps user-turn alignment. */
  retainRecentLegalSuffix(count: number): void {
    if (count <= 0 || count >= this.messages.length) return;
    // Keep last `count` messages aligned to user turns
    const suffix = this.messages.slice(-count);
    // Ensure first message of suffix is a user message
    const firstUserIdx = suffix.findIndex(m => m.role === 'user');
    if (firstUserIdx > 0) {
      this.messages = suffix.slice(firstUserIdx);
    } else {
      this.messages = suffix;
    }
    this.updatedAt = Date.now();
  }

  /** Enforce file cap by removing older messages. */
  enforceFileCap(maxMessages: number): void {
    if (this.messages.length > maxMessages) {
      this.messages = this.messages.slice(-maxMessages);
      this.updatedAt = Date.now();
    }
  }
}

// ── SessionManager ──

export class SessionManager {
  private workspace: string;
  private sessionsDir: string;
  private cache: Map<string, Session>;
  private maxSessions: number;

  constructor(workspace: string, options?: { maxSessions?: number }) {
    this.workspace = workspace;
    this.sessionsDir = path.join(workspace, '.slide', 'sessions');
    this.cache = new Map();
    this.maxSessions = options?.maxSessions ?? 100;
  }

  /** SHA-256 hash for filesystem-safe session key filename. */
  safeKey(sessionKey: string): string {
    return crypto.createHash('sha256').update(sessionKey).digest('hex');
  }

  /** Get or create a session by key. */
  getOrCreate(sessionKey: string): Session {
    const existing = this.cache.get(sessionKey);
    if (existing) return existing;

    // Evict LRU if at capacity
    if (this.cache.size >= this.maxSessions) {
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }

    // Try loading from disk
    const loaded = this._load(sessionKey);
    if (loaded) {
      this.cache.set(sessionKey, loaded);
      return loaded;
    }

    const session = new Session(sessionKey);
    this.cache.set(sessionKey, session);
    return session;
  }

  /** Save session to JSONL disk file. */
  async save(session: Session): Promise<void> {
    await fsp.mkdir(this.sessionsDir, { recursive: true });

    const filePath = path.join(this.sessionsDir, `${this.safeKey(session.sessionKey)}.jsonl`);

    // Build JSONL lines: one per message + metadata as last line
    const lines: string[] = [];
    for (const msg of session.messages) {
      lines.push(JSON.stringify(msg));
    }
    // Metadata line
    lines.push(JSON.stringify({
      _type: 'session',
      __meta__: true,
      sessionKey: session.sessionKey,
      metadata: session.metadata,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
    }));

    // Atomic write: tmp + rename
    const tmpPath = filePath + '.tmp';
    await fsp.writeFile(tmpPath, lines.join('\n') + '\n', 'utf-8');
    await fsp.rename(tmpPath, filePath);
  }

  /** Load session from disk. */
  _load(sessionKey: string): Session | null {
    const filePath = path.join(this.sessionsDir, `${this.safeKey(sessionKey)}.jsonl`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;

      const session = new Session(sessionKey);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.__meta__ || parsed._type === 'session') {
          session.metadata = parsed.metadata || {};
          session.createdAt = parsed.createdAt || Date.now();
          session.updatedAt = parsed.updatedAt || Date.now();
          if (parsed.last_consolidated !== undefined) {
            session.last_consolidated = parsed.last_consolidated;
          }
        } else {
          session.messages.push(parsed as SessionEntry);
        }
      }

      return session;
    } catch {
      return null;
    }
  }

  /** Flush all cached sessions to disk. Returns count of sessions saved. */
  async flushAll(): Promise<number> {
    let count = 0;
    for (const session of this.cache.values()) {
      await this.save(session);
      count++;
    }
    return count;
  }

  /** Invalidate (remove from cache, not from disk). */
  invalidate(sessionKey: string): void {
    this.cache.delete(sessionKey);
  }

  /** Delete session from cache and disk. */
  async deleteSession(sessionKey: string): Promise<void> {
    this.cache.delete(sessionKey);
    const filePath = path.join(this.sessionsDir, `${this.safeKey(sessionKey)}.jsonl`);
    try {
      await fsp.unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  /** List all persisted session keys. */
  async listSessions(): Promise<string[]> {
    try {
      const files = await fsp.readdir(this.sessionsDir);
      const jsonlFiles = files.filter((f: string) => f.endsWith('.jsonl'));
      const keys: string[] = [];
      for (const f of jsonlFiles) {
        const filePath = path.join(this.sessionsDir, f);
        const content = await fsp.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        // Find the metadata line with the session key
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed._type === 'session' || parsed.__meta__) {
              if (parsed.sessionKey) keys.push(parsed.sessionKey);
              break;
            }
          } catch { /* skip invalid lines */ }
        }
      }
      return keys;
    } catch {
      return [];
    }
  }
}
