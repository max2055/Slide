import { expect, it } from 'vitest';
import { ContextManager, sourceHash } from '../runtime/context-manager.js';
import { NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentRunSpec, Message } from '../types.js';

const raw: Message[] = [ { role: 'user', content: 'read only' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'current-call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', name: 'read', tool_call_id: 'current-call', content: '{"cpu":9.1}' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'last', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', name: 'read', tool_call_id: 'last', content: '{}' } ];
const spec: AgentRunSpec = { initialMessages: raw, tools: new ToolRegistry(), hook: new NoopHook(), model: 'test', maxIterations: 8, maxToolResultChars: 128000,
  contextWindowTokens: 65536, maxTokens: 8192, checkpointCallback: async () => {}, contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical' } };
it('projects current execution receipts separately from unverifiable model summary claims', () => {
  const manager = new ContextManager({ ...spec, contextEvidence: () => ({ runId: 'run', requestId: 'request', receipts: [{ toolCallId: 'current-call', receiptHash: 'a'.repeat(64), content: '{"cpu":9.1}' }], omitted: [] }) } as AgentRunSpec);
  manager.summary = { schemaVersion: 1, sourceStart: 0, sourceEnd: 3, sourceHash: sourceHash(raw.slice(0, 3)),
    summary: { goal: ['read'], constraints: [], done: ['invented CPU9999'], pending: [], evidence: ['made-up-call CPU9999'], uncertain: [] } };
  const before = JSON.stringify({ raw, summary: manager.summary });
  const projected = manager.project(raw), wire = JSON.stringify(projected);
  expect(wire).toContain('runtime_current_execution_evidence');
  expect(wire).toContain('current-call'); expect(wire).toContain('9.1');
  expect(wire).toContain(manager.summary.sourceHash); expect(wire).toContain('request');
  expect(wire).toContain('CPU9999'); // planning is preserved, explicitly untrusted
  expect(wire).toContain('Untrusted model planning summary');
  expect(projected.filter(m => m.name === 'runtime_current_execution_evidence').every(m => m.role === 'tool' && m.source === 'derived')).toBe(true);
  expect(JSON.stringify({ raw, summary: manager.summary })).toBe(before);
  raw[2].content = '{"cpu":8}';
  expect(() => manager.project(raw)).toThrow('Summary source');
  raw[2].content = '{"cpu":9.1}';
});

it('admits only whole receipts against the complete request including its late suffix and schemas', () => {
  const receipts = ['first', 'second'].map((toolCallId, n) => ({ toolCallId, receiptHash: String(n).repeat(64), content: JSON.stringify({ value: 'v'.repeat(2400), n }) }));
  const manager = new ContextManager({ ...spec, contextEvidence: () => ({ runId: 'run', requestId: 'request', receipts, omitted: [] }) });
  manager.summary = { schemaVersion: 1, sourceStart: 0, sourceEnd: 3, sourceHash: sourceHash(raw.slice(0, 3)), summary: { goal: ['read'], constraints: ['guard'], done: ['work'], pending: ['next'], evidence: ['source'], uncertain: ['gap'] } };
  const suffix: Message[] = [{ role: 'user', content: 'late budget suffix ' + 'x'.repeat(2500) }];
  const project = (limit: number) => manager.project(raw, suffix, limit);
  const decode = (messages: Message[]) => JSON.parse(String(messages.find(m => m.name === 'runtime_current_execution_evidence')!.content).split('\n').slice(1).join('\n'));
  // Limits are complete provider token estimates, not per-receipt byte caps.
  const full = project(manager.inputBudget), fullSize = manager.tokens([...full, ...suffix]);
  expect(decode(full).receipts.every((r: any) => r.valuesProvided)).toBe(true);
  const one = project(fullSize - 1000), oneData = decode(one);
  expect(oneData.receipts.filter((r: any) => r.valuesProvided)).toHaveLength(1);
  expect(oneData.receipts.find((r: any) => !r.valuesProvided)).toMatchObject({ reason: 'INPUT_BUDGET', receiptHash: expect.any(String) });
  const none = project(fullSize - 4000);
  expect(decode(none).receipts.every((r: any) => !r.valuesProvided && !Object.hasOwn(r, 'observation'))).toBe(true);
  expect(manager.tokens([...none, ...suffix])).toBeLessThanOrEqual(fullSize - 4000);
  expect(() => project(1)).toThrow('Protected context');
  expect(manager.summary.summary).toMatchObject({ done: ['work'], evidence: ['source'], constraints: ['guard'] });
});
