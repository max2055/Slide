import { describe, expect, it } from 'vitest';
import { prepareEvidence } from './evidence-store.js';
describe('investigation evidence snapshot', () => {
  it('redacts before hashing and preserves acquisition vs observation time', () => {
    const value = prepareEvidence({ source: 'mysql', summary: 'observed', resources: [{ type: 'instance', id: 1 }],
      observedFrom: '2026-10-12T00:00:00.000Z', observedTo: '2026-10-12T01:00:00.000Z',
      collectedAt: '2026-10-13T00:00:00.000Z', raw: { password: 'fake-secret', sql: "SELECT * FROM t WHERE x='private-value'", value: null } });
    expect(JSON.stringify(value)).not.toMatch(/fake-secret|private-value/);
    expect(value.raw.value).toBeNull();
    expect(value.collectedAt).not.toBe(value.observedFrom);
  });
  it('rejects invalid and inverted observation windows', () => {
    for (const from of ['2026-02-30T00:00:00.000Z', '2026-10-14T00:00:00.000Z'])
      expect(() => prepareEvidence({ source: 'x', summary: 'x', resources: [], observedFrom: from,
        observedTo: '2026-10-13T00:00:00.000Z', collectedAt: '2026-10-13T00:00:00.000Z', raw: {} })).toThrow();
  });
});
it('recovery retains the original summary so a deployment cannot change evidence identity', async () => {
  const { InvestigationEvidenceStore } = await import('./evidence-store.js');
  const store:any = Object.create(InvestigationEvidenceStore.prototype);
  let receipt:any; store.putOnConnection=async(...args:any[])=>{receipt=args.at(-1);};
  const c:any={execute:async(sql:string)=>[sql.includes('NOW(3)')?[{collected_at:new Date()}]:[{metadata_json:{summary:'历史原始观察；不代表根因已验证。',collectedAt:'2026-10-13T00:00:00.000Z'}}]]};
  await store.captureToolResult(c,{}, {id:'inv',resources:[]}, {investigationId:'inv',requestId:'req',runId:'run'},
    {id:'fact',name:'get_resource_observations',content:{success:true,data:{observations:[]}}});
  expect(receipt.summary).toBe('历史原始观察；不代表根因已验证。');
});
