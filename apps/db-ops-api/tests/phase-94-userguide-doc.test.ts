/**
 * Phase 94, Gap 4 (94-02-02): USER-GUIDE.md / USER-GUIDE.html
 *
 * Requirement: file exists, >5000 chars, covers 10+ modules,
 * has FAQ section, has screenshot references.
 *
 * Required modules (D-11): 仪表盘, 实例管理, SQL 控制台, 告警管理,
 * AI 分析, Chat 助手, 报表, 审批, RBAC/权限, AI 设置, Schema, FAQ
 *
 * NOTE: Plan specified USER-GUIDE.md; implementation converted to USER-GUIDE.html
 * (commit f70eaf6374e). Tests check the actual .html file.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const GUIDE_PATH = join('/Users/max/Coding/39-Slide/docs/slide/USER-GUIDE.html');
const SCREENSHOTS_DIR = join('/Users/max/Coding/39-Slide/docs/slide/assets/screenshots');

const REQUIRED_MODULES = [
  '仪表盘',
  '实例管理',
  'SQL 控制台',
  '告警',
  'AI 分析',
  'Chat',
  '报表',
  '审批',
  'RBAC',
  'AI 设置',
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

  it('has screenshot placeholder references', () => {
    const content = readFileSync(GUIDE_PATH, 'utf-8');
    expect(content).toContain('截图待补充');
  });

  it('has step-by-step instructions (numbered lists)', () => {
    const content = readFileSync(GUIDE_PATH, 'utf-8');
    // Check for numbered list patterns in HTML (<ol> or <li>)
    const liMatches = content.match(/<li>/g);
    expect(liMatches).not.toBeNull();
    expect(liMatches!.length).toBeGreaterThanOrEqual(10);
  });
});
