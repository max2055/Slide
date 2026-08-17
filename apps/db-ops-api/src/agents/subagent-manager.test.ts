import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '@slide/agent-core';
import type { ActorContext } from '../auth/actor-context.js';
import { SubagentManager } from './subagent-manager.js';
import { subagentRegistry } from './subagent-registry.js';

const actor = (userId: number): ActorContext => Object.freeze({
  userId,
  username: `actor-${userId}`,
  roles: Object.freeze(['admin']),
  permissions: Object.freeze(['config:manage']),
  sessionVersion: 1,
  instanceScopes: Object.freeze({}),
  requestId: `subagent-test-${userId}`,
});
function runner(run: () => Promise<any>): AgentRunner {
  return { run, getDefaultModel: () => 'test-model' } as unknown as AgentRunner;
}

afterEach(() => {
  vi.useRealTimers();
  subagentRegistry.clear();
});

describe('SubagentManager security boundary', () => {
  it('binds run access to the parent Actor', async () => {
    const manager = new SubagentManager(runner(async () => ({ finalContent: 'done' })));
    const owner = actor(10);
    const runId = await manager.spawn('slide-default', 'inspect metrics', 'parent-session', owner);

    expect(await manager.access(runId, actor(11))).toEqual({
      status: 'failed',
      error: 'Subagent run not found',
    });
    await vi.waitFor(async () => {
      expect((await manager.access(runId, owner)).status).toBe('completed');
    });
  });

  it('limits concurrent runs per Actor and validates agent IDs', async () => {
    vi.useFakeTimers();
    const manager = new SubagentManager(runner(() => new Promise(() => undefined)));
    const owner = actor(12);

    await manager.spawn('slide-default', 'task one', 'parent-session', owner);
    await manager.spawn('slide-default', 'task two', 'parent-session', owner);
    await expect(manager.spawn('slide-default', 'task three', 'parent-session', owner))
      .rejects.toThrow('SUBAGENT_CONCURRENCY_LIMIT');
    await expect(manager.spawn('../invalid', 'task', 'parent-session', actor(13)))
      .rejects.toThrow('SUBAGENT_AGENT_ID_INVALID');
  });
});
