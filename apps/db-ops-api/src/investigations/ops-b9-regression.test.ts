import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { responseHash } from '@slide/agent-core';
import { investigationToolContextResult, investigationContextMessages } from './executor.js';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { investigationToolContract } from './tool-contract.js';
import { admin } from '../metrics/policy/test-support.js';
const b9 = JSON.parse(readFileSync(new URL('./fixtures/ops-output-b9-20261022.json', import.meta.url), 'utf8'));
const histories = b9.entries.filter((m: any) => m.role === 'tool' && m.name === 'query_metrics')
  .map((m: any) => ({ ...m, receipt: JSON.parse(m.content) })).filter((m: any) => m.receipt.data?.metrics);
// Versioned Provider-only encoding. Defaults apply only to bucket fields that
// occur identically in EVERY bucket, including explicit nulls. No raw mutation.
function expand(view: any) {
  const data = structuredClone(view.data);
  for (const m of data.metrics) for (const s of m.series) {
    s.buckets = s.buckets.map((b: any) => ({ ...s.bucketDefaults, ...b }));
    delete s.bucketDefaults;
  }
  return data;
}
describe('B9 real six-minute receipts remain numeric in ordinary model projection', () => {
  it.each(histories)('preserves the complete retained window for $tool_call_id', ({ receipt, tool_call_id }: any) => {
    const before = JSON.stringify(receipt);
    const view = JSON.parse(String(investigationToolContextResult(receipt, tool_call_id, 'ops', 'query_metrics')));
    expect(view.data.contextProjection).toBe('metric_window_v1');
    expect(view.data.evidenceOmitted).not.toBe(true);
    expect(expand(view).metrics).toEqual(receipt.data.metrics);
    expect(view.data.window).toEqual(receipt.data.window);
    expect(view.data.contextReference.sha256).toBe(responseHash(receipt));
    expect(view.status).toBe(receipt.status);
    expect(view.next_actions).toEqual(receipt.next_actions);
    expect(JSON.stringify(receipt)).toBe(before);
    expect(investigationContextMessages([{ role: 'tool', name: 'query_metrics', tool_call_id, content: JSON.stringify(view) }], 'ops')[0].content).toBe(JSON.stringify(view));
    const visible = expand(view).metrics[0].series.flatMap((s: any) => s.buckets);
    expect(visible.some((b: any) => b.value !== null)).toBe(true);
    expect(visible.some((b: any) => b.value === null && b.quality.status === 'unknown')).toBe(true);
  });
  it('prevents the actual rejected multi-metric+series shape in Provider schema while the public tool retains multi-metric reads', async () => {
    const tool = createQueryMetricsTool({ query: async () => histories[0].receipt.data } as any);
    const contract = investigationToolContract(tool as any, [{ type: 'instance', id: 1 }, { type: 'server', id: 3 }], { maxRows: 100, maxWindowMs: 3600000 })!;
    const validate = new Ajv2020({ strict: false }).compile(contract.parameters);
    const args = { resourceType: 'instance', resourceId: 1, mode: 'history', metric_ids: ['mysql.processlist.count', 'mysql.connections.limit'], series_index: 0 };
    expect(validate(args)).toBe(false);
    expect(await tool.handler(args, { actor: admin })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(await tool.handler({ ...args, series_index: undefined }, { actor: admin })).toMatchObject({ success: true });
    expect(validate({ ...args, resourceType: 'server', resourceId: 1, metric_ids: [args.metric_ids[0]] })).toBe(false);
    expect(validate({ ...args, metric_ids: [args.metric_ids[0]] })).toBe(true);
  });
});
