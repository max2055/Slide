import { describe, expect, it } from 'vitest';
import type { AnyAgentTool } from './types.js';
import {
  assertToolSecurityCatalogCoverage,
  getToolSecurityDefinition,
} from './security-catalog.js';

function tool(name: string): AnyAgentTool {
  return {
    name,
    description: 'test tool',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ success: true }),
  };
}

describe('agent tool security catalog', () => {
  it('fails closed when a registered tool has no operator-owned security definition', () => {
    expect(() => assertToolSecurityCatalogCoverage([tool('unclassified_tool')]))
      .toThrow(/unclassified_tool/);
  });

  it('defines the complete security posture for an actor-facing tool', () => {
    expect(getToolSecurityDefinition('slide_add_database')).toMatchObject({
      audience: 'actor',
      effect: 'write',
      resource: 'database-target',
      approval: 'always',
      network: 'registered-database',
      credentials: 'use',
    });
    expect(getToolSecurityDefinition('slide_add_database')?.permissions.length).toBeGreaterThan(0);
    expect(getToolSecurityDefinition('slide_add_database_batch')).toMatchObject({
      audience: 'actor', effect: 'write', resource: 'database-target',
      permissions: ['instance:create'], approval: 'always',
      network: 'registered-database', credentials: 'use',
    });
    expect(getToolSecurityDefinition('slide_add_network_device')).toEqual({
      audience: 'actor', effect: 'write', resource: 'network_device',
      permissions: ['network_devices:manage'], approval: 'always',
      network: 'none', credentials: 'none',
    });
  });

  it('keeps completion internal and gates delegation with operator permission', () => {
    expect(getToolSecurityDefinition('slide_complete_analysis')?.audience).toBe('internal');
    expect(getToolSecurityDefinition('spawn_subagent')).toMatchObject({
      audience: 'actor',
      effect: 'delegate',
      permissions: ['config:manage'],
    });
    expect(getToolSecurityDefinition('access_subagent')?.permissions).toEqual(['config:manage']);
  });

  it('requires approval and forbids network and credentials for arbitrary code execution', () => {
    expect(getToolSecurityDefinition('execute_code')).toEqual({
      audience: 'actor',
      effect: 'execute',
      resource: 'none',
      permissions: ['ai:execute'],
      approval: 'always',
      network: 'none',
      credentials: 'none',
    });
  });

  it('gives database discovery a separate network-scanning permission and profile', () => {
    expect(getToolSecurityDefinition('discover_database_endpoints')).toEqual({
      audience: 'actor', effect: 'execute', resource: 'network-scan', permissions: ['network:discover'],
      approval: 'always', network: 'restricted', credentials: 'none',
    });
  });
});
