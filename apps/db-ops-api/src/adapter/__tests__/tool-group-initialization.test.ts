import { expect, it } from 'vitest';
import { createActorBoundToolRegistry, loadPlatformTools } from '../get-agent-engine.js';
import { registerPredefinedToolGroups, toolCatalog } from '../../tools/catalog.js';
import { decideToolPolicy } from '../../tools/policy.js';
import type { ActorContext } from '../../auth/actor-context.js';

it('OCR-0284 / #388: real platform initialization preserves groups without granting tool authority', async () => {
  // Exercise production discovery, registration, metadata and actor filtering;
  // no handlers, providers, databases or external targets are invoked.
  const registry = await loadPlatformTools();
  const grouped = toolCatalog.getAll().filter(tool => tool.group);
  expect(grouped.length).toBeGreaterThan(0);
  for (const tool of grouped) {
    expect(toolCatalog.expandGroup(tool.group!), tool.name).toContain(tool.name);
  }
  expect(toolCatalog.getGroup('db_ops')?.description).toBe('数据库运维工具');
  const groups = structuredClone(toolCatalog.getGroups());
  registerPredefinedToolGroups();
  expect(await loadPlatformTools()).toBe(registry);
  expect(toolCatalog.getGroups()).toEqual(groups);

  const viewer: ActorContext = {
    userId: 73, username: 'group-viewer', roles: ['viewer'], permissions: [],
    instanceScopes: {}, sessionVersion: 1, requestId: 'group-initialization',
  };
  const admin: ActorContext = { ...viewer, username: 'group-admin', roles: ['admin'] };
  const protectedTool = toolCatalog.get('slide_add_database')!;
  expect(protectedTool).toBeDefined();
  expect(toolCatalog.expandGroup(protectedTool.group!)).toContain(protectedTool.name);
  expect(createActorBoundToolRegistry(viewer).toolNames).not.toContain(protectedTool.name);
  expect(createActorBoundToolRegistry(admin).toolNames).toContain(protectedTool.name);
  expect(decideToolPolicy(viewer, protectedTool, {}).reasonCode).toBe('MISSING_PERMISSION');
  expect(decideToolPolicy(undefined, protectedTool, {}).reasonCode).toBe('MISSING_ACTOR');
  await expect(registry.get(protectedTool.name)!.execute({})).rejects.toThrow('ACTOR_CONTEXT_REQUIRED');
  expect(registry.toolNames).not.toContain('slide_complete_analysis');
});
