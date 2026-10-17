import { beforeEach, describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, pin, resource, testResources } from '../policy/test-support.js';
import { MetricConfigurationService } from '../config/service.js';
import { BulkConfigurationService } from './service.js';
import type { BulkJob, BulkStore } from './model.js';
import { PolicyError } from '../policy/model.js';

export class MemoryBulkStore implements BulkStore {
  jobs = new Map<string, BulkJob>();
  cancellations = new Set<string>();
  locked = false;
  async create(job: BulkJob) {
    const old = [...this.jobs.values()].find(j => j.actor.userId === job.actor.userId && j.key === job.key);
    if (old) { if (old.digest !== job.digest) throw new PolicyError('BULK_IDEMPOTENCY_CONFLICT', 409); return structuredClone(old); }
    this.jobs.set(job.id, structuredClone(job)); return job;
  }
  async get(id: string) { return structuredClone(this.jobs.get(id) ?? null); }
  async save(job: BulkJob) { this.jobs.set(job.id, structuredClone(job)); }
  async list(owner?: number) { return structuredClone([...this.jobs.values()].filter(j => owner === undefined ? ['queued','running'].includes(j.state) : j.actor.userId === owner)); }
  async cancel(id: string) { this.cancellations.add(id); }
  async cancelled(id: string) { return this.cancellations.has(id); }
  async exclusive<T>(fn: () => Promise<T>) {
    if (this.locked) return null; this.locked = true;
    try { return await fn(); } finally { this.locked = false; }
  }
}

describe('bulk collection configuration', () => {
  let jobs: MemoryBulkStore, policies: MemoryPolicyStore, policy: PolicyService, bulk: BulkConfigurationService;
  let calls: number, denied: number[], fail: number[], hold: (() => Promise<void>) | undefined;
  beforeEach(() => {
    jobs = new MemoryBulkStore(); policies = new MemoryPolicyStore(); calls = 0; denied = []; fail = []; hold = undefined;
    const registry = createBuiltinRegistry();
    policy = new PolicyService(policies, registry, testResources);
    const config = new MetricConfigurationService(policy, registry, {
      reserve: async () => ({connection:{ping:async()=>{}},release:async()=>{}}), attempts:async()=>[],
    }, {resolve:async ref => ({resource:resource(ref.id),credential_ref:'credential:fixture',evidence:{counter:{bits:'64',start_at:'2026-09-01T00:00:00.000Z'}},
      resolve:async()=>({method:'sql',pool:{query:async()=> {
        calls++; if (hold) await hold();
        if (fail.includes(ref.id)) throw new Error('secret must never appear');
        return [[{Variable_name:'Uptime',Value:'100'},{Variable_name:'Queries',Value:'10000'}],[]];
      }}}),
    })}, {inventory:testResources.inventory,evidence:async()=>({asset_enabled:true,global_enabled:true,in_flight:false,
      formal:{state:'pending',last_observed_at:null,generation:null}})});
    bulk = new BulkConfigurationService(policy, config, jobs, async seed => ({...admin, ...seed,
      permissions: denied.length ? ['instance:manage','instance:view'] : ['*'],
      instanceScopes: denied.length ? Object.fromEntries([1,2,3,4].filter(id=>!denied.includes(id)).map(id=>[id,'admin' as const])) : {},
    }));
  });
  const input = (ids = [1,2]) => ({key:'test-bulk-key',resources:ids.map(id=>({type:'instance',id})),overrides:{interval_ms:{mode:'set',value:60000}}});
  async function confirmed(ids = [1,2]) {
    const preview = await bulk.preview(admin,input(ids));
    await bulk.confirm(admin,preview.id,preview.digest); return preview;
  }
  it('keeps unselected overrides and records per-object publication separately from formal readiness', async () => {
    await policy.changeBinding(admin,{type:'instance',id:1},{expected_revision:0,package:pin,overrides:{max_rows:{mode:'set',value:7},metrics:{'db.uptime_seconds@1.0.0':'enable'}}},true);
    const preview=await confirmed();
    expect(preview.items[0].before?.overrides.max_rows).toEqual({mode:'set',value:7});
    expect(preview.items[0].change?.overrides).toMatchObject({max_rows:{mode:'set',value:7}});
    await bulk.run(); const result=await bulk.get(admin,preview.id);
    expect(result.state).toBe('completed'); expect(result.items.map(i=>i.state),JSON.stringify(result.items.map(i=>({code:i.code,change:i.change})))).toEqual(['pending_takeover','pending_takeover']);
    expect(policies.bindings.get('instance:1')?.binding.overrides.max_rows).toEqual({mode:'set',value:7});
    expect(policies.logs.filter(l=>l.action==='binding.publish')).toHaveLength(3);
    expect(calls).toBe(2);
  });
  it('skips unknown compatibility, rejects duplicates and never forces a template from another type', async () => {
    const preview=await bulk.preview(admin,{...input([1]),resources:[{type:'server',id:1},{type:'instance',id:1}]});
    expect(preview.items[0].state).toBe('unsupported'); expect(preview.items[0].change).toBeNull();
    expect(calls).toBe(0);
    await expect(bulk.preview(admin,input([1,1]))).rejects.toThrow();
  });
  it('requires the exact preview confirmation and returns idempotent submissions', async () => {
    const p=await bulk.preview(admin,input());
    expect((await bulk.preview(admin,input())).id).toBe(p.id);
    await expect(bulk.preview(admin,{...input(),resources:[{type:'instance',id:3}]})).rejects.toThrow('BULK_IDEMPOTENCY_CONFLICT');
    await expect(bulk.confirm(admin,p.id,'incorrect')).rejects.toThrow('BULK_PREVIEW_CHANGED');
    await bulk.confirm(admin,p.id,p.digest); await bulk.confirm(admin,p.id,p.digest);
    await bulk.run(); await bulk.run(); expect(calls).toBe(2);
  });
  it('isolates revision conflicts and failed trials without reporting all succeeded', async () => {
    const p=await confirmed([1,2,3]);
    await policy.changeBinding(admin,{type:'instance',id:1},{expected_revision:0,package:pin},true);
    fail=[2]; await bulk.run();
    const result=await bulk.get(admin,p.id);
    expect(result.items.map(i=>i.state)).toEqual(['failed','failed','pending_takeover']);
    expect(result.items[0].code).toBe('POLICY_REVISION_CONFLICT');
    expect(policies.bindings.has('instance:2')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
    const retry=await bulk.retry(admin,p.id,{key:'retry-failures'});
    expect(retry.items.map(i=>i.resource.id)).toEqual([1,2]);
    expect(retry.state).toBe('draft'); expect(calls).toBe(2);
  });
  it('rechecks permissions after IO and cancels queued work without publishing late trial results', async () => {
    const p=await confirmed([1]);
    let release!:()=>void, entered!:()=>void;
    const started=new Promise<void>(r=>entered=r);
    hold=async()=>{entered();await new Promise<void>(r=>release=r);};
    const run=bulk.run(); await started;
    await bulk.cancel(admin,p.id); release(); await run;
    expect((await bulk.get(admin,p.id)).items[0].state).toBe('cancelled');
    expect(policies.bindings.size).toBe(0);
  });
  it('revoked grants block publication and prevent cached preview details being returned', async () => {
    const p=await confirmed([1]); denied=[1]; await bulk.run();
    const result=await bulk.get(admin,p.id);
    expect(result.items[0]).toMatchObject({state:'failed',code:'POLICY_FORBIDDEN',change:null,before:null});
    expect(policies.bindings.size).toBe(0); expect(calls).toBe(0);
  });
  it('recovers the publish/result crash window using the exact per-attempt audit identity', async () => {
    const p=await confirmed([1]);
    const job=(await jobs.get(p.id))!; const item=job.items[0];
    await policy.changeBinding({...admin,requestId:item.request_id},item.resource,item.change,true);
    item.state='running';job.state='running';await jobs.save(job);
    await bulk.run();
    expect((await bulk.get(admin,p.id)).items[0].state).toBe('pending_takeover');
    expect(calls).toBe(0);expect(policies.logs).toHaveLength(1);
  });
});
