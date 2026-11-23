/**
 * Phase 94, Gap 4 (94-02-02): USER-GUIDE.md / USER-GUIDE.html
 *
 * Requirement: file exists, >5000 chars, covers 10+ modules,
 * has FAQ and a published workflow illustration.
 *
 * NOTE: Plan specified USER-GUIDE.md; implementation converted to USER-GUIDE.html
 * (commit f70eaf6374e). Tests check the actual .html file.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GUIDE_PATH = join(ROOT, 'docs/slide/USER-GUIDE.html');

const REQUIRED_MODULES = [
  '资源概览',
  '数据库',
  'SQL 工作台',
  '事件中心',
  'AI 工作台',
  '对话',
  '报表中心',
  '审批中心',
  '用户与权限',
  '模型配置',
];

describe('94-02-02: User guide documentation', () => {
  it('USER-GUIDE.html file exists', () => {
    expect(existsSync(GUIDE_PATH)).toBe(true);
  });

  it('file size > 5000 characters', () => {
    const content = readFileSync(GUIDE_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(5000);
  });

  describe('covers all required modules (10+)', () => {
    const content = readFileSync(GUIDE_PATH, 'utf-8');

    for (const module of REQUIRED_MODULES) {
      it(`contains "${module}" module`, () => {
        expect(content).toContain(module);
      });
    }
  });

  it('has FAQ section', () => {
    const content = readFileSync(GUIDE_PATH, 'utf-8');
    const hasFaq = content.includes('FAQ') || content.includes('常见问题');
    expect(hasFaq).toBe(true);
  });

  it('includes the published workflow illustration and current observation path', () => {
    const content = readFileSync(GUIDE_PATH, 'utf-8');
    expect(content).toContain('src="/docs/slide-console-workflow.svg"');
    expect(content).toContain('平台状态 → 平台观测');
    expect(content).not.toMatch(/截图待补充|仪表盘|SQL 控制台/);
    const workflow = readFileSync(join(ROOT, 'frontend/public/docs/slide-console-workflow.svg'), 'utf-8');
    expect(workflow).toContain('资源概览');
    expect(workflow).not.toContain('仪表盘');
  });

  it('has step-by-step instructions (numbered lists)', () => {
    const content = readFileSync(GUIDE_PATH, 'utf-8');
    // Check for numbered list patterns in HTML (<ol> or <li>)
    const liMatches = content.match(/<li>/g);
    expect(liMatches).not.toBeNull();
    expect(liMatches!.length).toBeGreaterThanOrEqual(10);
  });
});
