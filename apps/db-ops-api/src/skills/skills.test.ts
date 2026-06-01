/**
 * 技能加载器单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseSkillFrontmatter, normalizeFrontmatter } from './frontmatter.js';
import { skillRegistry } from './loader.js';
import type { SkillEntry } from './types.js';

describe('Skill Frontmatter', () => {
  describe('parseSkillFrontmatter', () => {
    it('应该解析有效的 frontmatter', () => {
      const content = `---
name: test-skill
description: 测试技能
---

这是技能内容`;

      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(true);
      expect(result.frontmatter.name).toBe('test-skill');
      expect(result.frontmatter.description).toBe('测试技能');
      expect(result.body).toBe('这是技能内容');
    });

    it('应该拒绝缺少 name 的 frontmatter', () => {
      const content = `---
description: 测试技能
---

内容`;

      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('name');
    });

    it('应该拒绝缺少 description 的 frontmatter', () => {
      const content = `---
name: test-skill
---

内容`;

      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('description');
    });

    it('应该处理没有 frontmatter 的内容', () => {
      const content = '这是内容';
      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(false);
    });

    it('应该解析数组字段', () => {
      const content = `---
name: test-skill
description: 测试技能
os:
  - linux
  - macos
---

内容`;

      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(true);
      expect(result.frontmatter.os).toEqual(['linux', 'macos']);
    });

    it('应该解析行内数组', () => {
      const content = `---
name: test-skill
description: 测试技能
os: [linux, macos]
---

内容`;

      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(true);
      expect(result.frontmatter.os).toEqual(['linux', 'macos']);
    });

    it('应该解析布尔值', () => {
      const content = `---
name: test-skill
description: 测试技能
user-invocable: true
always: false
---

内容`;

      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(true);
      expect(result.frontmatter['user-invocable']).toBe(true);
      expect(result.frontmatter.always).toBe(false);
    });

    it('应该解析数字', () => {
      const content = `---
name: test-skill
description: 测试技能
version: 1.0
---

内容`;

      const result = parseSkillFrontmatter(content);
      expect(result.valid).toBe(true);
      expect(result.frontmatter.version).toBe(1);
    });
  });

  describe('normalizeFrontmatter', () => {
    it('应该规范化 kebab-case 和 snake_case 混用', () => {
      const frontmatter = {
        name: 'test',
        'user-invocable': true,
      };

      const normalized = normalizeFrontmatter(frontmatter);
      expect(normalized.user_invocable).toBe(true);
      expect(normalized['user-invocable']).toBe(true);
    });

    it('应该规范化 command-工具字段', () => {
      const frontmatter = {
        name: 'test',
        'command-tool': 'my_tool',
      };

      const normalized = normalizeFrontmatter(frontmatter);
      expect(normalized.command_tool).toBe('my_tool');
      expect(normalized['command-tool']).toBe('my_tool');
    });

    it('应该保留原始值', () => {
      const frontmatter = {
        name: 'test',
        description: '描述',
      };

      const normalized = normalizeFrontmatter(frontmatter);
      expect(normalized.name).toBe('test');
      expect(normalized.description).toBe('描述');
    });
  });
});

describe('SkillRegistry', () => {
  beforeEach(() => {
    skillRegistry.clear();
  });

  it('应该注册技能', () => {
    const entry: SkillEntry = {
      skill: {
        name: 'test-skill',
        description: '测试技能',
        filePath: '/test/SKILL.md',
      },
      frontmatter: {
        name: 'test-skill',
        description: '测试技能',
      },
      invocation: {
        userInvocable: true,
        disableModelInvocation: false,
      },
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    };

    skillRegistry.register(entry);
    expect(skillRegistry.has('test-skill')).toBe(true);
  });

  it('应该返回已注册的技能', () => {
    const entry: SkillEntry = {
      skill: {
        name: 'test-skill',
        description: '测试技能',
        filePath: '/test/SKILL.md',
      },
      frontmatter: {
        name: 'test-skill',
        description: '测试技能',
      },
      invocation: {
        userInvocable: true,
        disableModelInvocation: false,
      },
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    };

    skillRegistry.register(entry);
    const retrieved = skillRegistry.get('test-skill');
    expect(retrieved).toBeDefined();
    expect(retrieved?.skill.name).toBe('test-skill');
  });

  it('应该批量注册技能', () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: 'skill1', description: '技能 1', filePath: '/test/SKILL.md' },
        frontmatter: { name: 'skill1', description: '技能 1' },
        invocation: { userInvocable: true, disableModelInvocation: false },
        exposure: { includeInRuntimeRegistry: true, includeInAvailableSkillsPrompt: true, userInvocable: true },
      },
      {
        skill: { name: 'skill2', description: '技能 2', filePath: '/test/SKILL.md' },
        frontmatter: { name: 'skill2', description: '技能 2' },
        invocation: { userInvocable: true, disableModelInvocation: false },
        exposure: { includeInRuntimeRegistry: true, includeInAvailableSkillsPrompt: true, userInvocable: true },
      },
    ];

    skillRegistry.registerAll(entries);
    expect(skillRegistry.getAll().length).toBe(2);
  });

  it('应该处理大小写不敏感查询', () => {
    const entry: SkillEntry = {
      skill: {
        name: 'Test-Skill',
        description: '测试技能',
        filePath: '/test/SKILL.md',
      },
      frontmatter: {
        name: 'Test-Skill',
        description: '测试技能',
      },
      invocation: {
        userInvocable: true,
        disableModelInvocation: false,
      },
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    };

    skillRegistry.register(entry);
    expect(skillRegistry.has('test-skill')).toBe(true);
    expect(skillRegistry.has('TEST-SKILL')).toBe(true);
  });
});
