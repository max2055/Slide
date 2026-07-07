/**
 * Session + SessionManager — ported from nanobot session/manager.py
 *
 * Session: per-conversation state container with message history and metadata.
 * SessionManager: JSONL-persisted session store with LRU cache, TTL-based
 * auto-compaction, file cap enforcement, and corrupted session repair.
 *
 * Porting notes:
 * - nanobot's dataclass-based Session → class with slots
 * - nanobot's SessionManager → LRU-cached store with atomic JSONL writes
 * - SHA-256 safeKey for filesystem-safe filenames
 * - AutoCompact (nanobot autocompact.py) → integrated into SessionManager
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ── Constants ──

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MINUTES = 0; // 0 = disabled
const DEFAULT_MAX_MESSAGES_PER_SESSION = 500;
const DEFAULT_RECENT_SUFFIX_MESSAGES = 8;
const INTERNAL_SESSION_PREFIXES = ['subagent:', 'dream:', 'cron:'];

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

// ── AutoCompact ──
// Ported from nanobot agent/autocompact.py
// Proactively compresses idle sessions to reduce token cost and latency.

export interface AutoCompactOptions {
  /** Session TTL in minutes. 0 = disabled. */
  sessionTtlMinutes?: number;
  /** Max messages per session before trimming. */
  maxMessagesPerSession?: number;
  /** Number of recent messages to keep as suffix when trimming. */
  recentSuffixMessages?: number;
}

export class AutoCompact {
  private _ttl: number;
  private _maxMessages: number;
  private _recentSuffix: number;
  private _archiving: Set<string> = new Set();
  private _summaries: Map<string, { text: string; lastActive: Date }> = new Map();

  constructor(opts: AutoCompactOptions = {}) {
    this._ttl = opts.sessionTtlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;
    this._maxMessages = opts.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
    this._recentSuffix = opts.recentSuffixMessages ?? DEFAULT_RECENT_SUFFIX_MESSAGES;
  }

  /** Check if a session is expired based on TTL. */
  isExpired(updatedAt: number | Date | string | undefined): boolean {
    if (this._ttl <= 0 || !updatedAt) return false;
    const ts = typeof updatedAt === 'number'
      ? new Date(updatedAt)
      : typeof updatedAt === 'string'
        ? new Date(updatedAt)
        : updatedAt;
    if (isNaN(ts.getTime())) return false;
    return (Date.now() - ts.getTime()) >= this._ttl * 60_000;
  }

  /** Check if a session key is internal (subagent, dream, cron). */
  static isInternalSession(key: string): boolean {
    return INTERNAL_SESSION_PREFIXES.some(p => key.startsWith(p));
  }

  /**
   * Prepare a session for use. If it was previously compacted, returns the summary.
   * Mirrors nanobot's autocompact.prepare_session().
   */
  prepareSession(session: Session, key: string): { session: Session; summary: string | null } {
    if (AutoCompact.isInternalSession(key)) {
      this._archiving.delete(key);
      this._summaries.delete(key);
      return { session, summary: null };
    }

    // Hot path: in-memory summary
    const entry = this._summaries.get(key);
    if (entry) {
      this._summaries.delete(key);
      return {
        session,
        summary: `Previous conversation summary (last active ${entry.lastActive.toISOString()}):\n${entry.text}`,
      };
    }

    // Cold path: summary persisted in session metadata
    const meta = session.metadata._last_summary;
    if (typeof meta === 'string' && meta.length > 0) {
      return {
        session,
        summary: `Previous conversation summary:\n${meta}`,
      };
    }

    return { session, summary: null };
  }

  /**
   * Compact a session: trim old messages, keep a recent suffix.
   * Stores summary in metadata for cold-start recovery.
   */
  compactSession(session: Session, summaryText: string | null): void {
    if (session.messages.length > this._maxMessages) {
      session.retainRecentLegalSuffix(this._recentSuffix);
    }

    if (summaryText && summaryText !== '(nothing)') {
      session.metadata._last_summary = summaryText;
      this._summaries.set(session.sessionKey, {
        text: summaryText,
        lastActive: new Date(session.updatedAt),
      });
    }

    session.last_consolidated = session.messages.length;
    session.updatedAt = Date.now();
  }

  /** Get the archiving set (for checking if a session is being compacted). */
  get archiving(): ReadonlySet<string> { return this._archiving; }

  /** Mark a session for archiving. */
  markArchiving(key: string): void { this._archiving.add(key); }
  unmarkArchiving(key: string): void { this._archiving.delete(key); }

  /** Store a summary for later injection. */
  storeSummary(key: string, text: string): void {
    this._summaries.set(key, { text, lastActive: new Date() });
  }
}

// ── SessionManager ──

export interface SessionManagerOptions {
  maxSessions?: number;
  sessionTtlMinutes?: number;
  maxMessagesPerSession?: number;
}

export class SessionManager {
  private workspace: string;
  private sessionsDir: string;
  private cache: Map<string, Session>;
  private maxSessions: number;
  autoCompact: AutoCompact;

  constructor(workspace: string, options?: SessionManagerOptions) {
    this.workspace = workspace;
    this.sessionsDir = path.join(workspace, '.slide', 'sessions');
    this.cache = new Map();
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.autoCompact = new AutoCompact({
      sessionTtlMinutes: options?.sessionTtlMinutes,
      maxMessagesPerSession: options?.maxMessagesPerSession,
    });
  }

  /** SHA-256 hash for filesystem-safe session key filename. */
  safeKey(sessionKey: string): string {
    return crypto.createHash('sha256').update(sessionKey).digest('hex');
  }

  /** Get or create a session by key. Handles auto-compaction on load. */
  getOrCreate(sessionKey: string): Session {
    const existing = this.cache.get(sessionKey);
    if (existing) return existing;

    // Evict LRU if at capacity
    if (this.cache.size >= this.maxSessions) {
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }

    // Try loading from disk (with repair for corrupted files)
    const loaded = this._load(sessionKey) ?? this._repair(sessionKey);
    if (loaded) {
      // Run auto-compaction check
      const { session, summary } = this.autoCompact.prepareSession(loaded, sessionKey);
      if (summary) {
        // Inject summary as a system message so the LLM knows previous context
        session.addMessage('system', summary);
      }
      if (loaded.messages.length > this.autoCompact['_maxMessages']) {
        loaded.retainRecentLegalSuffix(DEFAULT_RECENT_SUFFIX_MESSAGES);
        loaded.last_consolidated = loaded.messages.length;
        loaded.updatedAt = Date.now();
      }
      this.cache.set(sessionKey, session);
      return session;
    }

    const session = new Session(sessionKey);
    this.cache.set(sessionKey, session);
    return session;
  }

  /** Save session to JSONL disk file. Atomic write with fsync. */
  async save(session: Session, opts?: { fsync?: boolean }): Promise<void> {
    await fsp.mkdir(this.sessionsDir, { recursive: true });

    // Enforce file cap before saving
    session.enforceFileCap(DEFAULT_MAX_MESSAGES_PER_SESSION);

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
      last_consolidated: session.last_consolidated,
    }));

    // Atomic write: tmp + rename
    const tmpPath = filePath + '.tmp';
    await fsp.writeFile(tmpPath, lines.join('\n') + '\n', 'utf-8');

    if (opts?.fsync) {
      const fd = await fsp.open(tmpPath, 'r+');
      await fd.sync();
      await fd.close();
    }

    await fsp.rename(tmpPath, filePath);
  }

  /** Load session from disk. Returns null if missing or completely unreadable. */
  _load(sessionKey: string): Session | null {
    const filePath = path.join(this.sessionsDir, `${this.safeKey(sessionKey)}.jsonl`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;

      const session = new Session(sessionKey);

      for (const line of lines) {
        try {
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
        } catch {
          // Skip corrupted line — repair mode would handle this
        }
      }

      return session;
    } catch {
      return null;
    }
  }

  /**
   * Attempt to repair a corrupted session file.
   * Reads line by line, keeping only valid JSON lines.
   * Mirrors nanobot's SessionManager._repair().
   */
  _repair(sessionKey: string): Session | null {
    const filePath = path.join(this.sessionsDir, `${this.safeKey(sessionKey)}.jsonl`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;

      const session = new Session(sessionKey);
      let validLines = 0;
      let metaLine: Record<string, unknown> | null = null;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.__meta__ || parsed._type === 'session') {
            metaLine = parsed;
            validLines++;
          } else if (parsed.role) {
            session.messages.push(parsed as SessionEntry);
            validLines++;
          }
        } catch {
          // Skip corrupted lines
        }
      }

      // Must have at least metadata or one message
      if (validLines === 0) {
        // Delete the corrupted file so we start fresh
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        return null;
      }

      if (metaLine) {
        session.metadata = (metaLine.metadata as SessionMetadata) || {};
        session.createdAt = (metaLine.createdAt as number) || Date.now();
        session.updatedAt = (metaLine.updatedAt as number) || Date.now();
        if (metaLine.last_consolidated !== undefined) {
          session.last_consolidated = metaLine.last_consolidated as number;
        }
      }

      // Rewrite repaired file
      const repairedLines: string[] = [];
      for (const msg of session.messages) {
        repairedLines.push(JSON.stringify(msg));
      }
      repairedLines.push(JSON.stringify({
        _type: 'session', __meta__: true,
        sessionKey: session.sessionKey,
        metadata: session.metadata,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        last_consolidated: session.last_consolidated,
      }));

      try {
        fs.writeFileSync(filePath, repairedLines.join('\n') + '\n', 'utf-8');
      } catch {
        // Can't repair — delete and start fresh
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        return null;
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

  /**
   * List all persisted sessions with metadata.
   * Returns array of { key, createdAt, updatedAt, messageCount } for each session.
   */
  async listSessions(): Promise<Array<{ key: string; createdAt: number; updatedAt: number; messageCount: number }>> {
    try {
      await fsp.mkdir(this.sessionsDir, { recursive: true });
      const files = await fsp.readdir(this.sessionsDir);
      const jsonlFiles = files.filter((f: string) => f.endsWith('.jsonl'));
      const results: Array<{ key: string; createdAt: number; updatedAt: number; messageCount: number }> = [];

      for (const f of jsonlFiles) {
        const filePath = path.join(this.sessionsDir, f);
        try {
          const content = await fsp.readFile(filePath, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          let metaLine: Record<string, unknown> | null = null;
          let msgCount = 0;

          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.__meta__ || parsed._type === 'session') {
                metaLine = parsed;
              } else if (parsed.role) {
                msgCount++;
              }
            } catch { /* skip */ }
          }

          if (metaLine?.sessionKey) {
            results.push({
              key: metaLine.sessionKey as string,
              createdAt: (metaLine.createdAt as number) || 0,
              updatedAt: (metaLine.updatedAt as number) || 0,
              messageCount: msgCount,
            });
          }
        } catch {
          // Skip unreadable files
        }
      }

      return results;
    } catch {
      return [];
    }
  }
}
