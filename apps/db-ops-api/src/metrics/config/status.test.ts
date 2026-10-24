import { describe, expect, it } from 'vitest';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationReader, configurationStatus, type ConfigurationEvidence } from './status.js';
import { PolicyService } from '../policy/service.js';
import { admin, at, MemoryPolicyStore, pin, resource, testResources } from '../policy/test-support.js';

const ref = {type:'instance' as const,id:1};
const evidence: ConfigurationEvidence = {asset_enabled:true,global_enabled:true,in_flight:false,formal:{state:'pending',last_observed_at:null,generation:null}};
const setup = () => {
  const store = new MemoryPolicyStore(), registry = createConfigurationRegistry();
  const policy = new PolicyService(store,registry,testResources,()=>at);
  const reader = new MetricConfigurationReader(policy,registry,{inventory:testResources.inventory,evidence:async()=>evidence},async()=>[],()=>at);
  return {store,policy,registry,reader};
};
describe('independent resource configuration facts',()=>{
  it('has a truthful unbound result, but permission or store errors never turn into unbound',async()=>{
    const s=setup();
    expect(await s.reader.status(admin,ref)).toMatchObject({binding:{state:'unbound'},blockers:['UNBOUND']});
    await expect(s.reader.status({...admin,permissions:[]},ref)).rejects.toThrow('POLICY_FORBIDDEN');
    s.store.transaction=async()=>{throw new Error('database unavailable');};
    await expect(s.reader.status(admin,ref)).rejects.toThrow('database unavailable');
  });
  it('keeps an applied binding separate from formal visibility, unknown coverage and absent capacity',async()=>{
    const s=setup();await s.policy.changeBinding(admin,ref,{expected_revision:0,package:pin},true);
    s.store.bindings.get('instance:1')!.application={status:'applied',applied_revision:1,reported_at:at,error_code:null};
    const status=await s.reader.status(admin,ref);
    expect(status.binding).toMatchObject({state:'bound',application:'applied'});
    expect(status.formal_visibility).toMatchObject({state:'pending',source:'none'});
    expect(status.coverage.find(m=>m.metric.id==='mysql.tables.estimated_allocated_bytes')).toMatchObject({state:'not_covered'});
    expect(status.blockers).toContain('AWAITING_SAMPLE');
  });
  it('asset pause and global shutdown override an enabled policy without rewriting it',async()=>{
    const s=setup();await s.policy.changeBinding(admin,ref,{expected_revision:0,package:pin},true);
    const effective=await s.policy.effective(admin,ref);
    const paused=configurationStatus(ref,effective,[],{...evidence,asset_enabled:false},resource(),true,at);
    expect(paused.effective_enabled).toMatchObject({enabled:false,policy_enabled:true,source:'asset'});
    expect(paused.blockers).toContain('ASSET_COLLECTION_DISABLED');
    const global=configurationStatus(ref,effective,[],{...evidence,global_enabled:false},resource(),true,at);
    expect(global.effective_enabled).toMatchObject({enabled:false,asset_enabled:true,source:'global'});
    expect(effective.resolved.settings.enabled).toBe(true);
  });
  it('recommends only a real MySQL 9.6 compatible package and keeps unknown inventory unknown',async()=>{
    const s=setup();
    const inventory=resource();inventory.attributes['db.version'].value='9.6.0';
    const reader=new MetricConfigurationReader(s.policy,s.registry,{inventory:async()=>inventory,evidence:async()=>evidence},async()=>[],()=>at);
    const result=await reader.recommendations(admin,ref);
    expect(result.packages.filter(p=>p.recommended).map(p=>p.release.package.version)).toEqual(['2.0.0']);
    expect(result.packages.filter(p=>p.compatibility==='compatible').every(p=>p.release.package.applicability.some(a=>a.attribute==='db.engine'&&a.values.includes('mysql')))).toBe(true);
    delete inventory.attributes['db.version'];
    expect((await reader.recommendations(admin,ref)).packages.some(p=>p.recommended)).toBe(false);
  });
  it('reports an exact applied custom binding without repeating activation, while retaining formal gaps',async()=>{
    const s=setup();
    const custom=s.registry.list().find(r=>r.package.id==='mysql-custom-existing-scalars')!.package;
    const customPin={id:custom.id,version:custom.version,digest:custom.digest};
    await s.policy.changeBinding(admin,ref,{expected_revision:0,package:customPin},true);
    const legacy={kind:'custom_sql' as const,source_id:'connections',source_digest:'reviewed-source',state:'reviewed' as const,
      package:customPin,code:'CUSTOM_SQL_ACTIVATION_REQUIRED',actions:['POST resource activate']};
    const reader=new MetricConfigurationReader(s.policy,s.registry,{inventory:testResources.inventory,evidence:async()=>evidence,
      migration:async()=>[legacy]},async()=>[],()=>at);
    expect((await reader.status(admin,ref)).legacy_configuration![0].code).toBe('CUSTOM_SQL_ACTIVATION_REQUIRED');
    s.store.bindings.get('instance:1')!.application={status:'applied',applied_revision:1,reported_at:at,error_code:null};
    const applied=await reader.status(admin,ref);
    expect(applied.legacy_configuration![0]).toMatchObject({state:'reviewed',code:'CUSTOM_SQL_BINDING_APPLIED',package:customPin});
    expect(applied.formal_visibility).toMatchObject({state:'pending',freshness:'unknown'});
    expect(applied.blockers).toContain('AWAITING_SAMPLE');
    expect(legacy.code).toBe('CUSTOM_SQL_ACTIVATION_REQUIRED');
    // A new revision or pin never inherits the previous activation.
    s.store.bindings.get('instance:1')!.application.applied_revision=2;
    expect((await reader.status(admin,ref)).legacy_configuration![0].code).toBe('CUSTOM_SQL_ACTIVATION_REQUIRED');
    s.store.bindings.get('instance:1')!.application.applied_revision=1;
    legacy.package={...customPin,digest:'0'.repeat(64)};
    expect((await reader.status(admin,ref)).legacy_configuration![0].code).toBe('CUSTOM_SQL_ACTIVATION_REQUIRED');
    legacy.state='blocked' as any;
    legacy.package=customPin;
    expect((await reader.status(admin,ref)).legacy_configuration![0].state).toBe('blocked');
  });
});
