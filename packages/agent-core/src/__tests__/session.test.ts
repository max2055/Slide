/**
 * Tests for Session and SessionManager.
 *
 * Ported from nanobot session/manager.py patterns.
 * Run: npx vitest run packages/agent-core/src/__tests__/session.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Session, SessionManager } from "../session.js";
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
    expect(session.messages.length).toBeLessThanOrEqual(4);
  });

  it("enforceFileCap trims messages", () => {
    for (let i = 0; i < 15; i++) {
      session.addMessage(i % 2 === 0 ? "user" : "assistant", `Message ${i}`);
    }
    expect(session.messages.length).toBe(15);
    session.enforceFileCap(5);
    expect(session.messages.length).toBeLessThanOrEqual(5);
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

  it("listSessions returns session keys", async () => {
    const s1 = manager.getOrCreate("key-1");
    s1.addMessage("user", "Hello");
    await manager.save(s1);
    const s2 = manager.getOrCreate("key-2");
    s2.addMessage("user", "World");
    await manager.save(s2);

    const keys = await manager.listSessions();
    expect(keys.length).toBe(2);
    expect(keys).toContain("key-1");
    expect(keys).toContain("key-2");
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
