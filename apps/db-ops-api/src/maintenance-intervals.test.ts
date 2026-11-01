import {describe,it,expect} from 'vitest';
import {MaintenanceInput,WeeklyInput,effectiveIntervals,intervalContains,type Interval} from './maintenance-intervals.js';
const ref={type:'instance' as const,id:7};
const value={name:'维护',reason:'升级',resources:[ref],timezone:'Asia/Shanghai',starts_at:'2026-11-01T00:00:00Z',ends_at:'2026-11-01T02:00:00Z'};
const first:Interval={...value,id:'window',revision:1,cancelled_at:null,changed_at:'2026-11-01T00:00:00Z',actor_id:1};
describe('MAX244 immutable maintenance interval contract',()=>{
 it('rejects invalid timezone, duplicate resources, empty scope and reversed deadline',()=>{
  for(const v of [{...value,timezone:'bad'},{...value,resources:[ref,ref]},{...value,resources:[]},{...value,ends_at:value.starts_at}])expect(MaintenanceInput.safeParse(v).success).toBe(false);
 });
 it('validates legacy periodic edits without changing recurrence semantics',()=>{
  const weekly={name:'周期',reason:'',resources:[ref],timezone:'Asia/Shanghai',day_of_week:'2,4',start_time:'23:00',end_time:'01:00'};
  expect(WeeklyInput.parse(weekly)).toEqual(weekly);
  for(const changed of [{timezone:'bad'},{day_of_week:'8'},{start_time:'25:00'},{end_time:'23:00'},{resources:[{type:'server',id:7}]},{resources:[]}])expect(WeeklyInput.safeParse({...weekly,...changed}).success).toBe(false);
 });
 it('does not rewrite the original resource or reason after edits or cancellation',()=>{
  const second={...first,revision:2,reason:'延期',resources:[{type:'server' as const,id:8}],changed_at:'2026-11-01T01:00:00Z'};
  const cancelled={...second,revision:3,cancelled_at:'2026-11-01T01:30:00Z',changed_at:'2026-11-01T01:30:00Z'};
  const ranges=effectiveIntervals([first,second,cancelled]);
  expect(ranges[0]).toMatchObject({reason:'升级',resources:[ref],effective_to:'2026-11-01T01:00:00.000Z'});
  expect(ranges[1].effective_to).toBe('2026-11-01T01:30:00.000Z');
  expect(ranges[2].effective_from).toBe(ranges[2].effective_to);
 });
 it('uses half-open boundaries and preserves overlapping windows independently',()=>{
  expect(intervalContains(first,ref,Date.parse(first.starts_at))).toBe(true);
  expect(intervalContains(first,ref,Date.parse(first.ends_at))).toBe(false);
  expect(intervalContains({...first,id:'overlap'},ref,Date.parse(first.starts_at))).toBe(true);
  expect(intervalContains(first,{type:'server',id:7},Date.parse(first.starts_at))).toBe(false);
 });
});
