import { expect,it } from 'vitest';
import { configuredRetention,validateRetention,observationSelections,DEFAULT_RETENTION } from './retention.js';
it('keeps existing defaults and only applies explicitly enabled type-specific retention',()=>{
  expect(configuredRetention({METRICS_RETENTION_VALUE_TYPES_JSON:'invalid'})).toEqual(DEFAULT_RETENTION);
  const p=validateRetention({...DEFAULT_RETENTION,valueTypeMs:{histogram:86400000,uint64:2*86400000}});
  const s=observationSelections(new Date('2026-11-01T00:00:00Z'),p).normalized;
  expect(s.where).toContain('CASE');expect(s.params).toEqual(['histogram','2026-10-31 00:00:00.000','uint64','2026-10-30 00:00:00.000','2026-10-02 00:00:00.000']);
  expect(s.where).toContain('NOT EXISTS');
});
it.each([{other:1},{uint64:0},{summary:NaN},{histogram:31*86400000},[],null,false,0])('rejects invalid or wider-than-ceiling value retention %j',valueTypeMs=>{
  expect(()=>validateRetention({...DEFAULT_RETENTION,valueTypeMs:valueTypeMs as any})).toThrow('RETENTION_INVALID');
});
it('reads explicit configured type retention and rejects malformed configuration',()=>{
  const env={METRICS_RETENTION_ENABLED:'true',METRICS_RETENTION_RAW_MS:'86400000',METRICS_RETENTION_HISTORY_MS:String(30*86400000),METRICS_RETENTION_ATTEMPT_MS:'86400000',METRICS_RETENTION_VALUE_TYPES_JSON:'{"histogram":172800000}'};
  expect(configuredRetention(env).valueTypeMs).toEqual({histogram:172800000});expect(()=>configuredRetention({...env,METRICS_RETENTION_VALUE_TYPES_JSON:'null'})).toThrow('RETENTION_INVALID');
});
it('includes independent trend and value-type durations in the existing worker preview policy hash',async()=>{
 const {retentionPolicyHash}=await import('../workflows/metric-retention-handler.js');
 const p={...DEFAULT_RETENTION,trendMs:365*86400000,valueTypeMs:{float64:86400000,summary:2*86400000}};
 expect(retentionPolicyHash(p)).not.toBe(retentionPolicyHash({...p,trendMs:180*86400000}));
 expect(retentionPolicyHash(p)).not.toBe(retentionPolicyHash({...p,valueTypeMs:{...p.valueTypeMs,float64:2*86400000}}));
 expect(retentionPolicyHash(p)).toBe(retentionPolicyHash({...p,valueTypeMs:{summary:2*86400000,float64:86400000}}));
});
it('supports separately bounded per-encoding trend lifetimes and conservative unknown fallback',()=>{
 const env={METRICS_RETENTION_ENABLED:'true',METRICS_RETENTION_RAW_MS:'86400000',METRICS_RETENTION_HISTORY_MS:String(30*86400000),METRICS_RETENTION_ATTEMPT_MS:'86400000',METRICS_RETENTION_TREND_MS:String(365*86400000),METRICS_RETENTION_TREND_VALUE_TYPES_JSON:'{"float64":7776000000}'};
 expect(configuredRetention(env).trendValueTypeMs).toEqual({float64:90*86400000});
 for(const trendValueTypeMs of [null,[],0,{unknown:86400000},{float64:366*86400000},{histogram:299999}])expect(()=>validateRetention({...DEFAULT_RETENTION,trendValueTypeMs:trendValueTypeMs as any})).toThrow('RETENTION_INVALID');
});
