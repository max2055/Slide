import { expect, it } from 'vitest';
import { MetricConfigurationService } from './service.js';
import { PolicyService } from '../policy/service.js';
import { createConfigurationRegistry } from './registry.js';
import { admin, MemoryPolicyStore, pin, testResources, at, resource } from '../policy/test-support.js';

it('cannot publish a configuration whose group changed during remote trial', async () => {
  const store=new MemoryPolicyStore(),registry=createConfigurationRegistry();
  const policy=new PolicyService(store,registry,testResources,()=>at);
  await policy.changeGroup(admin,'group',{expected_revision:0,overrides:{}},true);
  const service=new MetricConfigurationService(policy,registry,{reserve:async()=>({connection:{ping:async()=>undefined},release:async()=>undefined}),attempts:async()=>[]},{resolve:async()=>({resource:resource(),credential_ref:'credential:fixture',evidence:{},resolve:async()=>({method:'sql',pool:{query:async()=>{
    await policy.changeGroup(admin,'group',{expected_revision:1,overrides:{interval_ms:{mode:'set',value:30000}}},true);
    return [[{Variable_name:'Uptime',Value:'10'},{Variable_name:'Queries',Value:'1'}],[]];
  }}})})});
  await expect(service.activate(admin,{type:'instance',id:1},{expected_revision:0,package:pin,group_id:'group'})).rejects.toThrow('POLICY_REVISION_CONFLICT');
  expect(store.bindings.size).toBe(0);
});
