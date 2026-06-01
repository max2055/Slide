/**
 * Tests for ContextBuilder — ported from nanobot Python.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ContextBuilder } from "../context.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "context-test-"));
}

function writeFile(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("ContextBuilder", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("buildSystemPrompt() includes content from all bootstrap files", async () => {
    writeFile(tempDir, "SOUL.md", "You are a database assistant.");
    writeFile(tempDir, "AGENTS.md", "Agent configuration.");
    writeFile(tempDir, "HEARTBEAT.md", "Heartbeat instructions.");

    const builder = new ContextBuilder(tempDir);
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("You are a database assistant");
    expect(prompt).toContain("Agent configuration.");
    expect(prompt).toContain("Heartbeat instructions.");
  });

  it("buildSystemPrompt() includes identity from SOUL.md", async () => {
    writeFile(tempDir, "SOUL.md", "You are a specialized SQL expert.");

    const builder = new ContextBuilder(tempDir);
    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain("specialized SQL expert");
  });

  it("buildSystemPrompt() falls back to generic identity when SOUL.md missing", async () => {
    const builder = new ContextBuilder(tempDir);
    const prompt = await builder.buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("buildSystemPrompt() includes skills when skillNames provided", async () => {
    const skillsDir = path.join(tempDir, ".agents", "skills", "test-skill");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: A test skill\n---\n\nSkill body content.",
      "utf-8",
    );
    writeFile(tempDir, "SOUL.md", "You are an assistant.");

    const builder = new ContextBuilder(tempDir);
    const prompt = await builder.buildSystemPrompt(["test-skill"]);

    expect(prompt).toContain("Skill: test-skill");
    expect(prompt).toContain("Skill body content");
  });

  it("buildMessages() returns an array starting with system message and ending with user message", async () => {
    writeFile(tempDir, "SOUL.md", "You are an assistant.");

    const builder = new ContextBuilder(tempDir);
    const messages = await builder.buildMessages([], "Hello, what can you do?");

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].role).toBe("system");
    expect(messages[messages.length - 1].role).toBe("user");
  });

  it("user message contains runtime context appended", async () => {
    writeFile(tempDir, "SOUL.md", "You are an assistant.");

    const builder = new ContextBuilder(tempDir);
    const messages = await builder.buildMessages([], "Hello");

    const lastMsg = messages[messages.length - 1];
    expect(typeof lastMsg.content).toBe("string");
    const content = lastMsg.content as string;
    expect(content).toContain("Hello");
    expect(content).toContain("Current Time:");
  });

  it("includes history messages in the messages array", async () => {
    writeFile(tempDir, "SOUL.md", "You are an assistant.");

    const history = [
      { role: "user" as const, content: "Previous question" },
      { role: "assistant" as const, content: "Previous answer" },
    ];

    const builder = new ContextBuilder(tempDir);
    const messages = await builder.buildMessages(history, "New question");

    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(messages[1].content).toBe("Previous question");
    expect(messages[2].content).toBe("Previous answer");
  });

  it("handles missing bootstrap files gracefully (no throw)", async () => {
    const builder = new ContextBuilder(tempDir);
    const prompt = await builder.buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("buildMessages() handles empty history gracefully", async () => {
    writeFile(tempDir, "SOUL.md", "You are an assistant.");

    const builder = new ContextBuilder(tempDir);
    const messages = await builder.buildMessages([], "Hello");

    expect(messages.length).toBe(2);
  });

  it("getIdentity() returns description from SOUL.md", async () => {
    writeFile(tempDir, "SOUL.md", "You are a monitoring specialist.");

    const builder = new ContextBuilder(tempDir);
    const prompt = await builder.buildSystemPrompt();
    expect(prompt).toContain("monitoring specialist");
  });
});
