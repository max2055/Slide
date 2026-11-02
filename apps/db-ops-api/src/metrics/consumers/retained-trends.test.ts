import {expect,it,vi} from 'vitest';
import {retainedHierarchy,preserveBeforePrune} from './retained-trends.js';
import {trendHierarchy} from './trends.js';
import {sample,identify} from '../../contracts/metrics/fixtures.js';
import {DEFAULT_RETENTION,validateRetention} from '../retention.js';
const from='2026-08-01T00:00:00Z',to='2026-08-01T01:00:00Z';
const points=[0,60000,300000].map((ms,i)=>identify({...sample('db.uptime_seconds'),observed_at:new Date(Date.parse(from)+ms).toISOString(),value:{encoding:'uint64' as const,value:String(i===1?9007199254740993n:BigInt(i))}}));
const metadata={resource_type:points[0].resource_type,resource_id:points[0].resource_id,metric:points[0].metric,dimensions:points[0].dimensions};
it('Chief R5: persisted sufficient statistics merge with raw using exact weighted sum/count and peak',()=>{
 const stored=trendHierarchy(points.slice(0,2),from,to,60000,'5m')['5m'].filter(b=>b.count).map(bucket=>({bucket,metadata}));
 const r=retainedHierarchy(points.slice(2),stored,from,to,60000,'1h')[0],expected=trendHierarchy(points,from,to,60000,'1h')['1h'][0];
 expect(r.count).toBe(3);expect(r.avg).toEqual(expected.avg);expect(r.max).toEqual(expected.max);expect(r.raw_status).toBe('partial_expired');expect(r.retained_count).toBe(2);expect(r.quality).toBe('partial');
});
it('does not invent precise clipped evidence from an expired five-minute bucket',()=>{
 const stored=trendHierarchy(points,from,to,60000,'5m')['5m'].filter(b=>b.count).map(bucket=>({bucket,metadata}));
 const r=retainedHierarchy([],stored,'2026-08-01T00:00:30Z',to,60000,'1h')[0];
 expect(r.count).toBe(1);expect(r.avg).toEqual({numerator:'2',denominator:'1'});expect(r.statistics_complete).toBe(false);expect(r.raw_status).toBe('boundary_unavailable');expect(r.quality).toBe('unknown');
});
it('independent trend retention is bounded without changing raw/type durations',()=>{
 expect(validateRetention({...DEFAULT_RETENTION,trendMs:365*86400000}).historyMs).toBe(DEFAULT_RETENTION.historyMs);
 for(const trendMs of [0,NaN,299999,3651*86400000])expect(()=>validateRetention({...DEFAULT_RETENTION,trendMs})).toThrow('RETENTION_INVALID');
});
it('a preservation read failure propagates before any receipt or deletion can be acknowledged',async()=>{
 const execute=vi.fn(),c={query:vi.fn().mockRejectedValue(new Error('aggregate unavailable')),execute} as any;
 await expect(preserveBeforePrune(c,['one'],new Date(),DEFAULT_RETENTION)).rejects.toThrow('aggregate unavailable');expect(execute).not.toHaveBeenCalled();
});
