/**
 * CronExecutor + slide_complete_cron 单元测试
 *
 * Tests:
 * 1. CronHook 扩展 NoopHook 并在 afterIteration 中收集 ToolEvent
 * 2. slide_complete_cron 工具注册到 toolCatalog
 * 3. slide_complete_cron 参数 schema 正确（status enum, summary required, details optional）
 * 4. slide_complete_cron handler 接受有效参数返回 success
 * 5. slide_complete_cron handler 拒绝无效 status 值
 * 6. slide_complete_cron handler 拒绝空 summary
 * 7. CronExecutor 构造函数接受 (AgentRunner, ToolRegistry, LLMProvider)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const EXECUTOR_SRC = resolve(__dirname, '../cron/cron-executor.ts');
const TOOL_SRC = resolve(__dirname, '../cron/cron-completion-tool.ts');

import { CronHook } from '../cron/cron-executor.js';
import { completeCronTool } from '../cron/cron-completion-tool.js';
import { toolCatalog } from '../tools/catalog.js';

describe('CronHook', () => {
  it('is exported from cron-executor module', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('export class CronHook');
  });

  it('extends NoopHook from @slide/agent-core', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('extends NoopHook');
  });

  it('imports NoopHook from @slide/agent-core', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toMatch(/import.*NoopHook.*from\s+['"]@slide\/agent-core['"]/);
  });

  it('has public events: ToolEvent[] property', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('public events: ToolEvent[]');
  });

  it('overrides afterIteration to push ctx.toolEvents', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('afterIteration');
    expect(source).toContain('ctx.toolEvents');
  });
});

describe('CronExecutor', () => {
  it('is exported from cron-executor module', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('export class CronExecutor');
  });

  it('constructor accepts (AgentRunner, ToolRegistry, LLMProvider)', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    // Check that constructor has three parameters with these types
    const lines = source.split('\n');
    const ctorLine = lines.find(l => l.includes('constructor('));
    expect(ctorLine).toBeTruthy();
    expect(source).toContain('private runner: AgentRunner');
    expect(source).toContain('private registry: ToolRegistry');
    expect(source).toContain('private provider: LLMProvider');
  });

  it('has execute(jobId, taskDescription, timeoutSeconds) method', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('async execute(');
    expect(source).toContain('jobId: number');
    expect(source).toContain('taskDescription: string');
    expect(source).toContain('timeoutSeconds');
  });

  it('uses llmTimeoutS in runner.run call', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('llmTimeoutS');
  });

  it('generates sessionKey with cron:{jobId}:{timestamp} format', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toMatch(/sessionKey.*=.*`cron:\$\{jobId\}:\$\{Date\.now\(\)\}`/);
  });

  it('has buildSystemPrompt returning TASK + constraints', () => {
    const source = readFileSync(EXECUTOR_SRC, 'utf-8');
    expect(source).toContain('buildSystemPrompt');
    expect(source).toContain('TASK:');
  });
});

describe('slide_complete_cron tool', () => {
  describe('parameter schema', () => {
    it('has status (enum), summary (string required), details (object optional)', () => {
      const props = completeCronTool.parameters.properties;
      expect(completeCronTool.name).toBe('slide_complete_cron');
      expect(props).toHaveProperty('status');
      expect(props.status).toHaveProperty('enum');
      expect(props.status.enum).toEqual(['success', 'failure', 'partial']);
      expect(props).toHaveProperty('summary');
      expect(props.summary.type).toBe('string');
      expect(props).toHaveProperty('details');
      expect(props.details.type).toBe('object');
      expect(completeCronTool.parameters.required).toEqual(['status', 'summary']);
    });

    it('has no unexpected parameters', () => {
      const props = completeCronTool.parameters.properties;
      const keys = Object.keys(props);
      expect(keys).toEqual(expect.arrayContaining(['status', 'summary', 'details']));
      expect(keys.length).toBe(3);
    });
  });

  describe('handler behavior', () => {
    it('accepts valid parameters and returns success', async () => {
      const result = await completeCronTool.handler({
        status: 'success',
        summary: '任务执行完成，分析了 5 条慢查询记录',
        details: { queriesExamined: 5, anomaliesFound: 2 },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ saved: true, status: 'success' });
      expect(result.summary).toBe('定时任务结果已记录');
    });

    it('rejects invalid status value', async () => {
      const result = await completeCronTool.handler({
        status: 'invalid',
        summary: 'some summary',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('状态值无效');
    });

    it('rejects empty summary', async () => {
      const result = await completeCronTool.handler({
        status: 'success',
        summary: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('摘要不能为空');
    });

    it('rejects whitespace-only summary', async () => {
      const result = await completeCronTool.handler({
        status: 'failure',
        summary: '   ',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('摘要不能为空');
    });

    it('accepts partial status', async () => {
      const result = await completeCronTool.handler({
        status: 'partial',
        summary: '任务部分完成，超时前保存了中间结果',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ saved: true, status: 'partial' });
    });

    it('works without optional details parameter', async () => {
      const result = await completeCronTool.handler({
        status: 'failure',
        summary: '数据库连接失败',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ saved: true, status: 'failure' });
    });
  });

  describe('source code checks', () => {
    it('calls toolCatalog.register in the source file', () => {
      const source = readFileSync(TOOL_SRC, 'utf-8');
      expect(source).toContain('toolCatalog.register');
    });

    it('is exported as completeCronTool', () => {
      const source = readFileSync(TOOL_SRC, 'utf-8');
      expect(source).toContain('export const completeCronTool');
    });

    it('has name slide_complete_cron', () => {
      expect(completeCronTool.name).toBe('slide_complete_cron');
    });

    it('has group db_ops', () => {
      expect(completeCronTool.group).toBe('db_ops');
    });

    it('imports from tools/types and tools/catalog', () => {
      const source = readFileSync(TOOL_SRC, 'utf-8');
      expect(source).toMatch(/import.*AnyAgentTool.*from.*tools\/types/);
      expect(source).toMatch(/import.*toolCatalog.*from.*tools\/catalog/);
    });
  });

  describe('toolCatalog registration', () => {
    it('tool is registered in catalog after module import', () => {
      expect(toolCatalog.has('slide_complete_cron')).toBe(true);
    });
  });
});
