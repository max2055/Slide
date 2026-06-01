/**
 * Tests for MemoryStore — ported from nanobot Python.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryStore } from "../memory.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
}

describe("MemoryStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writeMemory() then readMemory() returns same content", async () => {
    const store = new MemoryStore(tempDir);
    await store.writeMemory("Test memory content");
    const result = await store.readMemory();
    expect(result).toBe("Test memory content");
  });

  it("readMemory() returns null when no MEMORY.md exists", async () => {
    const store = new MemoryStore(tempDir);
    const result = await store.readMemory();
    expect(result).toBeNull();
  });

  it("appendHistory() creates history.jsonl file", async () => {
    const store = new MemoryStore(tempDir);
    await store.appendHistory({ message: "Test entry" });

    const historyPath = path.join(tempDir, ".slide", "history.jsonl");
    expect(fs.existsSync(historyPath)).toBe(true);
    const content = fs.readFileSync(historyPath, "utf-8");
    expect(content).toContain("Test entry");
  });

  it("readUnprocessedHistory() returns entries after cursor", async () => {
    const store = new MemoryStore(tempDir);
    await store.appendHistory({ n: 1 });
    await store.appendHistory({ n: 2 });
    await store.appendHistory({ n: 3 });

    const afterFirst = await store.readUnprocessedHistory(1);
    expect(afterFirst.length).toBe(2);

    const afterLast = await store.readUnprocessedHistory(3);
    expect(afterLast.length).toBe(0);
  });

  it("readUnprocessedHistory(0) returns all entries", async () => {
    const store = new MemoryStore(tempDir);
    await store.appendHistory({ msg: "First" });
    await store.appendHistory({ msg: "Second" });
    await store.appendHistory({ msg: "Third" });

    const all = await store.readUnprocessedHistory(0);
    expect(all.length).toBe(3);
  });

  it("compactHistory() keeps recent entries", async () => {
    const store = new MemoryStore(tempDir);
    for (let i = 1; i <= 10; i++) {
      await store.appendHistory({ n: i });
    }
    await store.compactHistory(3);

    const entries = await store.readUnprocessedHistory(0);
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  it("getMemoryContext() includes MEMORY.md content", async () => {
    const store = new MemoryStore(tempDir);
    await store.writeMemory("Important information.");
    const ctx = await store.getMemoryContext();
    expect(ctx).toContain("## Memory");
    expect(ctx).toContain("Important information");
  });

  it("getMemoryContext() returns null when no memory", async () => {
    const store = new MemoryStore(tempDir);
    const ctx = await store.getMemoryContext();
    expect(ctx).toBeNull();
  });

  it("readSoul() returns SOUL.md content", async () => {
    fs.writeFileSync(path.join(tempDir, "SOUL.md"), "Agent Soul Content", "utf-8");
    const store = new MemoryStore(tempDir);
    const result = await store.readSoul();
    expect(result).toBe("Agent Soul Content");
  });

  it("readSoul() returns null when no SOUL.md", async () => {
    const store = new MemoryStore(tempDir);
    const result = await store.readSoul();
    expect(result).toBeNull();
  });

  it("readAgents() returns AGENTS.md content", async () => {
    fs.writeFileSync(path.join(tempDir, "AGENTS.md"), "Agent Info", "utf-8");
    const store = new MemoryStore(tempDir);
    const result = await store.readAgents();
    expect(result).toBe("Agent Info");
  });

  it("readAgents() returns null when no AGENTS.md", async () => {
    const store = new MemoryStore(tempDir);
    const result = await store.readAgents();
    expect(result).toBeNull();
  });
});
