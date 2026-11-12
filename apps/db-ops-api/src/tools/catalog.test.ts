import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPredefinedToolGroups, toolCatalog } from './catalog.js';
import type { AnyAgentTool } from './types.js';

const fixture: AnyAgentTool = {
  name: 'db_fixture',
  description: 'Catalog fixture',
  group: 'DB-Ops',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ success: true }),
};

describe('OCR-0284 / #388: group registration', () => {
  beforeEach(() => toolCatalog.clear());
  afterEach(() => toolCatalog.clear());

  it.each(['tools-first', 'groups-first'] as const)('preserves membership and predefined metadata: %s', (order) => {
    if (order === 'groups-first') registerPredefinedToolGroups();
    toolCatalog.registerAll([fixture]);
    registerPredefinedToolGroups();

    expect(toolCatalog.getGroup('db_ops')).toEqual({
      name: 'db_ops', description: '数据库运维工具', tools: ['db_fixture'],
    });
    expect(toolCatalog.expandGroup('DB-Ops')).toEqual(['db_fixture']);
    expect(toolCatalog.getAll()).toEqual([fixture]);

    const snapshot = structuredClone(toolCatalog.getGroups());
    toolCatalog.registerAll([fixture]);
    registerPredefinedToolGroups();
    registerPredefinedToolGroups();
    expect(toolCatalog.getGroups()).toEqual(snapshot);
    expect(toolCatalog.getAll()).toEqual([fixture]);
  });

  it('updates metadata while merging normalized members without duplicate nested references', () => {
    toolCatalog.register(fixture);
    toolCatalog.createGroup({ name: 'DB Ops', description: 'Updated', tools: ['DB-Fixture', 'Child', 'child', ''] });
    toolCatalog.createGroup({ name: 'child', description: 'Nested', tools: ['nested_tool'] });
    toolCatalog.createGroup({ name: 'db_ops', description: 'Final', tools: ['child', 'extra_tool'] });

    expect(toolCatalog.getGroup('db_ops')).toEqual({
      name: 'db_ops', description: 'Final', tools: ['db_fixture', 'child', 'extra_tool'],
    });
    expect(toolCatalog.expandGroup('db_ops')).toEqual(['db_fixture', 'nested_tool', 'extra_tool']);
    expect(toolCatalog.getAll()).toEqual([fixture]);
    expect(toolCatalog.has('extra_tool')).toBe(false);
  });
});
