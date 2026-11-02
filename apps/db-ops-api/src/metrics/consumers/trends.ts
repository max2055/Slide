import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { add, compare, decode, divide, rational, type Rational } from '../arithmetic.js';

export const TREND_TIERS = { '5m': 300000, '1h': 3600000, '1d': 86400000 } as const;
type Exact = { numerator: string; denominator: string };
const exact = (r: Rational): Exact => ({ numerator: r.numerator.toString(), denominator: r.denominator.toString() });
const unpack = (r: Exact) => rational(BigInt(r.numerator), BigInt(r.denominator));
export interface TrendBucket {
  from: string; to: string; count: number; numeric_count: number; invalid_count: number; non_numeric_count: number; estimated_count:number;
  sum: Exact; min: Exact | null; max: Exact | null; avg: Exact | null;
  first_at: string | null; last_at: string | null; max_gap_ms: number;
  coverage: number; quality: 'good' | 'partial' | 'unknown';
}
const numeric = (o: NormalizedObservation) => o.value !== null && ['float64','uint64','int64'].includes(o.value.encoding);
function empty(from: number, to: number): TrendBucket {
  return { from:new Date(from).toISOString(),to:new Date(to).toISOString(),count:0,numeric_count:0,invalid_count:0,non_numeric_count:0,estimated_count:0,
    sum:exact(rational(0n)),min:null,max:null,avg:null,first_at:null,last_at:null,max_gap_ms:0,coverage:0,quality:'unknown' };
}
/** Parent buckets merge exact sufficient statistics, never unweighted averages of averages. */
export function mergeTrend(a: TrendBucket, b: TrendBucket): TrendBucket {
  const out = { ...a, count:a.count+b.count,numeric_count:a.numeric_count+b.numeric_count,
    invalid_count:a.invalid_count+b.invalid_count,non_numeric_count:a.non_numeric_count+b.non_numeric_count,
    estimated_count:a.estimated_count+b.estimated_count,
    sum:exact(add(unpack(a.sum),unpack(b.sum))),first_at:a.first_at ?? b.first_at,last_at:b.last_at ?? a.last_at,
    max_gap_ms:Math.max(a.max_gap_ms,b.max_gap_ms,a.last_at && b.first_at ? Date.parse(b.first_at)-Date.parse(a.last_at):0) };
  for (const key of ['min','max'] as const) out[key] = !a[key] ? b[key] : !b[key] ? a[key]
    : (compare(unpack(a[key]!),unpack(b[key]!)) * (key==='min'?1:-1) <= 0 ? a[key] : b[key]);
  out.avg = out.numeric_count ? exact(divide(unpack(out.sum),rational(BigInt(out.numeric_count)))) : null;
  return out;
}
/** UTC epoch-aligned half-open buckets. The first/last bucket is clipped to the evidence window. */
export function trendHierarchy(points: NormalizedObservation[], from: string, to: string, intervalMs: number, target?:keyof typeof TREND_TIERS) {
  const start=Date.parse(from),end=Date.parse(to);
  const ordered=points.filter(p=>Date.parse(p.observed_at)>=start && Date.parse(p.observed_at)<end)
    .sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at)||a.id.localeCompare(b.id));
  let lower: TrendBucket[] = [];
  const result = {} as Record<keyof typeof TREND_TIERS,TrendBucket[]>;
  for (const [tier,ms] of Object.entries(TREND_TIERS)) {
    if(target && ms>TREND_TIERS[target])break;
    const buckets: TrendBucket[]=[];
    let cursor=0;
    for(let epoch=Math.floor(start/ms)*ms;epoch<end;epoch+=ms) {
      const a=Math.max(epoch,start),b=Math.min(epoch+ms,end);let bucket=empty(a,b);
      if(tier==='5m') {
        while(cursor<ordered.length && Date.parse(ordered[cursor].observed_at)<b) {
          const p=ordered[cursor++],valid=p.quality.status==='good' && p.accuracy!=='unknown' && p.value!==null;
          const n=valid && numeric(p) ? decode(p.value!) : null;
          const point={...empty(a,b),count:1,numeric_count:n?1:0,invalid_count:valid?0:1,
            estimated_count:p.accuracy==='estimated'?1:0,
            non_numeric_count:valid && !numeric(p)?1:0,sum:exact(n??rational(0n)),min:n?exact(n):null,max:n?exact(n):null,
            first_at:p.observed_at,last_at:p.observed_at};
          bucket=mergeTrend(bucket,point);
        }
      } else {
        while(cursor<lower.length && Date.parse(lower[cursor].from)<b) bucket=mergeTrend(bucket,lower[cursor++]);
      }
      const edges=bucket.first_at && bucket.last_at ? Math.max(Date.parse(bucket.first_at)-a,b-Date.parse(bucket.last_at)):b-a;
      bucket.max_gap_ms=Math.max(bucket.max_gap_ms,edges);
      // Coverage is explicitly a cadence assumption, not proof of contiguous evidence.
      bucket.coverage=Math.min(1,bucket.count/Math.max(1,Math.ceil((b-a)/intervalMs)));
      bucket.quality=!bucket.count?'unknown':bucket.invalid_count || bucket.estimated_count || bucket.max_gap_ms>intervalMs*1.25 || bucket.coverage<1?'partial':'good';
      // Intermediate tiers need only occupied sufficient statistics. The selected
      // tier still emits every empty bucket, preserving gaps without a year's
      // worth of transient 5-minute objects for a daily query.
      if(target && tier!==target && !bucket.count){
        const next=tier==='5m'?ordered[cursor]?.observed_at:lower[cursor]?.from;
        if(!next)break;
        epoch=Math.max(epoch,Math.floor(Date.parse(next)/ms)*ms-ms);continue;
      }
      buckets.push(bucket);
    }
    result[tier as keyof typeof TREND_TIERS]=buckets;lower=buckets;
  }
  return result;
}
