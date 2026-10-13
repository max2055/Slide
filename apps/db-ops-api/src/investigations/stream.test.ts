import { describe, expect, it } from 'vitest';
import { emptyInvestigationProjection, reduceInvestigationEvents, publicDocument } from './stream.js';
import type { InvestigationStreamEvent } from './contracts.js';

const id = '11111111-1111-4111-8111-111111111111';
const event = (sequence: number, version: number) => ({ schemaVersion: 1, sequence, investigationId: id,
  occurredAt: '2026-10-13T00:00:00.000Z', type: 'investigation.changed', payload: { version, lifecycle: 'open', problemStatus: 'unconfirmed' } } as InvestigationStreamEvent);
describe('durable investigation reducer', () => {
  it('orders and deduplicates a replay batch and rejects foreign investigations', () => {
    const state = reduceInvestigationEvents(emptyInvestigationProjection(id), [event(2, 2), event(1, 1), event(2, 2)]);
    expect(state.sequence).toBe(2);
    expect(state.metadata?.version).toBe(2);
    expect(reduceInvestigationEvents(state, [event(1, 1)])).toEqual(state);
    expect(() => reduceInvestigationEvents(state, [{ ...event(3, 3), investigationId: 'other' }])).toThrow();
  });
  it('does not advance past an unfilled gap', () => {
    expect(() => reduceInvestigationEvents(emptyInvestigationProjection(id), [event(2, 2)])).toThrow('REPLAY_REQUIRED');
  });
  it('late append after end advances only the event cursor; displayed text stays unchanged', () => {
    const frame = (sequence: number, operations: any[]) => ({ schemaVersion: 1, sequence, investigationId: id, requestId: 'request', runId: 'run',
      occurredAt: '2026-10-13T00:00:00.000Z', type: 'parts.operation', payload: { version: 1, runId: 'run', attempt: 0, sequence, operations } } as InvestigationStreamEvent);
    const initial = reduceInvestigationEvents(emptyInvestigationProjection(id), [frame(1, [{ type: 'part.start', messageId: 'm', part: { id: 'p', source: 'fact', status: 'partial', type: 'text', text: 'confirmed' } }]), frame(2, [{ type: 'part.end', partId: 'p' }])]);
    const late = reduceInvestigationEvents(initial, [frame(3, [{ type: 'part.append', partId: 'p', text: 'late corruption' }])]);
    expect(late.runs.run.parts).toEqual(initial.runs.run.parts);
    expect(late.sequence).toBe(3);
  });
  it('removes unbounded reasoning and redacts tool arguments before display', () => {
    const durable = { kind: 'mysql', reference: 'm' };
    const doc = publicDocument({ version: 1, id: 'm', role: 'assistant', runId: 'r', turnId: 't', source: 'fact', status: 'completed', durable,
      parts: [{ id: 'think', type: 'reasoning', format: 'think', text: 'hidden chain', source: 'fact', status: 'completed', durable },
        { id: 'tool', type: 'tool_call', call: { id: 'tc', type: 'function', function: { name: 'inspect', arguments: '{"token":"fake-secret"}' } }, source: 'fact', status: 'completed', durable }], legacy: { reasoning_content: 'hidden chain' } } as any);
    expect(JSON.stringify(doc)).not.toMatch(/hidden chain|fake-secret/);
    expect(doc.parts).toHaveLength(1);
  });
});
