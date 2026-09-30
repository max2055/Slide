/**
 * Tests for Session and SessionManager.
 *
 * Covers the Slide TypeScript session manager behavior.
 * Run: npx vitest run packages/agent-core/src/__tests__/session.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Session, SessionManager, AutoCompact } from "../session.js";
import { microcompact } from '../runtime/context-manager.js';
import type { SessionEntry } from "../session.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Helpers ──

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
}

describe("Session", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session("test-channel:chat-1");
  });

  it("addMessage creates entry with timestamp", () => {
    session.addMessage("user", "Hello");
    expect(session.messages.length).toBe(1);
    const entry = session.messages[0];
    expect(entry.role).toBe("user");
    expect(entry.content).toBe("Hello");
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe("string");
    // ISO string
    expect(() => new Date(entry.timestamp!)).not.toThrow();
  });

  it("addMessage accepts extra kwargs", () => {
    session.addMessage("assistant", "Reply", {
      tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "test", arguments: "{}" } }],
    });
    const entry = session.messages[0];
    expect(entry.role).toBe("assistant");
    expect(entry.tool_calls).toBeDefined();
    expect(entry.tool_calls!.length).toBe(1);
  });

  it("getHistory respects maxMessages limit", () => {
    for (let i = 0; i < 10; i++) {
      session.addMessage(i % 2 === 0 ? "user" : "assistant", `Message ${i}`);
    }
    const history = session.getHistory(5);
    expect(history.length).toBeLessThanOrEqual(5);
  });

  it("getHistory aligns to first user turn", () => {
    // Add a mix: start with assistant, then user, then assistant
    session.addMessage("assistant", "First assistant (pre-session)");
    session.addMessage("user", "First user");
    session.addMessage("assistant", "Second assistant");
    session.addMessage("user", "Second user");

    const history = session.getHistory(10);
    // Should start at the first user turn, skipping leading assistant
    expect(history.length).toBeGreaterThanOrEqual(1);
    if (history.length > 0) {
      expect(history[0].role).toBe("user");
    }
  });

  it("getHistory drops orphan tool results at front", () => {
    session.addMessage("tool", "Orphan tool result", { tool_call_id: "orphan_1" });
    session.addMessage("user", "Real user message");
    session.addMessage("assistant", "Assistant reply");

    const history = session.getHistory(10);
    // The orphan tool result should be dropped
    expect(history.length).toBe(2);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
  });

  it("seconds between add and getHistory push", () => {
    // Quick sanity: updated_at updates
    const before = session.updated_at;
    session.addMessage("user", "hello");
    const after = session.updated_at;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("clear resets messages and updates", () => {
    session.addMessage("user", "hello");
    expect(session.messages.length).toBe(1);
    session.clear();
    expect(session.messages.length).toBe(0);
    expect(session.last_consolidated).toBe(0);
  });

  it('derived/runtime/synthetic projections cannot append canonical facts', () => {
    session.addMessage('user', 'real');
    const hash = session.canonicalHash();
    for (const source of ['derived', 'runtime', 'synthetic'] as const) session.addMessage('tool', 'context only', { source });
    expect(session.canonicalHash()).toBe(hash);
  });

  it("getHistory with last_consolidated skips consolidated messages", () => {
    session.addMessage("user", "Old message 1");
    session.addMessage("assistant", "Old reply 1");
    session.last_consolidated = 2;
    session.addMessage("user", "New message");

    const history = session.getHistory(10);
    // Should only include messages after last_consolidated: "New message" + any tool calls
    expect(history.length).toBe(1);
    expect(history[0].content).toBe("New message");
  });

  it("retainRecentLegalSuffix keeps recent suffix", () => {
    for (let i = 0; i < 10; i++) {
      session.addMessage(i % 2 === 0 ? "user" : "assistant", `Message ${i}`);
    }
    expect(session.messages.length).toBe(10);
    session.retainRecentLegalSuffix(4);
    expect(session.messages.length).toBe(10);
    expect(session.getHistory().length).toBeLessThanOrEqual(4);
  });

  it("legacy enforceFileCap only bounds the projection", () => {
    for (let i = 0; i < 15; i++) {
      session.addMessage(i % 2 === 0 ? "user" : "assistant", `Message ${i}`);
    }
    expect(session.messages.length).toBe(15);
    session.enforceFileCap(5);
    expect(session.messages.length).toBe(15);
    expect(session.getHistory().length).toBeLessThanOrEqual(5);
  });
});

describe("SessionManager", () => {
  let manager: SessionManager;
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    manager = new SessionManager(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retains 501+ facts and parallel tool batches across save/load/projection/summary', async () => {
    const session = manager.getOrCreate('parallel');
    for (let i = 0; i < 101; i++) {
      session.addMessage('user', `turn ${i}`);
      session.addMessage('assistant', null, { tool_calls: ['a', 'b'].map(n => ({ id: `${i}-${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } })) });
      for (const name of ['a', 'b']) session.addMessage('tool', 'large result '.repeat(100), { name: 'read_file', tool_call_id: `${i}-${name}` });
      session.addMessage('assistant', 'done');
    }
    const hash = session.canonicalHash();
    const facts = structuredClone(session.messages);
    const projection = session.getHistory(7, 20);
    expect(projection).toHaveLength(5); // newest complete turn is protected even over budget
    expect(projection[1].tool_calls).toHaveLength(2);
    expect(projection.filter(m => m.role === 'tool')).toHaveLength(2);
    microcompact(session.getHistory() as any);
    new AutoCompact({ maxMessagesPerSession: 5 }).compactSession(session, 'summary');
    expect(session.canonicalHash()).toBe(hash);
    await manager.save(session, { fsync: true });
    const persistedFacts = structuredClone(session.messages);
    expect(persistedFacts.map(({ messageParts: _parts, ...fact }) => fact)).toEqual(facts.map(({ messageParts: _parts, ...fact }) => fact));
    for (let cold = 0; cold < 3; cold++) {
      manager = new SessionManager(dir);
      const loaded = manager.getOrCreate('parallel');
      expect(loaded.messages).toEqual(persistedFacts);
      expect(loaded.canonicalHash()).toBe(hash);
      await manager.save(loaded);
    }
    const page = session.getCanonicalPage(100);
    (page.messages[0] as SessionEntry).content = 'caller mutation';
    expect(session.canonicalHash()).toBe(hash);
    expect(session.getCanonicalPage(100, page.nextAfter!).messages[0].id).toBe(facts[100].id);
  });

  it('persists deterministic legacy IDs, repair gaps and excludes repeated injected summaries', async () => {
    fs.mkdirSync(path.join(dir, '.slide', 'sessions'), { recursive: true });
    const file = path.join(dir, '.slide', 'sessions', manager.safeKey('legacy') + '.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ role: 'user', content: 'same' }), '{broken',
      JSON.stringify({ role: 'user', content: 'same' }),
      JSON.stringify({ role: 'system', content: 'Previous conversation summary:\nold' }),
      JSON.stringify({ __meta__: true, sessionKey: 'legacy', metadata: { _last_summary: 'old' } })].join('\n'));
    const loaded = manager.getOrCreate('legacy');
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].id).not.toBe(loaded.messages[1].id);
    const original = structuredClone(loaded.messages);
    for (let i = 0; i < 3; i++) {
      const cold = new SessionManager(dir).getOrCreate('legacy');
      expect(cold.messages).toEqual(original);
      expect(cold.metadata.history_gaps).toEqual(loaded.metadata.history_gaps);
      await manager.save(cold);
    }
  });

  it('refuses capacity overflow and failed writes without trimming durable facts', async () => {
    const bounded = new SessionManager(dir, { maxCanonicalMessages: 2 });
    const session = bounded.getOrCreate('bounded');
    session.addMessage('user', 'old');
    await bounded.save(session);
    session.addMessage('assistant', 'reply'); session.addMessage('user', 'over limit');
    const hash = session.canonicalHash();
    await expect(bounded.save(session)).rejects.toThrow('CANONICAL_CAPACITY_EXCEEDED');
    expect(session.canonicalHash()).toBe(hash);
    expect(new SessionManager(dir).getOrCreate('bounded').messages).toHaveLength(1);
    const brokenDir = path.join(dir, 'file-not-directory'); fs.writeFileSync(brokenDir, 'x');
    await expect(new SessionManager(brokenDir).save(session)).rejects.toThrow();
    expect(session.canonicalHash()).toBe(hash);
  });

  it('explicit retention records complete turn boundaries and refuses unsettled intents', () => {
    const session = manager.getOrCreate('retention');
    session.addMessage('user', 'old');
    session.addMessage('assistant', null, { tool_calls: [{ id: 'intent', type: 'function', function: { name: 'write', arguments: '{}' } }] });
    session.addMessage('user', 'new');
    expect(() => session.retainCanonicalRecentTurns(1, 'policy')).toThrow('UNSETTLED');
    session.messages.splice(2, 0, { role: 'tool', content: 'settled', tool_call_id: 'intent' });
    session.ensureFactIds();
    session.retainCanonicalRecentTurns(1, 'operator policy');
    expect(session.messages).toHaveLength(1);
    expect(session.metadata.retention_boundaries).toMatchObject([{ count: 3, reason: 'operator policy', firstId: expect.any(String), lastId: expect.any(String) }]);
  });

  it("getOrCreate returns same session for same key", () => {
    const s1 = manager.getOrCreate("test-key");
    const s2 = manager.getOrCreate("test-key");
    expect(s1).toBe(s2);
    expect(s1.key).toBe("test-key");
  });

  it("getOrCreate creates new session for different keys", () => {
    const s1 = manager.getOrCreate("key-a");
    const s2 = manager.getOrCreate("key-b");
    expect(s1).not.toBe(s2);
    expect(s1.key).toBe("key-a");
    expect(s2.key).toBe("key-b");
  });

  it("save writes JSONL to disk", async () => {
    const session = manager.getOrCreate("test-key");
    session.addMessage("user", "Hello");
    await manager.save(session);

    const sessionPath = path.join(dir, ".slide", "sessions", manager.safeKey("test-key") + ".jsonl");
    expect(fs.existsSync(sessionPath)).toBe(true);

    const content = fs.readFileSync(sessionPath, "utf-8");
    expect(content).toContain("_type");
    expect(content).toContain("metadata");
    expect(content).toContain("Hello");
  });

  it("_load reads back saved session", async () => {
    const session = manager.getOrCreate("test-key");
    session.addMessage("user", "Hello");
    session.addMessage("assistant", "Hi there");
    await manager.save(session);

    // Clear cache
    manager.invalidate("test-key");
    const loaded = manager._load("test-key");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.messages[0].content).toBe("Hello");
    expect(loaded!.messages[1].content).toBe("Hi there");
  });

  it("flushAll saves all dirty sessions", async () => {
    const s1 = manager.getOrCreate("key-1");
    const s2 = manager.getOrCreate("key-2");
    s1.addMessage("user", "msg1");
    s2.addMessage("user", "msg2");
    const flushed = await manager.flushAll();
    expect(flushed).toBe(2);
  });

  it("invalidate removes from cache", () => {
    const s1 = manager.getOrCreate("test-key");
    manager.invalidate("test-key");
    const s2 = manager.getOrCreate("test-key");
    // Should be a fresh load (but since no file, it creates new)
    expect(s1).not.toBe(s2);
  });

  it("listSessions returns session metadata keyed by session key", async () => {
    const s1 = manager.getOrCreate("key-1");
    s1.addMessage("user", "Hello");
    await manager.save(s1);
    const s2 = manager.getOrCreate("key-2");
    s2.addMessage("user", "World");
    await manager.save(s2);

    const sessions = await manager.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.key)).toEqual(expect.arrayContaining(["key-1", "key-2"]));
    expect(sessions.every((session) => session.messageCount === 1)).toBe(true);
  });

  it("deleteSession removes from disk and cache", async () => {
    const session = manager.getOrCreate("test-key");
    session.addMessage("user", "Hello");
    await manager.save(session);

    await manager.deleteSession("test-key");
    expect(manager.getOrCreate("test-key")).not.toBe(session);

    // After delete, a new getOrCreate should create a fresh (empty) session
    const fresh = manager.getOrCreate("test-key");
    expect(fresh.messages.length).toBe(0);
  });

  it("safeKey produces filesystem-safe strings", () => {
    const key = manager.safeKey("hello:world/test!");
    expect(key).not.toContain(":");
    expect(key).not.toContain("/");
    expect(key).not.toContain("!");
    expect(key.length).toBeGreaterThan(0);
  });
});
