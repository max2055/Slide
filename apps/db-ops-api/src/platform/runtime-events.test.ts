import { expect, it, vi } from 'vitest';
import { recordRuntimeEvent } from './runtime-events.js';
import { platformLogs } from './structured-log-evidence-adapter.js';
import type { RuntimeEvent } from '@slide/agent-core';

it('bridges only safe correlation fields and distinguishes readiness from commit', () => {
  const record = vi.spyOn(platformLogs, 'record').mockImplementation(() => {});
  try {
    recordRuntimeEvent({ type: 'response.ready', runId: 'run-1', turnId: 'turn-1', modelStep: 3, sequence: 5,
      content: 'private-user-text', apiKey: 'private-secret' } as unknown as RuntimeEvent);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ component: 'agent', eventType: 'runtime.response.ready', status: 'ok', correlationId: 'run-1', traceId: 'turn-1:3:5' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    expect(JSON.stringify(record.mock.calls)).not.toContain('run.completed');
  } finally { record.mockRestore(); }
});
it('retains bounded traces and whitelisted cumulative counters in the existing store', async () => {
  const { StructuredLogEvidenceAdapter } = await import('./structured-log-evidence-adapter.js');
  const store = new StructuredLogEvidenceAdapter(() => 1000, 20);
  for (let i = 0; i < 30; i++) store.record({ component: 'agent', eventType: 'runtime.model.start', status: 'ok', correlationId: 'run-1', traceId: `turn-1:${i}`, runtimeCounters: {
    modelStep: i, providerAttempts: i, toolCalls: 0, recoveryCount: 0, inputTokens: i * 10, cachedInputTokens: i, outputTokens: i, unknownRequests: 0, reservedTokens: 0, secret: 'private',
  } as any });
  const result = store.query({ component: 'agent' });
  expect(result.groups[0].traceIds).toHaveLength(10);
  expect(result.groups[0].latestRuntimeCounters).toMatchObject({ modelStep: 29, inputTokens: 290, cachedInputTokens: 29 });
  expect(result.gaps).toContain('LOG_BUFFER_TRUNCATED');
  expect(JSON.stringify(result)).not.toContain('private');
});
