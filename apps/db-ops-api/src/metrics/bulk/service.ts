import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { ActorAuthenticationError } from '../../auth/actor-context.js';
import type { MetricConfigurationService } from '../config/service.js';
import { candidateFingerprint, type PolicyService } from '../policy/service.js';
import { PolicyError, refKey, rule, type Ref, type Binding, type Overrides } from '../policy/model.js';
import { stable } from '../packages/model.js';
import { BulkPreviewSchema, BulkRetrySchema, type ActorSeed, type BulkInput, type BulkItem, type BulkJob, type BulkStore } from './model.js';

const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
const seed = (a: ActorContext): ActorSeed => ({userId:a.userId,sessionVersion:a.sessionVersion,
  ...(a.resourceBoundary ? {resourceBoundary:a.resourceBoundary} : {}), ...(a.principalKind ? {principalKind:a.principalKind} : {})});
export const bulkError = (e: unknown): string => e instanceof PolicyError ? e.code : e instanceof ActorAuthenticationError ? 'POLICY_FORBIDDEN'
  : e instanceof z.ZodError ? 'POLICY_INPUT_INVALID' : 'BULK_OPERATION_FAILED';
function mergeOverrides(before: Overrides, patch: Overrides = {}): Overrides {
  return {...before,...patch,...(patch.metrics ? {metrics:{...before.metrics,...patch.metrics}} : {})};
}
async function bounded<T,R>(items:T[],fn:(value:T,index:number)=>Promise<R>):Promise<R[]> {
  const results:R[]=[];let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{while(cursor<items.length){const i=cursor++;results[i]=await fn(items[i],i);}}));
  return results;
}
export class BulkConfigurationService {
  private stopping = new AbortController();
  constructor(private policy: PolicyService, private config: MetricConfigurationService, private store: BulkStore,
    private revalidate: (seed: ActorSeed, requestId: string) => Promise<ActorContext>, private clock=()=>new Date().toISOString()) {}
  stop() { this.stopping.abort(); }
  private async actor(job:BulkJob, requestId:string) { return this.revalidate(job.actor,requestId); }
  private async owned(actor:ActorContext,id:string) {
    const job=await this.store.get(id);rule(job && job.actor.userId===actor.userId,'BULK_NOT_FOUND',404);
    // Do not allow a widened interactive identity to resume a delegated job.
    rule(stable(job.actor.resourceBoundary??null)===stable(actor.resourceBoundary??null),'POLICY_FORBIDDEN',403);
    return job;
  }
  private async item(actor:ActorContext,ref:Ref,input:BulkInput,id:string,index:number):Promise<BulkItem> {
    const item:BulkItem={resource:ref,state:'eligible',code:null,group:ref.type,checks:[],choices:[],before:null,change:null,
      settings:null,coverage:[],missing:[],cost:null,retained:[],changed:[],revision:null,status:null,candidate:null,request_id:`bulk:${id}:${index}`};
    try {
      await this.policy.assertAccess(actor,ref,true);
      const recommendations=await this.config.recommendations(actor,ref);
      try {item.before=(await this.policy.binding(actor,ref)).binding;}
      catch(e){if(!(e instanceof PolicyError && e.code==='POLICY_NOT_FOUND'))throw e;}
      item.choices=recommendations.packages.map(p=>({package:((({id,version,digest})=>({id,version,digest}))(p.release.package)),
        compatibility:p.compatibility,recommended:p.recommended,metrics:p.coverage.map(m=>m.id),missing:p.missing_core_metrics}));
      const specified=input.packages?.find(g=>g.resources.some(r=>refKey(r)===refKey(ref)))?.package;
      // Never silently switch an existing package ID; that belongs to the single-resource contract.
      const choice=specified ? item.choices.find(p=>stable(p.package)===stable(specified))
        : item.before ? item.choices.find(p=>stable(p.package)===stable(item.before!.package))
        : item.choices.find(p=>p.recommended && p.compatibility==='compatible');
      const checks=recommendations.packages.find(p=>p.release.package.digest===choice?.package.digest)?.checks??recommendations.packages[0]?.checks??[];
      item.checks=checks.map(({attribute,value,status})=>({attribute,value,status}));
      item.group=`${ref.type} · ${checks.map(c=>`${c.attribute}=${c.value??'未知'} (${c.status})`).join(' / ')||'能力未知'}`;
      if(!choice||choice.compatibility!=='compatible') {
        item.state='unsupported';item.code=choice?.compatibility==='unknown'?'BULK_CAPABILITY_UNKNOWN':'BULK_NO_COMPATIBLE_PACKAGE';return item;
      }
      const overrides=mergeOverrides(item.before?.overrides??{},input.overrides);
      item.change={expected_revision:item.before?.revision??0,package:choice.package,overrides};
      const preview=await this.policy.changeBinding(actor,ref,item.change,false);
      const next=preview.resources[0];
      item.candidate=candidateFingerprint(next);item.settings=next.resolved.settings;
      item.coverage=choice.metrics;item.missing=choice.missing;
      item.cost={before:preview.requests_per_hour_before,after:preview.requests_per_hour_after,unit:'logical_reads_per_hour',estimate:true};
      item.retained=Object.keys(item.before?.overrides??{}).filter(k=>!Object.hasOwn(input.overrides??{},k));
      item.changed=[...(!item.before||stable(item.before.package)!==stable(choice.package)?['package']:[]),...Object.keys(input.overrides??{})];
      return item;
    } catch(e){item.state='failed';item.code=bulkError(e);if(item.code==='POLICY_FORBIDDEN'||item.code==='POLICY_RESOURCE_NOT_FOUND')return this.redact(item);return item;}
  }
  private redact(item:BulkItem):BulkItem {return {...item,state:'failed',code:'POLICY_FORBIDDEN',group:item.resource.type,checks:[],choices:[],before:null,change:null,
    settings:null,coverage:[],missing:[],cost:null,retained:[],changed:[],revision:null,status:null,candidate:null};}
  async preview(actor:ActorContext,raw:unknown,retryOf:string|null=null) {
    const input=BulkPreviewSchema.parse(raw);
    const assigned=input.packages?.flatMap(g=>g.resources.map(refKey))??[];
    rule(new Set(assigned).size===assigned.length && assigned.every(k=>input.resources.some(r=>refKey(r)===k)),'POLICY_INPUT_INVALID');
    actor=await this.revalidate(seed(actor),actor.requestId);
    const id=randomUUID(),at=this.clock();
    const items=await bounded(input.resources,(ref,index)=>this.item(actor,ref,input,id,index));
    const job:BulkJob={id,key:input.key,input_digest:hash(input),digest:hash({input,items:items.map(({request_id,...rest})=>rest)}),actor:seed(actor),state:'draft',
      created_at:at,updated_at:at,expires_at:new Date(Date.parse(at)+30*60000).toISOString(),input,items,retry_of:retryOf};
    const saved=await this.store.create(job);
    rule(saved.input_digest===job.input_digest,'BULK_IDEMPOTENCY_CONFLICT',409);
    return this.view(actor,saved);
  }
  async confirm(actor:ActorContext,id:string,digest:string) {
    return this.store.exclusive(async()=>{
      const job=await this.owned(actor,id);
      rule(job.digest===digest,'BULK_PREVIEW_CHANGED',409);
      if(job.state!=='draft')return this.view(actor,job);
      rule(Date.parse(job.expires_at)>Date.parse(this.clock()),'BULK_PREVIEW_EXPIRED',409);
      rule(!await this.store.cancelled(id),'BULK_CANCELLED',409);
      actor=await this.actor(job,actor.requestId);
      for(const item of job.items.filter(i=>i.state==='eligible'))await this.policy.assertAccess(actor,item.resource,true);
      job.items=job.items.map(i=>i.state==='eligible'?{...i,state:'queued'}:i);
      job.state=job.items.some(i=>i.state==='queued')?'queued':'completed';job.updated_at=this.clock();await this.store.save(job);
      return this.view(actor,job);
    },`control:${id}`).then(value=>{rule(value,'BULK_BUSY',409);return value;});
  }
  async cancel(actor:ActorContext,id:string){const job=await this.owned(actor,id);await this.store.cancel(id);return {id:job.id,cancel_requested:true};}
  async retry(actor:ActorContext,id:string,raw:unknown) {
    const {key}=BulkRetrySchema.parse(raw),job=await this.owned(actor,id);
    rule(['completed','cancelled'].includes(job.state),'BULK_NOT_FINISHED',409);
    const resources=job.items.filter(i=>i.state==='failed').map(i=>i.resource);
    rule(resources.length,'BULK_NO_FAILURES',409);
    return this.preview(actor,{...job.input,key,resources,packages:job.input.packages?.map(g=>({...g,resources:g.resources.filter(r=>resources.some(f=>refKey(f)===refKey(r)))})).filter(g=>g.resources.length)},id);
  }
  async list(actor:ActorContext){return {jobs:await bounded(await this.store.list(actor.userId),async job=>({id:job.id,state:job.state,created_at:job.created_at,count:job.items.length}))};}
  async get(actor:ActorContext,id:string){return this.view(actor,await this.owned(actor,id));}
  private async view(actor:ActorContext,job:BulkJob) {
    actor=await this.revalidate(seed(actor),actor.requestId);
    const items=await bounded(job.items,async item=>{
      try{await this.policy.assertAccess(actor,item.resource,true);}catch{item=this.redact(item);}
      const {candidate:_candidate,request_id:_request,...visible}=item;return visible;
    });
    return {id:job.id,digest:job.digest,state:job.state,created_at:job.created_at,updated_at:job.updated_at,expires_at:job.expires_at,
      cancel_requested:await this.store.cancelled(job.id),items,retry_of:job.retry_of};
  }
  async run() {
    if(this.stopping.signal.aborted)return;
    return this.store.exclusive(async()=>{
      const job=(await this.store.list())[0];if(!job)return;
      let tail:Promise<void>=Promise.resolve();
      const persist=()=>{const snapshot=structuredClone(job);tail=tail.then(()=>this.store.save(snapshot));return tail;};
      job.state='running';await persist();
      await bounded(job.items,async item=>{
        if(!['queued','running'].includes(item.state))return;
        const check=async()=>{
          await this.store.fence?.();
          rule(!this.stopping.signal.aborted && !await this.store.cancelled(job.id),'BULK_CANCELLED',409);
          const current=await this.actor(job,item.request_id);await this.policy.assertAccess(current,item.resource,true);return current;
        };
        try {
          // Reconcile before cancellation: publication may have committed just before process death/cancel.
          const actor=await this.actor(job,item.request_id);await this.policy.assertAccess(actor,item.resource,true);
          const published=(await this.policy.audits(actor,item.resource)).find(a=>a.request_id===item.request_id && a.action==='binding.publish');
          if(published){item.revision=published.revision;item.status=await this.config.status(actor,item.resource);}
          else {
            await check();item.state='running';await persist();
            const result=await this.config.activate(actor,item.resource,item.change,{candidate:item.candidate!,signal:this.stopping.signal,check});
            item.revision=result.resources[0].binding.revision;item.status=result.status;
          }
          item.state=item.status.binding.published_revision===item.revision && item.status.binding.application==='applied'
            && item.status.formal_visibility.state==='available' && !item.status.blockers.length?'succeeded':'pending_takeover';item.code=null;
        } catch(e) {
          const cancelled=e instanceof PolicyError && e.code==='BULK_CANCELLED'||this.stopping.signal.aborted;
          // Shutdown returns uncommitted items to the queue; explicit cancellation is terminal.
          item.state=cancelled?this.stopping.signal.aborted?'queued':'cancelled':'failed';item.code=cancelled?'BULK_CANCELLED':bulkError(e);
        }
        job.updated_at=this.clock();await persist();
      });
      job.state=job.items.some(i=>['queued','running'].includes(i.state))?'queued':await this.store.cancelled(job.id)?'cancelled':'completed';
      job.updated_at=this.clock();await persist();
    });
  }
}
