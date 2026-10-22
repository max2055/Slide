import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { responseHash } from '@slide/agent-core';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { admin } from '../metrics/policy/test-support.js';
import { investigationToolContextResult } from './executor.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-discovery-b5-20261022.json', import.meta.url), 'utf8'));
const catalog = fixture.discoveryReceipt.data;

describe('B5 discovery is actionable before explicit metric reads', () => {
  it('keeps every actual ID and semantic index in the retained canonical model projection', () => {
    const before = JSON.stringify(fixture.discoveryReceipt);
    const view = JSON.parse(String(investigationToolContextResult(fixture.discoveryReceipt, 'retained-discovery', 'ops', 'query_metrics')));
    expect(view.data.metric_ids).toEqual(catalog.definitions.map((d: any) => d.id));
    expect(view.data.definitions.find((d: any) => d.id === 'custom.mysql.slow_queries_snapshot'))
      .toMatchObject({ kind: 'gauge', unit: 'count', semantic_version: '1.0.0' });
    expect(view.data.contextReference.sha256).toBe(responseHash(fixture.discoveryReceipt));
    expect(view.data.evidenceOmitted).not.toBe(true);
    expect(view.data.discovery.detail).toBe('index');
    expect(JSON.stringify(fixture.discoveryReceipt)).toBe(before);
    expect(JSON.parse(String(investigationToolContextResult(view, 'retained-discovery', 'ops', 'query_metrics')))).toEqual(view);
  });

  it('offers strict, bounded, exhaustive discovery pages and explicit full definitions', async () => {
    const tool = createQueryMetricsTool({ discover: async () => catalog } as any);
    const base = { resourceType: 'instance', resourceId: 1, mode: 'discover' };
    const ids: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const receipt: any = await tool.handler({ ...base, discovery_offset: offset, discovery_limit: 8 }, { actor: admin });
      expect(receipt.success).toBe(true);
      expect(receipt.data.definitions.length).toBeLessThanOrEqual(8);
      expect(receipt.data.effective).toBeUndefined();
      ids.push(...receipt.data.metric_ids);
      offset = receipt.data.discovery.next_offset;
    }
    expect(ids).toEqual(catalog.definitions.map((d: any) => d.id));
    const chosen = catalog.definitions.find((d: any) => d.id === 'custom.mysql.processlist_connections');
    const detail: any = await tool.handler({ ...base, metric_ids: [chosen.id] }, { actor: admin });
    expect(detail).toMatchObject({ success: true, data: { definitions: [chosen], discovery: { detail: 'definition', next_offset: null } } });
    for (const extra of [{ discovery_limit: 65 }, { discovery_offset: -1 }, { metric_ids: [chosen.id], discovery_offset: 0 }, { metric_ids: [chosen.id, chosen.id] }])
      expect(await tool.handler({ ...base, ...extra }, { actor: admin })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(await tool.handler({ ...base, metric_ids: ['invented.metric'] }, { actor: admin })).toMatchObject({ success: false, errorCode: 'UNKNOWN_METRIC' });
    expect(await tool.handler({ ...base, mode: 'realtime', discovery_limit: 8 }, { actor: admin })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(await tool.handler(base, {})).toMatchObject({ success: false, errorCode: 'AUTH_REQUIRED' });
  });
});
