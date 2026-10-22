import {expect,it} from 'vitest';
import {collectFixed,type Transport} from '../packages/adapters.js';
import {collectDatabase,bindDatabaseDriver} from '../database/collector.js';
import {databaseReads,implementationId} from '../database/catalog.js';
import {runPackage} from '../packages/runner.js';
import {builtinReleases,createBuiltinRegistry} from '../packages/builtins.js';
const net='Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n';
const transport:Transport={method:'ssh',client:undefined as never,pool:{execCommands:async()=>[{stdout:net,stderr:'',exitCode:0,signal:null,truncated:false}]}};
it.each(['builtin:linux.network.v1','builtin:linux.network-diagnostics.v1'])('reports the precise missing lifecycle for %s after parsing valid counters',async id=>{
 await expect(collectFixed(id,transport,{},1000,100)).rejects.toMatchObject({code:'parse_error',evidenceCode:'HOST_INTERFACE_LIFECYCLE_UNAVAILABLE'});
});
it('does not treat ordinary MySQL status reads as trusted counter snapshots',async()=>{
 const read=databaseReads.find(r=>r.engine==='mysql'&&r.name==='transactions')!;
 const t=bindDatabaseDriver(async()=>({rows:[{Variable_name:'Com_commit',Value:'123'},{Variable_name:'Com_rollback',Value:'5'}]}));
 await expect(collectDatabase(implementationId(read),t,{},1000)).rejects.toMatchObject({code:'parse_error',evidenceCode:'MYSQL_COUNTER_LIFECYCLE_UNAVAILABLE'});
});
it('preserves unknown capability with a precise production diagnostic, rather than unsupported or an invented epoch',async()=>{
 const release=builtinReleases().find(r=>r.package.id==='linux-host')!;
 const result=await runPackage(createBuiltinRegistry(),{package:release.package,credential_ref:'credential:fixture',overrides:{}},{resource:{type:'server',id:'3',attributes:{'os.family':{value:'linux',source:'fixture',observed_at:new Date().toISOString()}}},binding_id:'server:3',attempt_id:'fixture',config_revision:3,observed_at:new Date().toISOString(),collector_ids:release.package.collectors.filter(c=>c.implementation_ref==='builtin:linux.network.v1').map(c=>c.id),evidence:{},resolve:async()=>transport});
 expect(result.attempts[0].status).toBe('failed');expect(result.observations).toHaveLength(0);
 expect(result.capabilities[0]).toMatchObject({status:'unknown',basis:expect.arrayContaining([{kind:'method',evidence:'HOST_INTERFACE_LIFECYCLE_UNAVAILABLE'}])});
});
