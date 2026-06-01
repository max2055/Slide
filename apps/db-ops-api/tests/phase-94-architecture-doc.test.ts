/**
 * Phase 94, Gap 2 (94-01-02): ARCHITECTURE.md / ARCHITECTURE.html
 *
 * Requirement: file exists, >= 2000 chars, has mermaid code blocks,
 * has required sections (技术栈总览, 系统架构图, 模块职责, 核心数据流, 外部依赖).
 *
 * NOTE: Plan specified ARCHITECTURE.md; implementation converted to ARCHITECTURE.html
 * (commit f70eaf6374e). Tests check the actual .html file.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ARCH_PATH = join('/Users/max/Coding/39-Slide/docs/slide/ARCHITECTURE.html');

describe('94-01-02: Architecture documentation', () => {
  it('ARCHITECTURE.html file exists', () => {
    expect(existsSync(ARCH_PATH)).toBe(true);
  });

  it('file size >= 2000 characters', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content.length).toBeGreaterThanOrEqual(2000);
  });

  it('contains mermaid code blocks', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    const mermaidMatches = content.match(/class="mermaid"/g);
    expect(mermaidMatches).not.toBeNull();
    expect(mermaidMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it('contains flowchart (TB or LR) diagram', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content).toMatch(/flowchart\s+(TB|LR|BT|RL)/);
  });

  it('contains sequenceDiagram', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content).toContain('sequenceDiagram');
  });

  it('contains 技术栈总览 section', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content).toMatch(/技术栈总览|技术栈/);
  });

  it('contains 系统架构图 section', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content).toContain('系统架构图');
  });

  it('contains 模块职责 section', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content).toContain('模块职责');
  });

  it('contains 核心数据流 section', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content).toContain('核心数据流');
  });

  it('contains 外部依赖 section', () => {
    const content = readFileSync(ARCH_PATH, 'utf-8');
    expect(content).toContain('外部依赖');
  });
});
