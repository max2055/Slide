import { describe, expect, it } from 'vitest';
import { collectDatabase } from './collector.js';
import { diagnosticReads } from './diagnostics.js';
import { implementationId } from './catalog.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { resolvePolicy } from '../policy/resolver.js';

const read = diagnosticReads.find(r => r.name === 'diagnostic_ratios')!;
const collect = (rows: unknown) => collectDatabase(implementationId(read), {method:'sql',pool:{query:async()=>[rows,[]]}}, {}, 1000);
describe('diagnostic definitions and exact scalar decoding', () => {
  it('preserves SQL NULL ratios instead of healthy defaults', async () => {
    const [row] = await collect([{buffer_hit:null,table_hit:'99.125',key_usage:null}]);
    expect(row.fields).toEqual({buffer_hit:null,table_hit:{encoding:'float64',value:99.125},key_usage:null});
  });
  it('isolates malformed scalars and refuses infinity, booleans and empty strings', async () => {
    for (const bad of [Infinity,NaN,true,'','Infinity','1e999']) {
      const [row]=await collect([{buffer_hit:bad,table_hit:'50',key_usage:0}]);
      expect(row.fields.buffer_hit).toBeUndefined();
      expect(row.fields.table_hit).toEqual({encoding:'float64',value:50});
      expect(row.fields.key_usage).toEqual({encoding:'float64',value:0});
    }
  });
  it('retains uint64 precision while refusing already rounded driver Numbers', async () => {
    const gauge=diagnosticReads.find(r=>r.name==='diagnostic_gauges')!;
    const [row]=await collectDatabase(implementationId(gauge),{method:'sql',pool:{query:async()=>[[{Variable_name:'Threads_running',Value:'9007199254740993'},{Variable_name:'Open_files',Value:9007199254740992}],[]]}},{},1000);
    expect(row.fields.Threads_running).toEqual({encoding:'uint64',value:'9007199254740993'});
    expect(row.fields.Open_files).toBeUndefined();
  });
  it('every recommended package resolves within its default series budget', () => {
    const registry=createConfigurationRegistry(),at=new Date().toISOString();
    for(const release of registry.list()){
      const p=release.package;
      const attributes=Object.fromEntries(p.applicability.map(a=>[a.attribute,{value:a.values[0],source:'fixture',observed_at:at}]));
      const result=resolvePolicy(registry,{resource:{type:p.resource_type,id:1},package:{id:p.id,version:p.version,digest:p.digest},revision:1,group_id:null,overrides:{}},null,{type:p.resource_type,id:'1',attributes},[],at);
      expect(result.impact.estimated_series_upper_bound).toBeLessThanOrEqual(result.settings.max_series_per_resource);
    }
  });
});
