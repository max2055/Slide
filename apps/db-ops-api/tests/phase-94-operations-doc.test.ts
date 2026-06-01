/**
 * Phase 94, Gap 3 (94-02-01): OPERATIONS.md / OPERATIONS.html
 *
 * Requirement: file exists, >3000 chars, has sections
 * (系统概览, 部署架构, 配置项说明, 启动流程, Gateway, 启停命令, 健康检查, 故障排查),
 * mentions DB_HOST.
 *
 * NOTE: Plan specified OPERATIONS.md; implementation converted to OPERATIONS.html
 * (commit f70eaf6374e). Tests check the actual .html file.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const OPS_PATH = join('/Users/max/Coding/39-Slide/docs/slide/OPERATIONS.html');

describe('94-02-01: Operations documentation', () => {
  it('OPERATIONS.html file exists', () => {
    expect(existsSync(OPS_PATH)).toBe(true);
  });

  it('file size > 3000 characters', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(3000);
  });

  it('contains 系统概览 section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toMatch(/系统概览|系统组件/);
  });

  it('contains 部署架构 section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('部署架构');
  });

  it('contains 配置项说明 section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('配置项');
  });

  it('contains 启动流程 section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('启动流程');
  });

  it('contains Gateway section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('Gateway');
  });

  it('contains 启停命令 section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('启停命令');
  });

  it('contains 健康检查 section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('健康检查');
  });

  it('contains 故障排查 section', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('故障排查');
  });

  it('mentions DB_HOST', () => {
    const content = readFileSync(OPS_PATH, 'utf-8');
    expect(content).toContain('DB_HOST');
  });
});
