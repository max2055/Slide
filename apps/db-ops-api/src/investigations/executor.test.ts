import { describe, expect, it } from 'vitest';
import { boundedInvestigationArguments } from './executor.js';
import { createInvestigationWorkflowHandler } from './workflow-handler.js';
const now = Date.parse('2026-10-12T12:00:00Z'),
  budget = { maxBytes: 128_000, maxRows: 200, maxWindowMs: 3_600_000 };
describe('restricted investigation arguments', () => {
  it('resolves exact trusted resource IDs', () => {
    expect(boundedInvestigationArguments('get_instance_summary', { instance_id: 101 }, budget, now).targets).toEqual([
      { type: 'instance', id: 101 },
    ]);
    expect(
      boundedInvestigationArguments(
        'get_resource_observations',
        { resourceType: 'server', resourceId: 201 },
        budget,
        now,
      ).targets,
    ).toEqual([{ type: 'server', id: 201 }]);
  });
  it.each([
    { instance_id: 101, instanceId: 103 },
    { instance_name: 'one' },
    { host: '127.0.0.1' },
    { sql: 'SELECT 1' },
    { resourceType: 'server', resourceId: 201, instance_id: 101 },
  ])('rejects ambiguous or arbitrary targets %j', (args) => {
    expect(() => boundedInvestigationArguments('query_metrics', args, budget, now)).toThrow();
  });
  it.each([
    { limit: 201 },
    { limit: 0 },
    { period: '7d' },
    { range: '24h' },
    { to: '2026-10-12T12:00:00Z' },
    { from: '2026-10-12T11:00:00Z', since: '2026-10-12T10:00:00Z' },
    { from: '2026-10-10T00:00:00Z', to: '2026-10-12T12:00:00Z' },
    { from: 'invalid' },
    { from: '2026-10-12T13:00:00Z' },
  ])('rejects out-of-budget windows/rows %j', (args) => {
    expect(() => boundedInvestigationArguments('query_metrics', args, budget, now)).toThrow();
  });
  it('bounds implicit history and alert defaults', () => {
    expect(
      boundedInvestigationArguments('query_metrics', { instance_id: 101, mode: 'history' }, budget, now).args,
    ).toMatchObject({ from: '2026-10-12T11:00:00.000Z', to: '2026-10-12T12:00:00.000Z' });
    expect(boundedInvestigationArguments('list_active_alerts', {}, budget, now).args).toMatchObject({
      limit: 100,
      since: '2026-10-12T11:00:00.000Z',
    });
  });
  it('rejects input size before target resolution', () => {
    expect(() =>
      boundedInvestigationArguments('get_instance_summary', { text: 'x'.repeat(budget.maxBytes) }, budget, now),
    ).toThrow('INVESTIGATION_TOOL_INPUT_LIMIT');
  });
  it('workflow payload cannot inject caller/provider parameters', async () => {
    const handler = createInvestigationWorkflowHandler(async () => {
      throw new Error('ENGINE_SHOULD_NOT_LOAD');
    });
    await expect(
      handler({ investigationId: 'id', requestId: 'request', actor: { id: 1 } }, {} as never, {} as never),
    ).rejects.toThrow('INVESTIGATION_JOB_INVALID');
  });
});
