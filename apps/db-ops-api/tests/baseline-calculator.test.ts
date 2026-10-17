import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), discover: vi.fn() }));
vi.mock('../src/db-connection.js', () => ({ dbConnection: { getPool: () => ({ execute: mocks.execute }) } }));
vi.mock('../src/metrics/consumers/runtime.js', () => ({ metricConsumerService: { discover: mocks.discover } }));
import { SemanticBaselineService } from '../src/metrics/consumers/baseline.js';

const sample = (value: string, quality = 'good') => ({ payload: {value: {encoding:'uint64',value},quality:{status:quality},accuracy:'exact'} });
const context = () => ({ definitions: [{id:'mysql.threads.running',semantic_version:'1.0.0',unit:'count',kind:'gauge',dimensions:{keys:[]}}],
  effective:{published_revision:3,resolved:{plan:{binding:{package:{id:'mysql-diagnostics'}}},settings:{enabled:true},metric_templates:[{metric:{id:'mysql.threads.running'},enabled:true}]}} });

describe('baselines from accepted metric evidence', () => {
  const service = new SemanticBaselineService();
  beforeEach(() => { vi.resetAllMocks(); mocks.discover.mockResolvedValue(context()); });
  it('computes a population deviation from exact good samples, recording revision, definition and unit', async () => {
    mocks.execute.mockResolvedValueOnce([[...Array.from({length:10},(_,i)=>sample(String(i+1))),sample('999','partial'),sample('9007199254740993')]])
      .mockResolvedValueOnce([{}]);
    const result = await service.compute(7,'threads_running');
    expect(result).toMatchObject({success:true,result:{mean:5.5,sampleCount:10}});
    expect(result.result!.stddev).toBeCloseTo(Math.sqrt(8.25));
    const [sql, params] = mocks.execute.mock.calls[0];
    expect(sql).toContain('metric_publications');
    expect(sql).toContain('p.generation = r.generation');
    expect(params.slice(0,5)).toEqual(['instance','7',3,'mysql.threads.running','1.0.0']);
    const payload=JSON.parse(mocks.execute.mock.calls[1][1][3]);
    expect(payload).toMatchObject({unit:'count',metric:{id:'mysql.threads.running',semantic_version:'1.0.0'}});
  });
  it('rejects insufficient samples and never falls back to historical metrics or caches', async () => {
    mocks.execute.mockResolvedValueOnce([[sample('7'),sample('8')]]);
    expect(await service.compute(7,'threads_running')).toEqual({success:false,error:'METRIC_BASELINE_INSUFFICIENT_SAMPLES'});
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['counter','dimensioned','disabled','unmapped'])('keeps %s references unavailable instead of silently changing their meaning', async state => {
    const ctx=context();
    if(state==='counter')ctx.definitions[0].kind='counter';
    if(state==='dimensioned')(ctx.definitions[0].dimensions.keys as unknown[])=[{name:'mount',required:true}];
    if(state==='disabled')ctx.effective.resolved.settings.enabled=false;
    mocks.discover.mockResolvedValue(ctx);
    expect((await service.compute(7,state==='unmapped'?'cpu_usage':'threads_running')).success).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not reuse cached values of another revision, unit or metric version', async () => {
    const payload={metric:{id:'mysql.threads.running',semantic_version:'1.0.0'},unit:'%',result:{mean:99,stddev:1,lowerBound:97,upperBound:101}};
    mocks.execute.mockResolvedValue([[{payload}]]);
    expect(await service.cached(7,'threads_running')).toBeNull();
    expect(mocks.execute.mock.calls[0][1]).toEqual(['instance:7','threads_running',3]);
    payload.unit='count';
    expect(await service.cached(7,'threads_running')).toEqual(payload.result);
  });
  it('validates inputs before any query', async () => {
    expect(await service.compute(7,'threads_running',NaN)).toMatchObject({success:false,error:'METRIC_BASELINE_INPUT'});
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
