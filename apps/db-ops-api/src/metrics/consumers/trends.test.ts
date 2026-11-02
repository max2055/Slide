import { expect, it } from 'vitest';
import { identify, sample } from '../../contracts/metrics/fixtures.js';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { trendHierarchy } from './trends.js';
const point=(at:string,value:string):NormalizedObservation=>identify({...sample('db.uptime_seconds'),observed_at:at,value:{encoding:'uint64',value}});
it('keeps exact peaks, count-weighted average and half-open UTC boundaries at every tier',()=>{
  const values=[point('2026-01-01T00:00:00Z','9007199254740993'),point('2026-01-01T00:04:00Z','1'),point('2026-01-01T00:05:00Z','2'),point('2026-01-01T01:00:00Z','999')];
  const r=trendHierarchy(values,'2026-01-01T08:00:00+08:00','2026-01-01T09:00:00+08:00',60000);
  expect(r['5m'][0].count).toBe(2);expect(r['1h'][0].count).toBe(3);
  expect(r['1d'][0].max?.numerator).toBe('9007199254740993');
  expect(r['1h'][0].avg).toEqual({numerator:'3002399751580332',denominator:'1'});
});
it('keeps empty, invalid and non-numeric samples visible without numeric zero filling',()=>{
  const p=point('2026-01-01T00:03:00Z','9');p.value=null;
  const s=point('2026-01-01T00:04:00Z','9');s.value={encoding:'histogram',count:'2',sum:3,buckets:[{upper_bound:'+Inf',count:'2'}]};
  const r=trendHierarchy([p,s],'2026-01-01T00:02:00Z','2026-01-01T00:12:00Z',60000)['5m'];
  expect(r[0]).toMatchObject({count:2,invalid_count:1,non_numeric_count:1,avg:null,quality:'partial'});
  expect(r[1]).toMatchObject({count:0,min:null,max:null,quality:'unknown'});expect(r[0].from).toBe('2026-01-01T00:02:00.000Z');
});
it.each(['5m','1h','1d'] as const)('sparse intermediate tiers preserve the complete %s result',tier=>{
  const rows=[point('2026-01-01T00:03:00Z','1'),point('2026-01-02T02:08:00Z','9')];
  const args=[rows,'2026-01-01T00:02:00Z','2026-01-03T00:00:00Z',60000] as const;
  expect(trendHierarchy(...args,tier)[tier]).toEqual(trendHierarchy(...args)[tier]);
});
