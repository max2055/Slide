/**
 * Session + SessionManager — TypeScript session persistence implemented for Slide.
 *
 * Session: per-conversation state container with message history and metadata.
 * SessionManager: JSONL-persisted session store with LRU cache, TTL-based
 * auto-compaction, file cap enforcement, and corrupted session repair.
 *
 * The implementation uses an LRU-cached store, atomic JSONL writes, SHA-256
 * filesystem-safe keys, and integrated automatic compaction.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { referenceMessages } from './context-block.js';
import { sourceHash, normalizeToolGroups, estimatePromptTokens } from './runtime/context-manager.js';
import { conservativeTextTokens } from './token-estimation.js';
import type { Message } from './types.js';
import { compatibleMessageParts, acknowledgeMessageParts, statusForStopReason } from './message-parts.js';

// ── Constants ──

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MINUTES = 0; // 0 = disabled
const DEFAULT_MAX_MESSAGES_PER_SESSION = 500;
const DEFAULT_RECENT_SUFFIX_MESSAGES = 8;
const INTERNAL_SESSION_PREFIXES = ['subagent:', 'dream:', 'cron:'];

// ── Types ──

export interface SessionEntry {
  messageParts?: import('./message-parts.js').MessageParts;
  attachments?: import('./message-parts.js').AttachmentSource[];
  id?: string;
  runId?: string;
  turnId?: string;
  source?: 'fact' | 'derived' | 'runtime' | 'synthetic';
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
  context_summary?: { text: string; generation: number; provenance: 'original' | 'legacy/unknown'; sourceIds: string[]; sourceHash?: string;
    previousSummary?: { generation: number; sourceHash?: string; summaryHash?: string }; legacyEntries?: SessionEntry[] };
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
  private projectionLimit?: number;

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

  /** Conservative text budget, never measured provider usage. */
  static estimateTokens(text: string | null): number {
    return conservativeTextTokens(text);
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
      id: extra?.id ?? crypto.randomUUID(),
      source: extra?.source ?? 'fact',
    };
    if (entry.role === 'user') entry.turnId ??= entry.id;
    else entry.turnId ??= [...this.messages].reverse().find(m => m.role === 'user')?.turnId;
    this.appendFacts([entry]);
    this.updatedAt = Date.now();
  }

  /** Migrate legacy IDs deterministically; identical repeated text remains distinct. */
  ensureFactIds(): void {
    let turnId: string | undefined;
    for (let i = 0; i < this.messages.length; i++) {
      const entry = this.messages[i];
      if (entry.source && entry.source !== 'fact') throw new Error('INVALID_CANONICAL_FACT');
      entry.id ??= `legacy_${crypto.createHash('sha256').update(this.sessionKey + ':' + i + ':' + JSON.stringify(entry)).digest('hex')}`;
      if (entry.role === 'user') turnId = entry.turnId ?? entry.id;
      entry.turnId ??= turnId ?? `legacy_turn_${this.sessionKey}`;
      entry.runId ??= `legacy_run_${entry.turnId}`;
      entry.source ??= 'fact';
      if (!entry.messageParts) this.messages[i] = compatibleMessageParts(entry);
    }
  }

  appendFacts(entries: SessionEntry[]): void {
    this.ensureFactIds();
    for (const entry of entries) {
      if (entry.source && entry.source !== 'fact') continue;
      const existing = entry.id && this.messages.find(m => m.id === entry.id);
      if (existing) {
        const payload = (m: SessionEntry) => JSON.stringify([m.role, m.content, m.tool_calls, m.tool_call_id, m.reasoning_content, m.thinking_blocks, m.attachments]);
        if (payload(existing) !== payload(entry)) throw new Error('CANONICAL_ID_CONFLICT');
        continue;
      }
      this.messages.push(structuredClone(entry));
    }
    this.ensureFactIds();
  }

  /** Read-only snapshot. Cursor is a stable message ID, never a model offset. */
  getCanonicalPage(limit = 200, after?: string): { messages: Readonly<SessionEntry>[]; nextAfter: string | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_CANONICAL_PAGE');
    this.ensureFactIds();
    const index = after === undefined ? -1 : this.messages.findIndex(m => m.id === after);
    if (after !== undefined && index < 0) throw new Error('CANONICAL_CURSOR_NOT_FOUND');
    const page = this.messages.slice(index + 1, index + 1 + limit);
    return { messages: structuredClone(page), nextAfter: index + 1 + limit < this.messages.length ? page.at(-1)!.id! : null };
  }

  canonicalHash(): string {
    this.ensureFactIds();
    return crypto.createHash('sha256').update(JSON.stringify(this.messages.map(({ messageParts: _parts, ...fact }) => fact))).digest('hex');
  }

  /**
   * Get session history with optional message count and token budget.
   * Returns bounded history by message count and token budget.
   * - Skips messages before last_consolidated.
   * - Aligns to first user turn (drops leading assistant/tool messages).
   * - Drops orphan tool results at front (no preceding assistant with matching tool_call).
   */
  getHistory(
    maxMessages?: number,
    tokenBudget?: number,
  ): SessionEntry[] {
    this.ensureFactIds();
    const policies = this.messages.filter(m => m.role === 'system');
    let msgs = this.messages.slice(this.last_consolidated).filter(m => m.role !== 'system');

    // Align to first user turn: drop leading non-user messages
    const firstUserIdx = msgs.findIndex(m => m.role === 'user');
    if (firstUserIdx > 0) {
      msgs = msgs.slice(firstUserIdx);
    }

    // Drop orphan tool results at front
    while (msgs.length > 0 && msgs[0].role === 'tool') {
      msgs = msgs.slice(1);
    }

    const summary = this.metadata.context_summary;
    if (summary && (!Number.isSafeInteger(summary.generation) || summary.generation < 0 ||
      !['original', 'legacy/unknown'].includes(summary.provenance) || !Array.isArray(summary.sourceIds) ||
      (summary.provenance === 'original' && !summary.sourceHash))) throw new Error('INVALID_SESSION_SUMMARY');
    if (summary?.sourceHash) {
      const sources = this.messages.slice(0, summary.sourceIds.length);
      if (JSON.stringify(sources.map(m => m.id)) !== JSON.stringify(summary.sourceIds) || sourceHash(sources as Message[]) !== summary.sourceHash) throw new Error('SUMMARY_SOURCE_CHANGED');
    }
    const derived = summary ? referenceMessages('session_summary', { text: summary.text, generation: summary.generation, provenance: summary.provenance }, summary.sourceHash ?? 'legacy') : [];
    // Slice whole user turns; a count/token budget must never cut a parallel batch.
    const limit = Math.min(maxMessages && maxMessages > 0 ? maxMessages : Infinity, this.projectionLimit ?? Infinity);
    const starts = msgs.flatMap((m, i) => m.role === 'user' ? [i] : []);
    let start = starts.at(-1) ?? 0;
    for (let i = starts.length - 1; i >= 0; i--) {
      const candidate = msgs.slice(starts[i]);
      const tokens = estimatePromptTokens([...policies, ...derived, ...normalizeToolGroups(candidate as Message[])] as Message[], []);
      if (candidate.length > limit || (tokenBudget && tokenBudget > 0 && tokens > tokenBudget)) {
        if (i === starts.length - 1) start = starts[i];
        break;
      }
      start = starts[i];
    }
    return [...structuredClone(policies), ...derived, ...normalizeToolGroups(structuredClone(msgs.slice(start)) as Message[])] as SessionEntry[];
  }

  /** Clear all messages. */
  clear(): void {
    this.recordRetention(this.messages, 'clear');
    this.messages = [];
    this.last_consolidated = 0;
    this.updatedAt = Date.now();
  }

  /** Retain only a legal suffix of messages that keeps user-turn alignment. */
  retainRecentLegalSuffix(count: number): void {
    if (count > 0) this.projectionLimit = count;
  }

  /** Enforce file cap by removing older messages. */
  enforceFileCap(maxMessages: number): void {
    this.retainRecentLegalSuffix(maxMessages);
  }

  /** Explicit fact retention, independent of model budgets. Keeps the last turn. */
  retainCanonicalRecentTurns(turns: number, reason: string): void {
    if (!Number.isSafeInteger(turns) || turns < 1 || !reason.trim()) throw new Error('INVALID_RETENTION_POLICY');
    const starts = this.messages.flatMap((m, i) => m.role === 'user' ? [i] : []);
    const end = starts.at(-turns) ?? 0;
    if (!end) return;
    this.recordRetention(this.messages.slice(0, end), reason);
    this.messages = this.messages.slice(end);
    this.last_consolidated = Math.max(0, this.last_consolidated - end);
  }

  private recordRetention(removed: SessionEntry[], reason: string): void {
    const cp = this.metadata.runtime_checkpoint;
    const pending = cp?.pendingToolCalls ?? cp?.pending_tool_calls;
    if (Array.isArray(pending) && pending.length) throw new Error('UNSETTLED_INTENT_RETENTION_DENIED');
    const results = new Set(removed.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    if (removed.some(m => m.tool_calls?.some(c => !results.has(c.id)))) throw new Error('UNSETTLED_INTENT_RETENTION_DENIED');
    if (!removed.length) return;
    this.ensureFactIds();
    const boundaries = (this.metadata.retention_boundaries ?? []) as unknown[];
    if (boundaries.length >= 1000) throw new Error('RETENTION_AUDIT_CAPACITY_EXCEEDED');
    this.metadata.retention_boundaries = [...boundaries, { reason, at: new Date().toISOString(), count: removed.length,
      firstId: removed[0].id, lastId: removed.at(-1)!.id, hash: crypto.createHash('sha256').update(JSON.stringify(removed)).digest('hex') }];
  }
}

// ── SessionManager ──

// ── AutoCompact ──
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
   * Prepare a session and return any available compacted summary.
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
    const meta = session.metadata.context_summary?.text ?? session.metadata._last_summary;
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
      session.ensureFactIds();
      const previous = session.metadata.context_summary;
      session.metadata.context_summary = { text: summaryText, generation: (previous?.generation ?? 0) + 1,
        provenance: 'original', sourceIds: session.messages.map(m => m.id!), sourceHash: sourceHash(session.messages as Message[]),
        ...(previous ? { previousSummary: { generation: previous.generation, sourceHash: previous.sourceHash, summaryHash: sourceHash([{ role: 'tool', content: previous.text }]) } } : {}) };
      delete session.metadata._last_summary;
      this._summaries.set(session.sessionKey, {
        text: summaryText,
        lastActive: new Date(session.updatedAt),
      });
    }

    // Summary/compaction never changes canonical facts.
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
  maxCanonicalMessages?: number;
  maxCanonicalBytes?: number;
}

export class SessionManager {
  private workspace: string;
  private sessionsDir: string;
  private cache: Map<string, Session>;
  private maxSessions: number;
  private maxCanonicalMessages: number;
  private maxCanonicalBytes: number;
  autoCompact: AutoCompact;

  constructor(workspace: string, options?: SessionManagerOptions) {
    this.workspace = workspace;
    this.sessionsDir = path.join(workspace, '.slide', 'sessions');
    this.cache = new Map();
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxCanonicalMessages = options?.maxCanonicalMessages ?? 100_000;
    this.maxCanonicalBytes = options?.maxCanonicalBytes ?? 64 * 1024 * 1024;
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
      const session = loaded;
      if (loaded.messages.length > this.autoCompact['_maxMessages']) {
        loaded.retainRecentLegalSuffix(DEFAULT_RECENT_SUFFIX_MESSAGES);
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

    session.ensureFactIds();

    const filePath = path.join(this.sessionsDir, `${this.safeKey(session.sessionKey)}.jsonl`);

    // Build JSONL lines: one per message + metadata as last line
    const lines: string[] = [];
    const completedTools = new Set(session.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    const storedMessages = session.messages.map(msg => {
      const pending = msg.tool_calls?.some(call => !completedTools.has(call.id));
      try { return acknowledgeMessageParts(msg, { status: msg.messageParts?.status === 'failed' || msg.messageParts?.status === 'discarded' ? msg.messageParts.status :
        pending ? 'partial' : statusForStopReason(msg.metadata?.stopReason), durable: { kind: 'jsonl', reference: msg.id! } }); }
      catch { return structuredClone(msg); }
    });
    for (const msg of storedMessages) {
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
      canonical_version: 1,
    }));

    // Atomic write: tmp + rename
    const content = lines.join('\n') + '\n';
    if (session.messages.length > this.maxCanonicalMessages || Buffer.byteLength(content) > this.maxCanonicalBytes) {
      throw new Error('CANONICAL_CAPACITY_EXCEEDED');
    }
    const tmpPath = filePath + '.' + crypto.randomUUID() + '.tmp';
    await fsp.writeFile(tmpPath, content, 'utf-8');

    if (opts?.fsync) {
      const fd = await fsp.open(tmpPath, 'r+');
      try { await fd.sync(); } finally { await fd.close(); }
    }

    await fsp.rename(tmpPath, filePath);
    if (opts?.fsync) {
      const directory = await fsp.open(this.sessionsDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    session.messages = storedMessages;
  }

  /** Load and atomically migrate valid facts. Repair never invents missing data. */
  _load(sessionKey: string): Session | null {
    const filePath = path.join(this.sessionsDir, `${this.safeKey(sessionKey)}.jsonl`);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const session = new Session(sessionKey);
    let version = 0;
    let corrupt = 0;
    let derived = 0;
    const legacyDerived: SessionEntry[] = [];
    for (const line of content.split('\n').filter(Boolean)) {
      let parsed: Record<string, any>;
      try { parsed = JSON.parse(line); } catch { corrupt++; continue; }
      if (!parsed || typeof parsed !== 'object') { corrupt++; continue; }
      if (parsed.__meta__ || parsed._type === 'session') {
        if (parsed.sessionKey && parsed.sessionKey !== sessionKey) throw new Error('CANONICAL_SESSION_MISMATCH');
        session.metadata = parsed.metadata || {};
        session.createdAt = parsed.createdAt || 0;
        session.updatedAt = parsed.updatedAt || 0;
        session.last_consolidated = parsed.last_consolidated ?? 0;
        version = parsed.canonical_version ?? 0;
      } else if (['user', 'assistant', 'system', 'tool'].includes(parsed.role)) {
        // Old cold-load summary injection is derived, never original system authority.
        if (parsed.source && parsed.source !== 'fact') {
          if (parsed.role === 'system') legacyDerived.push(parsed as SessionEntry);
          derived++; continue;
        }
        session.messages.push(parsed as SessionEntry);
      } else { corrupt++; }
    }
    // Only exact known injected summaries are migrated; a prefix alone is not evidence.
    const legacyText = session.metadata._last_summary;
    if (legacyText && !session.metadata.context_summary) {
      session.metadata.context_summary = { text: legacyText, generation: 0, provenance: 'legacy/unknown', sourceIds: [], legacyEntries: [] };
      delete session.metadata._last_summary;
      derived++;
    }
    if (legacyDerived.length) {
      const prior = session.metadata.context_summary;
      session.metadata.context_summary = prior ? { ...prior, legacyEntries: [...(prior.legacyEntries ?? []), ...legacyDerived] } :
        { text: legacyDerived.map(m => m.content).join('\n'), generation: 0, provenance: 'legacy/unknown', sourceIds: [], legacyEntries: legacyDerived };
    }
    const record = session.metadata.context_summary;
    if (record?.provenance === 'legacy/unknown') {
      session.messages = session.messages.filter(m => {
        const injected = m.role === 'system' && (m.content === `Previous conversation summary:\n${record.text}` ||
          (typeof m.content === 'string' && /^Previous conversation summary \(last active [0-9T:Z.-]+\):\n/.test(m.content) && m.content.slice(m.content.indexOf('\n') + 1) === record.text));
        if (injected) { (record.legacyEntries ??= []).push(structuredClone(m)); derived++; }
        return !injected;
      });
    }
    const missingIds = session.messages.some(m => !m.id || !m.turnId || !m.runId);
    const missingParts = session.messages.some(m => !m.messageParts);
    session.ensureFactIds();
    const completedTools = new Set(session.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    if (missingParts) session.messages = session.messages.map(m => {
      const pending = m.tool_calls?.some(call => !completedTools.has(call.id));
      try { return acknowledgeMessageParts(m, { status: pending ? 'partial' : statusForStopReason(m.metadata?.stopReason), durable: { kind: 'jsonl', reference: m.id! } }); }
      catch { return m; }
    });
    if (!version) session.metadata.history_gaps = [...((session.metadata.history_gaps ?? []) as unknown[]),
      { kind: 'legacy_retention_unknown', detail: 'Older versions may have trimmed facts; unavailable facts cannot be recovered.' }];
    if (corrupt || derived) session.metadata.history_gaps = [...((session.metadata.history_gaps ?? []) as unknown[]),
      { kind: 'repair', corruptLines: corrupt, excludedDerived: derived }];
    if (!version || missingIds || missingParts || corrupt || derived) {
      const lines = session.messages.map(m => JSON.stringify(m));
      lines.push(JSON.stringify({ _type: 'session', __meta__: true, sessionKey, canonical_version: 1,
        metadata: session.metadata, createdAt: session.createdAt, updatedAt: session.updatedAt,
        last_consolidated: session.last_consolidated }));
      const repaired = lines.join('\n') + '\n';
      if (session.messages.length > this.maxCanonicalMessages || Buffer.byteLength(repaired) > this.maxCanonicalBytes) throw new Error('CANONICAL_CAPACITY_EXCEEDED');
      const tmp = filePath + '.' + crypto.randomUUID() + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeFileSync(fd, repaired, 'utf-8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, filePath);
      const directory = fs.openSync(this.sessionsDir, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return session;
  }

  _repair(sessionKey: string): Session | null { return this._load(sessionKey); }

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
