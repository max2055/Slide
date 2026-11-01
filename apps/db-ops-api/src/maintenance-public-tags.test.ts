import { describe, it, expect } from 'vitest';
import { publicMaintenanceTags } from './maintenance-public-tags.js';
describe('public maintenance tags',()=>{
 it('redacts historical full scope without mutating internal audit evidence',()=>{
  const original={episode_id:'episode',maintenance:{state:'active',at:'2026-11-01T00:00:00Z',intervals:[{resources:[{type:'instance',id:1},{type:'instance',id:2}],reason:'private'}]}};
  expect(publicMaintenanceTags(JSON.stringify(original))).toEqual({episode_id:'episode',maintenance:{state:'active',at:'2026-11-01T00:00:00Z'}});
  expect(original.maintenance.intervals[0].resources).toHaveLength(2);
 });
 it('keeps unknown fail-closed and unrelated tags',()=>{
  expect(publicMaintenanceTags({maintenance:{state:'unknown',at:'now'},rule_id:7})).toEqual({maintenance:{state:'unknown',at:'now'},rule_id:7});
  expect(publicMaintenanceTags(null)).toBeNull();
  expect(publicMaintenanceTags('{broken')).toBeNull();
 });
});
