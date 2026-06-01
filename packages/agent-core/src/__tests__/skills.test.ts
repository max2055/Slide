/**
 * Tests for SkillsLoader — ported from nanobot Python.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SkillsLoader } from "../skills.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
}

function writeSkill(dir: string, name: string, frontmatter: Record<string, unknown>, body: string): string {
  // Skills are stored under .agents/skills/{name}/SKILL.md per D-14 convention
  const skillDir = path.join(dir, ".agents", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  const frontmatterYaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
      if (typeof v === "boolean") return `${k}: ${v}`;
      if (typeof v === "object" && v !== null) return `${k}:\n${Object.entries(v as Record<string, unknown>).map(([sk, sv]) => `  ${sk}: ${JSON.stringify(sv)}`).join("\n")}`;
      return `${k}: ${v}`;
    })
    .join("\n");
  const content = `---\n${frontmatterYaml}\n---\n\n${body}`;
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8");
  return skillDir;
}

describe("SkillsLoader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("listSkills() discovers skills in the workspace skills directory", () => {
    writeSkill(tempDir, "test-skill", {
      name: "test-skill",
      description: "A test skill",
    }, "This is the test skill body.");
    const loader = new SkillsLoader(tempDir);
    const skills = loader.listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0].name).toBe("test-skill");
  });

  it("loadSkill() returns content without YAML frontmatter", () => {
    writeSkill(tempDir, "test-skill", {
      name: "test-skill",
      description: "A test skill",
    }, "This is the test skill body.");
    const loader = new SkillsLoader(tempDir);
    const content = loader.loadSkill("test-skill");
    expect(content).toBeTruthy();
    expect(content).not.toContain("---");
    expect(content!).toContain("This is the test skill body");
  });

  it("buildSkillsSummary() includes skill name and description", () => {
    writeSkill(tempDir, "test-skill", {
      name: "test-skill",
      description: "A test skill description",
    }, "Body content.");
    const loader = new SkillsLoader(tempDir);
    const summary = loader.buildSkillsSummary();
    expect(summary).toContain("test-skill");
    expect(summary).toContain("A test skill description");
  });

  it("getAlwaysSkills() returns skills marked with always: true", () => {
    writeSkill(tempDir, "always-skill", {
      name: "always-skill",
      description: "Always loaded skill",
      always: true,
    }, "Always skill body.");
    writeSkill(tempDir, "normal-skill", {
      name: "normal-skill",
      description: "Normal skill",
    }, "Normal skill body.");
    const loader = new SkillsLoader(tempDir);
    const alwaysSkills = loader.getAlwaysSkills();
    expect(alwaysSkills).toContain("always-skill");
    expect(alwaysSkills).not.toContain("normal-skill");
  });

  it("handles empty skills directory gracefully", () => {
    const loader = new SkillsLoader(tempDir);
    const skills = loader.listSkills();
    expect(skills).toEqual([]);
  });

  it("loadSkillsForContext() returns joined skill content", () => {
    writeSkill(tempDir, "skill-a", {
      name: "skill-a",
      description: "Skill A",
    }, "Content A");
    writeSkill(tempDir, "skill-b", {
      name: "skill-b",
      description: "Skill B",
    }, "Content B");
    const loader = new SkillsLoader(tempDir);
    const ctx = loader.loadSkillsForContext(["skill-a", "skill-b"]);
    expect(ctx).toContain("Skill: skill-a");
    expect(ctx).toContain("Content A");
    expect(ctx).toContain("Skill: skill-b");
    expect(ctx).toContain("Content B");
  });

  it("getSkillMetadata() returns frontmatter for a specific skill", () => {
    writeSkill(tempDir, "meta-skill", {
      name: "meta-skill",
      description: "Metadata test",
      always: true,
    }, "Body");
    const loader = new SkillsLoader(tempDir);
    const meta = loader.getSkillMetadata("meta-skill");
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe("meta-skill");
    expect(meta!.description).toBe("Metadata test");
    expect(meta!.always).toBe(true);
  });

  it("listSkills() with filterUnavailable filters skills with missing bin requirements", () => {
    writeSkill(tempDir, "needs-bogus-bin", {
      name: "needs-bogus-bin",
      description: "Needs a tool that doesn't exist",
      requires: { bins: ["__this_tool_does_not_exist__"] },
    }, "Body");
    const loader = new SkillsLoader(tempDir);
    // Without filter
    const all = loader.listSkills(false);
    expect(all.length).toBe(1);
    // With filter
    const filtered = loader.listSkills(true);
    expect(filtered.length).toBe(0);
  });
});
