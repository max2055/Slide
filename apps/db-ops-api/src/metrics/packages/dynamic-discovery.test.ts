import { describe, it, expect } from 'vitest';
import { collectDynamic, dynamicReleases } from './dynamic-discovery.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { oracle1919Release, vendorLifecycleReleases } from '../database/catalog.js';
import { HostInterfaceDiscovery } from '../config/host-interface-counter.js';
import type { Transport } from './adapters.js';
import { InMemoryTemplateRepository } from '../templates/repository.js';
import { MetricTemplateService } from '../templates/service.js';
import type { ActorContext } from '../../auth/actor-context.js';

const uuid='12345678-1234-1234-1234-123456789abc';
const table=(name='test/a',id='42')=>({server_uuid:uuid,table_id:id,table_name:name,columns_count:4});
const sql=(batches:unknown[],serverUuid=(batches[0] as any)?.[0]?.server_uuid??uuid):Transport=>({method:'sql',pool:{query:async({sql})=>[sql.includes('INNODB_TABLES')?batches.shift():[{bound_database:'test',server_uuid:serverUuid}],[]]}});
const mysql=(batches:unknown[],max=100)=>collectDynamic('builtin:mysql.innodb-discovery.v1',sql(batches),{},5000,max);
const inventory=(name='eth0',index=2)=>`BOOT ${uuid}\nBTIME 1700000000\nNETNS net:[1234]\nIF lo 1\nIF ${name} ${index}\n`;
const counters=(name='eth0')=>`Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n ${name}: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n`;
const ssh=(text:string,truncated=false):Transport=>({method:'ssh',client:null as never,pool:{execCommands:async()=>[{stdout:text,stderr:'',exitCode:0,signal:null,truncated}]}});
const host=(text:string,truncated=false)=>collectDynamic('builtin:linux.interface-discovery.v1',ssh(text,truncated),{host_interfaces:new HostInterfaceDiscovery()},5000,100);
describe('MAX245 controlled dynamic protocol discovery',()=>{
  it.each([['linux-interface-discovery','interface'],['mysql-innodb-discovery','table_name'],['linux-filesystem-discovery','mount']])('rejects mutable display identity at publication for %s',async(packageId,display)=>{
    const registry=createConfigurationRegistry(),repo=new InMemoryTemplateRepository(),service=new MetricTemplateService(repo,registry);
    const actor={userId:7,username:'author',roles:[],permissions:['metric:view','metric:manage'],sessionVersion:1,instanceScopes:{},requestId:'dynamic'} as ActorContext;
    const t=await service.create(actor,{name:'identity check'}),release=registry.list().find(r=>r.package.id===packageId)!.package;
    const item=await service.selectMetric(actor,t.template_id,{package:{id:release.id,version:release.version,digest:release.digest},metric:release.collectors[0].mappings[0].metric});
    const draft=(await repo.getDraft(t.template_id))!;
    draft.aggregate.items=[{item_id:item.item.item_id,version:1}];draft.aggregate.triggers=[{rule_id:'rule',version:1,scope:`item:${item.item.item_id}`}];
    draft.aggregate.discovery_rules=[{rule_id:'discovery',name:'reject name',item_ids:[item.item.item_id],identity_dimensions:[display],timeout_ms:5000,max_instances:10,lost_after_ms:1000,retire_after_ms:3000}];
    const saved=await service.updateDraft(actor,t.template_id,{expected_draft_revision:draft.revision,aggregate:draft.aggregate});
    await expect(service.publish(actor,t.template_id,{expected_revision:0,expected_draft_revision:saved.revision})).rejects.toMatchObject({code:'TEMPLATE_MAPPING_MISSING'});
  });
  it('adds immutable registered packages without changing previous pins',()=>{const r=createConfigurationRegistry();for(const p of dynamicReleases())expect(r.get(p.package).package.digest).toBe(p.package.digest);});
  it('MAX245 publication keeps dynamic discovery and MAX237 vendor pins in the same registry',()=>{
    const registry=createConfigurationRegistry();
    for(const release of [...dynamicReleases(),oracle1919Release(),...vendorLifecycleReleases()]){
      expect(registry.get(release.package)).toEqual(release);
    }
  });
  it('retains dictionary identity on rename and changes on real table ID reuse',async()=>{
    const a=(await mysql([[table()],[table()]]))[0],renamed=(await mysql([[table('test/b')],[table('test/b')]]))[0],newTable=(await mysql([[table('test/a','43')],[table('test/a','43')]]))[0];
    expect(a.dimensions.table_epoch).toBe(renamed.dimensions.table_epoch);expect(newTable.dimensions.table_epoch).not.toBe(a.dimensions.table_epoch);
  });
  it('separates server reincarnation from dictionary ID reuse',async()=>{const a=(await mysql([[table()],[table()]]))[0];const b={...table(),server_uuid:'22345678-1234-1234-1234-123456789abc'};expect((await mysql([[b],[b]]))[0].dimensions.table_epoch).not.toBe(a.dimensions.table_epoch);});
  it('rejects changing inventory, duplicate identity and missing fields',async()=>{
    await expect(mysql([[table()],[]])).rejects.toThrow();await expect(mysql([[table(),table()]])).rejects.toThrow();await expect(mysql([[{...table(),server_uuid:undefined}]])).rejects.toThrow();
  });
  it('never accepts row overflow as complete and accepts proven empty',async()=>{await expect(mysql([[table()],[]],0)).rejects.toThrow();expect(await mysql([[],[]])).toEqual([]);});
  it('rejects cross-schema rows and unprovable database name encodings even for an empty inventory',async()=>{
    await expect(mysql([[table('Test/foreign')],[table('Test/foreign')]])).rejects.toThrow();
    for(const bound_database of ['test-db','mysql',undefined]) {
      const t:Transport={method:'sql',pool:{query:async()=>[[{bound_database,server_uuid:uuid}],[]]}};
      await expect(collectDynamic('builtin:mysql.innodb-discovery.v1',t,{},5000,100)).rejects.toThrow();
    }
  });
  it('does not retry timeout or permission rejection',async()=>{let calls=0;const t:Transport={method:'sql',pool:{query:async()=>{calls++;throw {code:'ER_ACCESS_DENIED_ERROR'};}}};await expect(collectDynamic('builtin:mysql.innodb-discovery.v1',t,{},5000,100)).rejects.toMatchObject({code:'permission_denied'});expect(calls).toBe(1);});
  it('keeps kernel identity across interface rename and process restart',async()=>{const a=(await host(inventory()+'STATS\n'+counters()+'END\n'+inventory()))[0];const b=(await host(inventory('uplink')+'STATS\n'+counters('uplink')+'END\n'+inventory('uplink')))[0];expect(a.dimensions.interface_epoch).toBe(b.dimensions.interface_epoch);expect(b.display_name).toBe('uplink');});
  it('rejects missing proc rows, changed inventory and truncation',async()=>{await expect(host(inventory()+'STATS\n'+counters('other')+'END\n'+inventory())).rejects.toThrow();await expect(host(inventory()+'STATS\n'+counters()+'END\n'+inventory('other'))).rejects.toThrow();await expect(host(inventory()+'STATS\n'+counters()+'END\n'+inventory(),true)).rejects.toThrow();});
  it('treats kernel lifetime reuse as a new identity',async()=>{const a=(await host(inventory()+'STATS\n'+counters()+'END\n'+inventory()))[0];const b=(await host(inventory('eth0',3)+'STATS\n'+counters()+'END\n'+inventory('eth0',3)))[0];expect(a.dimensions.interface_epoch).not.toBe(b.dimensions.interface_epoch);});
});
