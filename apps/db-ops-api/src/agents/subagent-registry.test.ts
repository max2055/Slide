/**
 * 子 Agent 注册表单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SubagentRegistry,
  subagentRegistry,
  registerSubagentRun,
  countActiveRunsForSession,
  getSubagentDepthFromSessionStore,
  mergeSessionEntry,
} from './subagent-registry.js';
import type { SessionStore } from './session-store.js';

describe('SubagentRegistry', () => {
  let registry: SubagentRegistry;

  beforeEach(() => {
    registry = new SubagentRegistry();
  });

  describe('register', () => {
    it('应该注册子 Agent 运行', () => {
      const run = registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Test task',
        label: 'test-label',
      });

      expect(run.runId).toMatch(/^run_[a-z0-9]+_[a-z0-9]+$/);
      expect(run.sessionKey).toBe('agent:slide:default:child1');
      expect(run.task).toBe('Test task');
      expect(run.label).toBe('test-label');
      expect(run.status).toBe('running');
    });

    it('应该创建会话记录', () => {
      registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Test task',
        parentSessionKey: 'agent:slide:default:main',
      });

      const session = registry.getSession('agent:slide:default:child1');
      expect(session).toBeDefined();
      expect(session?.parentSessionKey).toBe('agent:slide:default:main');
      expect(session?.runs).toHaveLength(1);
    });

    it('应该添加运行到现有会话', () => {
      registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Task 1',
      });

      registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Task 2',
      });

      const session = registry.getSession('agent:slide:default:child1');
      expect(session?.runs).toHaveLength(2);
    });
  });

  describe('updateRunStatus', () => {
    it('应该更新运行状态', () => {
      const run = registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Test task',
      });

      const updated = registry.updateRunStatus(run.runId, 'completed', { result: 'success' });
      expect(updated?.status).toBe('completed');
      expect(updated?.result).toEqual({ result: 'success' });
    });

    it('应该更新错误信息', () => {
      const run = registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Test task',
      });

      const updated = registry.updateRunStatus(run.runId, 'failed', undefined, 'Test error');
      expect(updated?.status).toBe('failed');
      expect(updated?.error).toBe('Test error');
    });

    it('应该返回 undefined 对于不存在的运行', () => {
      const updated = registry.updateRunStatus('non-existent', 'completed');
      expect(updated).toBeUndefined();
    });

    it('应该更新会话的 updatedAt', () => {
      const run = registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Test task',
      });

      const sessionBefore = registry.getSession('agent:slide:default:child1');
      registry.updateRunStatus(run.runId, 'completed');
      const sessionAfter = registry.getSession('agent:slide:default:child1');

      expect(sessionAfter?.updatedAt).toBeGreaterThanOrEqual(sessionBefore?.updatedAt || 0);
    });
  });

  describe('getRun', () => {
    it('应该获取运行记录', () => {
      const run = registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Test task',
      });

      const retrieved = registry.getRun(run.runId);
      expect(retrieved).toEqual(run);
    });

    it('应该返回 undefined 对于不存在的运行', () => {
      const retrieved = registry.getRun('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getSession', () => {
    it('应该获取会话记录', () => {
      registry.register({
        sessionKey: 'agent:slide:default:child1',
        task: 'Test task',
      });

      const session = registry.getSession('agent:slide:default:child1');
      expect(session?.sessionKey).toBe('agent:slide:default:child1');
    });

    it('应该返回 undefined 对于不存在的会话', () => {
      const session = registry.getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('countActiveRunsForSession', () => {
    it('应该统计活跃运行数', () => {
      registry.register({ sessionKey: 'session1', task: 'Task 1' });
      registry.register({ sessionKey: 'session1', task: 'Task 2' });
      registry.register({ sessionKey: 'session1', task: 'Task 3' });

      // 初始都是 running 状态
      expect(registry.countActiveRunsForSession('session1')).toBe(3);

      // 完成一个后
      const runs = registry.listRuns({ sessionKey: 'session1' });
      registry.updateRunStatus(runs[0].runId, 'completed');
      expect(registry.countActiveRunsForSession('session1')).toBe(2);
    });

    it('应该返回 0 对于不存在的会话', () => {
      expect(registry.countActiveRunsForSession('non-existent')).toBe(0);
    });
  });

  describe('listRuns', () => {
    beforeEach(() => {
      registry.register({ sessionKey: 'session1', task: 'Task 1', label: 'label1' });
      registry.register({ sessionKey: 'session1', task: 'Task 2', label: 'label2' });
      registry.register({ sessionKey: 'session2', task: 'Task 3' });
    });

    it('应该列出所有运行', () => {
      const runs = registry.listRuns();
      expect(runs).toHaveLength(3);
    });

    it('应该按状态过滤', () => {
      const runs = registry.listRuns({ status: 'running' });
      expect(runs).toHaveLength(3);

      registry.updateRunStatus(runs[0].runId, 'completed');
      const completedRuns = registry.listRuns({ status: 'completed' });
      expect(completedRuns).toHaveLength(1);
    });

    it('应该按会话 Key 过滤', () => {
      const runs = registry.listRuns({ sessionKey: 'session1' });
      expect(runs).toHaveLength(2);
    });
  });

  describe('listSessions', () => {
    beforeEach(() => {
      registry.register({
        sessionKey: 'child1',
        task: 'Task 1',
        parentSessionKey: 'main',
      });
      registry.register({
        sessionKey: 'child2',
        task: 'Task 2',
        parentSessionKey: 'main',
      });
      registry.register({
        sessionKey: 'grandchild',
        task: 'Task 3',
        parentSessionKey: 'child1',
      });
    });

    it('应该列出所有会话', () => {
      const sessions = registry.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it('应该按父会话 Key 过滤', () => {
      const sessions = registry.listSessions({ parentSessionKey: 'main' });
      expect(sessions).toHaveLength(2);

      const grandchildSessions = registry.listSessions({ parentSessionKey: 'child1' });
      expect(grandchildSessions).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('应该清除所有记录', () => {
      registry.register({ sessionKey: 'session1', task: 'Task 1' });
      registry.register({ sessionKey: 'session2', task: 'Task 2' });

      registry.clear();

      expect(registry.listRuns()).toHaveLength(0);
      expect(registry.listSessions()).toHaveLength(0);
    });
  });
});

describe('subagentRegistry singleton', () => {
  it('应该导出单例', () => {
    expect(subagentRegistry).toBeInstanceOf(SubagentRegistry);
  });
});

describe('registerSubagentRun', () => {
  beforeEach(() => {
    subagentRegistry.clear();
  });

  it('应该使用全局注册表注册运行', () => {
    const run = registerSubagentRun({
      sessionKey: 'agent:slide:default:child1',
      task: 'Test task',
    });

    expect(run.sessionKey).toBe('agent:slide:default:child1');

    // 验证全局注册表中有记录
    const retrieved = subagentRegistry.getRun(run.runId);
    expect(retrieved).toBeDefined();
  });
});

describe('countActiveRunsForSession', () => {
  beforeEach(() => {
    subagentRegistry.clear();
  });

  it('应该使用全局注册表统计', () => {
    registerSubagentRun({ sessionKey: 'session1', task: 'Task 1' });
    registerSubagentRun({ sessionKey: 'session1', task: 'Task 2' });

    expect(countActiveRunsForSession('session1')).toBe(2);
  });
});

describe('getSubagentDepthFromSessionStore', () => {
  it('应该从 spawnDepth 读取深度', () => {
    const store: SessionStore = {
      'agent:test:session1': {
        sessionId: 'session1',
        spawnDepth: 2,
      },
    };

    const depth = getSubagentDepthFromSessionStore('agent:test:session1', { store });
    expect(depth).toBe(2);
  });

  it('应该从 spawnedBy 推导深度', () => {
    const store: SessionStore = {
      'agent:test:parent': {
        sessionId: 'parent',
        spawnDepth: 1,
      },
      'agent:test:child': {
        sessionId: 'child',
        spawnedBy: 'agent:test:parent',
      },
    };

    const depth = getSubagentDepthFromSessionStore('agent:test:child', { store });
    expect(depth).toBe(2);
  });

  it('应该返回 0 对于 null sessionKey', () => {
    const depth = getSubagentDepthFromSessionStore(null);
    expect(depth).toBe(0);
  });

  it('应该返回 0 对于没有存储的情况', () => {
    const depth = getSubagentDepthFromSessionStore('agent:test:session1');
    expect(depth).toBe(0);
  });

  it('应该返回 0 对于不存在的条目', () => {
    const store: SessionStore = {};
    const depth = getSubagentDepthFromSessionStore('agent:test:session1', { store });
    expect(depth).toBe(0);
  });
});

describe('mergeSessionEntry', () => {
  it('应该合并现有条目', () => {
    const existing = {
      sessionId: 'session1',
      spawnDepth: 1,
      createdAt: 1000,
    };

    const merged = mergeSessionEntry(existing, {
      spawnDepth: 2,
      model: 'sonnet-4.6',
    });

    expect(merged.sessionId).toBe('session1');
    expect(merged.spawnDepth).toBe(2);
    expect(merged.model).toBe('sonnet-4.6');
    expect(merged.createdAt).toBe(1000);
    expect(merged.updatedAt).toBeDefined();
  });

  it('应该处理 undefined 现有条目', () => {
    const merged = mergeSessionEntry(undefined, {
      sessionId: 'session1',
      spawnDepth: 1,
    });

    expect(merged.sessionId).toBe('session1');
    expect(merged.spawnDepth).toBe(1);
  });
});
