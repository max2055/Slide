import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { actorContextService, type ActorContext } from '../../auth/actor-context.js';
import { RolloutInput, RolloutStep } from '../../contracts/metrics/template-governance.js';
import type { TemplateBindingService } from './binding-service.js';
import { TemplateGovernance } from './governance.js';
const pin = { template_id: 'template-a', version: 1, content_hash: 'sha256:' + '1'.repeat(64) };
const value = {
  operation_key: 'one-intent',
  pins: [pin],
  resources: [{ resource: { type: 'instance', id: 7 }, expected_revision: 0 }],
};
describe('MAX244 governance intent boundaries', () => {
  it('accepts bounded exact intent but rejects duplicate scope or template identities', () => {
    expect(RolloutInput.parse(value)).toEqual(value);
    expect(RolloutInput.safeParse({ ...value, pins: [pin, pin] }).success).toBe(false);
    expect(
      RolloutInput.safeParse({ ...value, resources: [...value.resources, ...value.resources] })
        .success,
    ).toBe(false);
  });
  it('rejects authority injection, missing stable command key and invalid revisions', () => {
    expect(RolloutInput.safeParse({ ...value, actor_id: 1 }).success).toBe(false);
    expect(
      RolloutInput.safeParse({
        ...value,
        resources: [{ resource: { type: 'instance', id: 7 }, expected_revision: -1 }],
      }).success,
    ).toBe(false);
    expect(RolloutStep.safeParse({ action: 'retry' }).success).toBe(false);
    expect(RolloutStep.safeParse({ action: 'unbind', operation_key: 'one' }).success).toBe(false);
    expect(RolloutStep.parse({ action: 'rollback', operation_key: 'one' }).action).toBe('rollback');
  });
});

describe('rollout receipt attribution', () => {
  it('shows the current attempt state while retaining the previous revision for retry', async () => {
    const actor: ActorContext = {
      userId: 1, username: 'operator', roles: [], permissions: ['*'], instanceScopes: {},
      sessionVersion: 0, requestId: 'rollout-receipts',
    };
    const live = vi.spyOn(actorContextService, 'revalidateActor').mockResolvedValue(actor);
    const states = ['ready', 'failed', 'unknown', 'submitted'] as const;
    const items = states.map((state, index) => ({
      state,
      resource: { type: 'server', id: index + 1 },
      target_revision: 2,
      error: state === 'failed' ? 'TEMPLATE_BINDING_NOT_EXECUTABLE' : null,
    }));
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('FROM metric_template_rollouts')) return [[{ actor_id: 1, payload: '{}' }]];
      if (sql.includes('FROM metric_template_rollout_items')) return [items.map(payload => ({ payload: JSON.stringify(payload) }))];
      if (sql.includes('FROM metric_collect_requests')) return [[{ id: 7, error_code: 'collection_failed' }]];
      throw new Error('Unexpected rollout receipt query');
    });
    const pool = { execute } as unknown as Pool;
    const binding = {
      status: vi.fn(async () => ({ revision: 2, application: { applied_revision: 2 } })),
    } as unknown as TemplateBindingService;
    try {
      const batch = await new TemplateGovernance(() => pool, binding)
        .read(actor, '9e7b6137-54f4-45dc-8e73-26b660d9b0ca');
      expect(batch.items.map(item => item.receipt)).toEqual(['ready', 'failed', 'unknown', 'applied']);
      expect(batch.items.slice(0, 3).map(item => item.collection_failure)).toEqual([null, null, null]);
      expect(batch.items[1]).toMatchObject({
        target_revision: 2, status: { revision: 2 }, error: 'TEMPLATE_BINDING_NOT_EXECUTABLE',
      });
      expect(execute.mock.calls.filter(([sql]) => sql.includes('FROM metric_collect_requests')))
        .toHaveLength(1);
    } finally {
      live.mockRestore();
    }
  });
});
