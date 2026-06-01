/**
 * 子 Agent 能力管理单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  SUBAGENT_SESSION_ROLES,
  SUBAGENT_CONTROL_SCOPES,
  resolveSubagentRoleForDepth,
  resolveSubagentControlScopeForRole,
  resolveSubagentCapabilities,
  resolveStoredSubagentCapabilities,
  normalizeSubagentSessionKey,
  generateSubagentSessionKey,
  parseAgentHierarchy,
  isSubagentSessionKey,
} from './subagent-capabilities.js';

describe('Subagent Constants', () => {
  it('应该定义正确的角色类型', () => {
    expect(SUBAGENT_SESSION_ROLES).toEqual(['main', 'orchestrator', 'leaf']);
  });

  it('应该定义正确的控制范围', () => {
    expect(SUBAGENT_CONTROL_SCOPES).toEqual(['children', 'none']);
  });
});

describe('resolveSubagentRoleForDepth', () => {
  it('应该返回 main 角色当深度为 0', () => {
    expect(resolveSubagentRoleForDepth({ depth: 0 })).toBe('main');
  });

  it('应该返回 main 角色当深度为负数', () => {
    expect(resolveSubagentRoleForDepth({ depth: -5 })).toBe('main');
  });

  it('应该返回 orchestrator 角色当深度在中间层', () => {
    expect(resolveSubagentRoleForDepth({ depth: 1, maxSpawnDepth: 3 })).toBe('orchestrator');
    expect(resolveSubagentRoleForDepth({ depth: 2, maxSpawnDepth: 3 })).toBe('orchestrator');
  });

  it('应该返回 leaf 角色当深度达到最大值', () => {
    expect(resolveSubagentRoleForDepth({ depth: 3, maxSpawnDepth: 3 })).toBe('leaf');
    expect(resolveSubagentRoleForDepth({ depth: 5, maxSpawnDepth: 3 })).toBe('leaf');
  });

  it('应该使用默认最大深度', () => {
    expect(resolveSubagentRoleForDepth({ depth: 1 })).toBe('orchestrator');
    expect(resolveSubagentRoleForDepth({ depth: 2 })).toBe('orchestrator');
    expect(resolveSubagentRoleForDepth({ depth: 3 })).toBe('leaf');
  });
});

describe('resolveSubagentControlScopeForRole', () => {
  it('应该返回 children 给 main 角色', () => {
    expect(resolveSubagentControlScopeForRole('main')).toBe('children');
  });

  it('应该返回 children 给 orchestrator 角色', () => {
    expect(resolveSubagentControlScopeForRole('orchestrator')).toBe('children');
  });

  it('应该返回 none 给 leaf 角色', () => {
    expect(resolveSubagentControlScopeForRole('leaf')).toBe('none');
  });
});

describe('resolveSubagentCapabilities', () => {
  it('应该返回 main 角色的完整能力', () => {
    const caps = resolveSubagentCapabilities({ depth: 0 });
    expect(caps).toEqual({
      depth: 0,
      role: 'main',
      controlScope: 'children',
      canSpawn: true,
      canControlChildren: true,
    });
  });

  it('应该返回 orchestrator 角色的能力', () => {
    const caps = resolveSubagentCapabilities({ depth: 1, maxSpawnDepth: 3 });
    expect(caps).toEqual({
      depth: 1,
      role: 'orchestrator',
      controlScope: 'children',
      canSpawn: true,
      canControlChildren: true,
    });
  });

  it('应该返回 leaf 角色的限制能力', () => {
    const caps = resolveSubagentCapabilities({ depth: 3, maxSpawnDepth: 3 });
    expect(caps).toEqual({
      depth: 3,
      role: 'leaf',
      controlScope: 'none',
      canSpawn: false,
      canControlChildren: false,
    });
  });
});

describe('resolveStoredSubagentCapabilities', () => {
  it('应该使用存储中的角色信息', () => {
    const store = {
      'agent:test:session1': {
        sessionId: 'session1',
        subagentRole: 'orchestrator',
        subagentControlScope: 'children',
      },
    };

    const caps = resolveStoredSubagentCapabilities('agent:test:session1', { store });
    expect(caps.role).toBe('orchestrator');
    expect(caps.controlScope).toBe('children');
  });

  it('应该在没有存储信息时使用默认解析', () => {
    const store: Record<string, unknown> = {};

    const caps = resolveStoredSubagentCapabilities('agent:test:session1', {
      store: store as any,
      maxSpawnDepth: 3,
    });

    // 深度为 1 时应该是 orchestrator
    expect(caps.role).toBe('orchestrator');
  });

  it('应该处理 null sessionKey', () => {
    const caps = resolveStoredSubagentCapabilities(null);
    expect(caps.role).toBe('main');
    expect(caps.depth).toBe(0);
  });

  it('应该处理 undefined sessionKey', () => {
    const caps = resolveStoredSubagentCapabilities(undefined);
    expect(caps.role).toBe('main');
  });
});

describe('normalizeSubagentSessionKey', () => {
  it('应该规范化有效的会话 Key', () => {
    expect(normalizeSubagentSessionKey('agent:test:session1')).toBe('agent:test:session1');
  });

  it('应该去除首尾空白', () => {
    expect(normalizeSubagentSessionKey('  agent:test:session1  ')).toBe('agent:test:session1');
  });

  it('应该返回 undefined 对于空字符串', () => {
    expect(normalizeSubagentSessionKey('')).toBeUndefined();
    expect(normalizeSubagentSessionKey('   ')).toBeUndefined();
  });

  it('应该返回 undefined 对于非字符串', () => {
    expect(normalizeSubagentSessionKey(null)).toBeUndefined();
    expect(normalizeSubagentSessionKey(undefined)).toBeUndefined();
    expect(normalizeSubagentSessionKey(123)).toBeUndefined();
  });
});

describe('generateSubagentSessionKey', () => {
  it('应该生成新的会话 Key', () => {
    const key = generateSubagentSessionKey();
    expect(key).toMatch(/^agent:slide:default:slide_[a-z0-9]+$/);
  });

  it('应该生成带父 Key 的子会话 Key', () => {
    const parentKey = 'agent:slide:default:parent';
    const childKey = generateSubagentSessionKey(parentKey);
    expect(childKey).toMatch(/^agent:slide:default:parent\.slide_[a-z0-9]+$/);
  });

  it('应该生成唯一的 Key', () => {
    const key1 = generateSubagentSessionKey();
    const key2 = generateSubagentSessionKey();
    expect(key1).not.toBe(key2);
  });
});

describe('parseAgentHierarchy', () => {
  it('应该解析根 Agent', () => {
    const hierarchy = parseAgentHierarchy('agent:slide:default:main');
    expect(hierarchy).toEqual({
      rootId: 'agent:slide:default:main',
      parentId: undefined,
      depth: 1,
    });
  });

  it('应该解析一级子 Agent', () => {
    const hierarchy = parseAgentHierarchy('parent.child');
    expect(hierarchy).toEqual({
      rootId: 'parent',
      parentId: 'parent',
      depth: 2,
    });
  });

  it('应该解析多级子 Agent', () => {
    const hierarchy = parseAgentHierarchy('root.level1.level2.level3');
    expect(hierarchy).toEqual({
      rootId: 'root',
      parentId: 'root.level1.level2',
      depth: 4,
    });
  });
});

describe('isSubagentSessionKey', () => {
  it('应该识别 agent: 格式的 Key', () => {
    expect(isSubagentSessionKey('agent:slide:default:session1')).toBe(true);
  });

  it('应该识别点号分隔的 Key', () => {
    expect(isSubagentSessionKey('parent.child')).toBe(true);
  });

  it('应该拒绝普通字符串', () => {
    expect(isSubagentSessionKey('regular-session-key')).toBe(false);
  });
});
