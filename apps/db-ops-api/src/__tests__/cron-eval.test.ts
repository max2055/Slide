/**
 * Cron eval tests — structure and safety checks for Phase 113 AI Agent Cron
 *
 * These tests verify the structural integrity of the cron refactoring:
 * - No getHandler/handlerNames references remain
 * - cron-job-handlers.ts has been deleted
 * - CronExecutor and task_description are properly wired
 * - cron-completion-tool source and schema are correct
 * - Database service methods match expectations
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

const CRON_DIR = resolve(__dirname, '../cron');
const SERVER_PATH = resolve(__dirname, '../../server.ts');
const TYPES_PATH = resolve(CRON_DIR, 'types.ts');
const CRON_MANAGER_PATH = resolve(CRON_DIR, 'cron-manager.ts');
const HANDLERS_PATH = resolve(CRON_DIR, 'cron-job-handlers.ts');
const CRON_JOB_SERVICE_PATH = resolve(CRON_DIR, 'cron-job-service.ts');

const COMPLETION_TOOL_PATH = resolve(CRON_DIR, 'cron-completion-tool.ts');

describe('cron-eval: structure and safety checks', () => {
  // ── completion-tool source checks ──

  it('slide_complete_cron has correct parameter schema', () => {
    const source = readFileSync(COMPLETION_TOOL_PATH, 'utf-8');
    // Status must be enum success/failure/partial
    expect(source).toContain("enum: ['success', 'failure', 'partial']");
    // Summary must be required
    expect(source).toContain('required:');
    // Has details field
    expect(source).toContain('details');
  });

  it('cron-completion-tool source calls toolCatalog.register', () => {
    const source = readFileSync(COMPLETION_TOOL_PATH, 'utf-8');
    expect(source).toContain('toolCatalog.register');
  });

  // ── cron-job-handlers.ts deletion check ──

  it('cron-job-handlers.ts has been deleted', () => {
    expect(existsSync(HANDLERS_PATH)).toBe(false);
  });

  // ── cron-manager.ts import checks ──

  it('cron-manager.ts no longer references getHandler or handlerNames', () => {
    const source = readFileSync(CRON_MANAGER_PATH, 'utf-8');
    expect(source).not.toContain('getHandler');
    expect(source).not.toContain('handlerNames');
  });

  it('cron-manager.ts references CronExecutor and task_description', () => {
    const source = readFileSync(CRON_MANAGER_PATH, 'utf-8');
    expect(source).toContain('CronExecutor');
    expect(source).toContain('task_description');
  });

  // ── server.ts import checks ──

  it('server.ts no longer imports from cron-job-handlers', () => {
    const source = readFileSync(SERVER_PATH, 'utf-8');
    expect(source).not.toContain('cron-job-handlers');
  });

  // ── types.ts field checks ──

  it('types.ts has task_description field instead of handler', () => {
    const source = readFileSync(TYPES_PATH, 'utf-8');
    expect(source).toContain('task_description: string');
    expect(source).not.toContain('export type HandlerName');
  });

  it('types.ts CronJobLog has trace fields', () => {
    const source = readFileSync(TYPES_PATH, 'utf-8');
    expect(source).toContain('tools_used');
    expect(source).toContain('tool_events');
  });

  // ── cron-job-service.ts method checks ──

  it('cron-job-service.ts has createJob and deleteJob methods', () => {
    const source = readFileSync(CRON_JOB_SERVICE_PATH, 'utf-8');
    expect(source).toContain('createJob');
    expect(source).toContain('deleteJob');
  });

  it('cron-job-service.ts queries task_description instead of handler', () => {
    const source = readFileSync(CRON_JOB_SERVICE_PATH, 'utf-8');
    // All SELECT queries should reference task_description, not handler
    expect(source).toContain('task_description');
    // Handler field should not appear in SELECT queries
    const handlerInSelect = source.match(/SELECT[\s\S]*?handler[\s\S]*?FROM/g);
    expect(handlerInSelect).toBeNull();
  });
});
