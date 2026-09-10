import { expect, it, vi } from 'vitest';
import { createEvidenceEvaluationTools } from './evidence-tools.js';
it('exposes authorized evaluation and recovery reads and a declared decision metadata write', async () => {
  const service = { evaluate: vi.fn(async () => ({})), recordDecision: vi.fn(async () => ({})), recovery: vi.fn(async () => ({})) };
  const tools = createEvidenceEvaluationTools(service);
  const evaluation = tools.find(tool => tool.name === 'evaluate_evidence')!;
  expect(await evaluation.handler({ resourceType: 'instance', resourceId: 1 }, {})).toMatchObject({ success: false });
  const actor = { userId: 1 } as any;
  expect(await evaluation.handler({ resourceType: 'instance', resourceId: 1 }, { actor })).toMatchObject({ success: true });
  expect(service.evaluate).toHaveBeenCalledWith(actor, { type: 'instance', id: 1 });
  expect(tools.find(tool => tool.name === 'record_evidence_decision')!.readOnly).toBe(false);
  expect(tools.find(tool => tool.name === 'verify_operation_recovery')!.readOnly).toBe(true);
});
