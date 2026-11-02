import {randomUUID,createHash} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import type {PoolConnection} from 'mysql2/promise';
import type {ActorContext} from '../auth/actor-context.js';
import {evidenceHash} from '../analysis/analysis-evidence.js';
import {MysqlRelationSession,type StoredRelation} from '../operations/relations/store.js';
import type {MetricConsumerService} from '../metrics/consumers/service.js';
import {verifyTriggerSnapshot} from '../metrics/triggers/compile.js';
import {evaluateTriggerRule} from '../metrics/triggers/evaluate.js';
import {InvestigationEvidenceStore,prepareEvidence} from './evidence-store.js';
import {PolicyError} from '../metrics/policy/model.js';
import {InvestigationScopeCommand,InvestigationRetestCommand,type ScopeCommand,type RetestCommand} from './workflow-contracts.js';
import {InvestigationObservationDatabase,observationRows,decode,invalidObservation,absentObservation,appendObservation,instant} from './observation-db.js';
import {InvestigationStoreError,type AdmissionInvestigation} from './store.js';
import type {InvestigationEntryContext} from './entry-contracts.js';

const keyOf=(ref:{type:string;id:number})=>`${ref.type}:${ref.id}`;
const actorIsHuman=(a:ActorContext)=>{if((a.principalKind??'user')!=='user')throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');};
export interface WorkflowReceipt {id:string;kind:'scope'|'retest';investigationId:string;actorId:number;version:number;scopeVersion:string;createdAt:string;[key:string]:unknown}
/** Read-only observations and explicit, versioned receipts; no model, action, event acknowledgement or collector writes. */
export class InvestigationWorkflow extends InvestigationObservationDatabase {
  private async current(c:PoolConnection,inv:Readonly<AdmissionInvestigation>) {
    const [row]=await observationRows(c,'SELECT * FROM investigations WHERE id=? FOR UPDATE',[inv.id]);return row;
  }
  private async idle(c:PoolConnection,inv:Readonly<AdmissionInvestigation>,expected:number) {
    const row=await this.current(c,inv);
    if(inv.version!==expected||!Number.isSafeInteger(inv.version+1))throw new InvestigationStoreError('VERSION_CONFLICT');
    if(row.active_request_id)throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
    if(['closed','archived'].includes(inv.lifecycle))throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
      const active=await observationRows(c,`SELECT e.id FROM action_executions e JOIN action_plans p ON p.id=e.plan_id WHERE p.investigation_id=? AND e.state NOT IN ('succeeded','failed','cancelled','rejected') LIMIT 1 FOR UPDATE`,[inv.id]);
      if(active.length)throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
    return row;
  }
  private async prior(c:PoolConnection,actor:ActorContext,id:string,kind:string,key:string,command:unknown) {
    if(typeof key!=='string'||!key.trim()||Buffer.byteLength(key)>255)throw invalidObservation();
    const [row]=await observationRows(c,'SELECT * FROM investigation_workflow_receipts WHERE investigation_id=? AND actor_id=? AND kind=? AND idempotency_key=? FOR UPDATE',[id,actor.userId,kind,Buffer.from(key)]);
    if(!row)return null;if(row.command_hash!==evidenceHash(command))throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    // The enclosing transaction rechecks CURRENT complete scope before any receipt.
    const value=decode(row.payload) as WorkflowReceipt;
    const inv=await this.authorization.load(c as never,id);
    await this.authorization.authorize(c as never,actor,inv,'content',[...(value.resources as any[]??[]),...(value.previousResources as any[]??[])]);
    return value;
  }
  private async save(c:PoolConnection,actor:ActorContext,inv:Readonly<AdmissionInvestigation>,key:string,command:unknown,
    payload:Omit<WorkflowReceipt,'id'|'actorId'|'version'|'createdAt'|'investigationId'>,problemStatus:string) {
    const [clock]=await observationRows(c,'SELECT CURRENT_TIMESTAMP(3) AS now');const createdAt=new Date(clock.now).toISOString(),version=inv.version+1;
    const receipt={...payload,id:randomUUID(),actorId:actor.userId,investigationId:inv.id,version,createdAt} as WorkflowReceipt;
    await c.execute('INSERT INTO investigation_workflow_receipts(id,investigation_id,actor_id,kind,idempotency_key,command_hash,accepted_version,payload) VALUES(?,?,?,?,?,?,?,?)',
      [receipt.id,inv.id,actor.userId,receipt.kind,Buffer.from(key),evidenceHash(command),version,JSON.stringify(receipt)]);
    await c.execute('UPDATE investigations SET version=?,problem_status=? WHERE id=?',[version,problemStatus,inv.id]);
    await appendObservation(c,inv.id,`workflow:${receipt.id}`,{type:'investigation.changed',occurredAt:createdAt,payload:{version,lifecycle:inv.lifecycle,problemStatus:problemStatus as 'unconfirmed'}});
    return receipt;
  }
  private async suggestions(c:PoolConnection,actor:ActorContext,inv:Readonly<AdmissionInvestigation>) {
    if(inv.profileId!=='ops')return [];
    const session=new MysqlRelationSession(c),items=new Map<string,{relation:StoredRelation;resource:{type:'instance'|'server'|'network_device';id:number}}>();
    for(const current of inv.resources)for(const relation of await session.adjacent(current,101)) {
      const resource=keyOf(relation.source)===keyOf(current)?relation.target:relation.source;
      if(inv.resources.some(r=>keyOf(r)===keyOf(resource))||!['suggested','confirmed'].includes(relation.state)
        ||Date.parse(relation.validFrom)>Date.now()||relation.validUntil&&Date.parse(relation.validUntil)<=Date.now())continue;
      try {await this.authorization.authorize(c as never,actor,inv,'content',[resource]);}
      catch(error){if(error instanceof InvestigationStoreError&&[403,404].includes(error.statusCode))continue;throw error;}
      items.set(relation.relationId,{relation,resource});
      if(items.size>=100)break;
    }
    return [...items.values()].slice(0,100).map(({relation:r,resource})=>({relationId:r.relationId,version:r.version,hash:r.contentHash,resource,
      source:r.source,target:r.target,relationType:r.relationType,origin:r.origin,state:r.state,observedAt:r.observedAt,validUntil:r.validUntil}));
  }
  async canOperate(caller:ActorContext,id:string) {
    return this.transaction(caller,id,async(c,inv,actor)=>{try{actorIsHuman(actor);await this.authorization.authorize(c as never,actor,inv,'patch');return true;}catch(error){if(error instanceof InvestigationStoreError&&error.statusCode===403)return false;throw error;}});
  }
  async read(caller:ActorContext,id:string,before?:number) {
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw invalidObservation();
    return this.transaction(caller,id,async(c,inv,actor)=>{
      const receipts=await observationRows(c,`SELECT payload FROM investigation_workflow_receipts WHERE investigation_id=? ${before?'AND accepted_version<?':''} ORDER BY accepted_version DESC LIMIT 21`,[id,...(before?[before]:[])]);
      // Historical scopes may include resources no longer in the current scope; check those grants too.
      const items:WorkflowReceipt[]=[];
      for(const row of receipts.slice(0,20)) {const value=decode(row.payload);await this.authorization.authorize(c as never,actor,inv,'content',[...(value.resources??[]),...(value.previousResources??[])]);items.push(value);}
      const suggestions=await this.suggestions(c,actor,inv);
      await this.authorization.authorize(c as never,actor,inv,'content');
      let canOperate=true;try{actorIsHuman(actor);await this.authorization.authorize(c as never,actor,inv,'patch');}catch(error){if(error instanceof InvestigationStoreError&&error.statusCode===403)canOperate=false;else throw error;}
      return {canOperate,investigationId:id,version:inv.version,scopeVersion:inv.scopeVersion,resources:inv.resources,suggestions,partial:suggestions.length===100,receipts:items,nextBefore:receipts.length>20?items.at(-1)!.version:null};
    });
  }
  async changeScope(caller:ActorContext,id:string,key:string,input:unknown) {
    if(!Value.Check(InvestigationScopeCommand,input))throw invalidObservation();const command=structuredClone(input) as ScopeCommand;
    if(!command.add.length&&!command.remove.length)throw invalidObservation();
    return this.transaction(caller,id,async(c,inv,actor)=>{
      actorIsHuman(actor);await this.authorization.authorize(c as never,actor,inv,'patch');
      const prior=await this.prior(c,actor,id,'scope',key,command);if(prior)return prior;
      await this.idle(c,inv,command.expectedVersion);if(inv.profileId!=='ops')throw invalidObservation();

      const remove=new Set(command.remove.map(keyOf));
      if(remove.size!==command.remove.length||command.remove.some(r=>!inv.resources.some(old=>keyOf(old)===keyOf(r)&&old.role==='related')))throw invalidObservation();
      const validSources:StoredRelation[]=[];
      const resources=inv.resources.filter(r=>!remove.has(keyOf(r))).map(r=>({...r}));const sources=[];
      const session=new MysqlRelationSession(c);
      for(const ref of [...command.add].sort((a,b)=>a.relationId.localeCompare(b.relationId))) {
        await session.lockHead(ref.relationId);const relation=await session.head(ref.relationId);
        if(!relation||relation.version!==ref.version||relation.contentHash!==ref.hash||!['suggested','confirmed'].includes(relation.state)
          ||Date.parse(relation.validFrom)>Date.now()||relation.validUntil&&Date.parse(relation.validUntil)<=Date.now()
          ||relation.version===0&&!await session.legacyValidity(relation,new Date()))throw new InvestigationStoreError('VERSION_CONFLICT');
        const old=inv.resources.find(r=>keyOf(r)===keyOf(relation.source)||keyOf(r)===keyOf(relation.target));
        if(!old||remove.has(keyOf(old)))throw invalidObservation();
        const resource=keyOf(old)===keyOf(relation.source)?relation.target:relation.source;
        if(resources.some(r=>keyOf(r)===keyOf(resource)))throw invalidObservation();
        validSources.push(relation);resources.push({...resource,role:'related'});sources.push({relationId:ref.relationId,version:ref.version,hash:ref.hash,origin:relation.origin,state:relation.state,resource});
      }
      if(resources.length>20)throw invalidObservation();resources.sort((a,b)=>a.role.localeCompare(b.role)||a.type.localeCompare(b.type)||a.id-b.id);
      const updated={...inv,resources,scopeRevision:(inv.scopeRevision??0)+1};await this.authorization.authorize(c as never,actor,updated,'patch');
      const scopeVersion=createHash('sha256').update(JSON.stringify({resources,revision:updated.scopeRevision})).digest('hex');
      await c.execute('DELETE FROM investigation_resources WHERE investigation_id=?',[id]);
      for(const r of resources)await c.execute('INSERT INTO investigation_resources(investigation_id,resource_type,resource_id,role) VALUES(?,?,?,?)',[id,r.type,r.id,r.role]);
      for(const r of [...inv.resources,...resources])await c.execute('INSERT IGNORE INTO investigation_scope_resources(investigation_id,resource_type,resource_id) VALUES(?,?,?)',[id,r.type,r.id]);
      await c.execute('UPDATE investigations SET scope_version=?,scope_revision=scope_revision+1 WHERE id=?',[scopeVersion,id]);
      // Existing immutable plans retain their audit content; their approval cannot apply to the new scope.
      await c.execute(`UPDATE action_plan_versions v JOIN action_plans p ON p.id=v.plan_id SET v.state='superseded' WHERE p.investigation_id=? AND v.state IN ('draft','pending_approval','approved')`,[id]);
      const receipt=await this.save(c,actor,inv,key,command,{kind:'scope',scopeVersion,previousScopeVersion:inv.scopeVersion,resources,previousResources:inv.resources,sources,removed:command.remove,confirmed:true},'unconfirmed');
      await this.authorization.authorize(c as never,actor,updated,'patch');
      for(const relation of validSources)if(relation.validUntil&&Date.parse(relation.validUntil)<=Date.now()||relation.version===0&&!await session.legacyValidity(relation,new Date()))throw new InvestigationStoreError('VERSION_CONFLICT');
      return receipt;
    });
  }
  async retest(caller:ActorContext,id:string,key:string,input:unknown,metrics?:MetricConsumerService) {
    metrics??=(await import('../metrics/consumers/runtime.js')).authenticatedMetricConsumerService;
    const {checkEntryEvents}=await import('./entry-routes.js');
    if(!Value.Check(InvestigationRetestCommand,input))throw invalidObservation();const command=structuredClone(input) as RetestCommand;
    if(!instant(command.from)||!instant(command.to)||Date.parse(command.from)>=Date.parse(command.to)||Date.parse(command.to)>Date.now()
      ||Date.parse(command.to)-Date.parse(command.from)>86400000)throw invalidObservation();
    return this.transaction(caller,id,async(c,inv,actor)=>{
      actorIsHuman(actor);await this.authorization.authorize(c as never,actor,inv,'patch');
      const prior=await this.prior(c,actor,id,'retest',key,command);if(prior)return prior;
      const row=await this.idle(c,inv,command.expectedVersion);const [creation]=await observationRows(c,'SELECT command_snapshot FROM investigation_create_keys WHERE investigation_id=?',[id]);const context=decode(creation?.command_snapshot)?.context?.entry as InvestigationEntryContext|undefined;
      if(inv.profileId!=='ops'||!context?.sourceEventIds?.includes(command.eventId)||Date.parse(command.from)<Date.parse(context.to))throw invalidObservation();
      await checkEntryEvents(actor,context);
      const [episodeRow]=await observationRows(c,'SELECT * FROM metric_trigger_episodes WHERE event_id=? FOR SHARE',[command.eventId]);
      if(!episodeRow)throw absentObservation();const episode=decode(episodeRow.payload),snapshot=verifyTriggerSnapshot(decode(episodeRow.snapshot).configuration);
      const rule=snapshot.rules.find(r=>r.rule_id===episode.rule_id&&r.scope===episode.scope&&r.version===episode.version&&r.body_hash===episode.body_hash);
      const resource={type:snapshot.resource.type,id:Number(snapshot.resource.id)};
      if(!rule||Date.parse(command.from)<Date.parse(episode.opened_at)||!inv.resources.some(r=>keyOf(r)===keyOf(resource)))throw invalidObservation();
      let page:Awaited<ReturnType<typeof metrics.observations>>|null=null;const gaps:string[]=[];
      try {page=await metrics.observations(actor,{resource,metric:rule.metric,dimensions:decode(episodeRow.snapshot).opening.dimensions,from:command.from,to:command.to,limit:1000});}
      catch(error){if(error instanceof PolicyError&&[403,404].includes(error.status))throw absentObservation();gaps.push('OBSERVATIONS_UNAVAILABLE');}
      const observations=page?.observations??[];if(page?.has_more)gaps.push('OBSERVATIONS_TRUNCATED');
      if(inv.resources.some(r=>keyOf(r)!==keyOf(resource)))gaps.push('RELATED_SCOPE_NOT_COVERED');
      const samples=observations.filter(o=>o.value&&'encoding' in o.value).map(o=>({metric:rule.metric,unit:o.unit,value:o.value!,observed_at:o.observed_at,
        quality:o.quality,accuracy:o.accuracy,dimensions:decode(episodeRow.snapshot).opening.dimensions,coverage:1,window:null}));
      if(samples.length<2)gaps.push('INSUFFICIENT_SAMPLES');
      if(samples.length!==observations.length)gaps.push('MISSING_SAMPLE_VALUES');
      const times=samples.map(s=>Date.parse(s.observed_at));const tolerance=rule.clock.stale_after_ms;
      if(times.length&&(times[0]-Date.parse(command.from)>tolerance||Date.parse(command.to)-times.at(-1)!>tolerance||times.some((t,i)=>i>0&&t-times[i-1]>tolerance)))gaps.push('OBSERVATION_WINDOW_GAP');
      const evaluation=samples.map((sample,i)=>evaluateTriggerRule(snapshot,{rule_id:rule.rule_id,scope:rule.scope},{input:{now:sample.observed_at,last_seen_at:sample.observed_at,previous:'problem',samples:samples.slice(0,i+1) as never},
        applied:{resource,applied_revision:snapshot.config_revision,plan_identity:snapshot.plan_identity,application_status:'applied'}}));
      if(evaluation.some(v=>v.business==='unknown'||v.quality!=='good'))gaps.push('EVIDENCE_QUALITY_INSUFFICIENT');
      const conclusion=gaps.length?'insufficient_evidence':evaluation.every(v=>v.recovery)?'recovered':'not_improved';
      await checkEntryEvents(actor,context);await this.authorization.authorize(c as never,actor,inv,'patch');
      let evidenceId:string|null=null;
      // A post-run read is attributed to this human retest, not to a new model Run.
      // Attach only complete recovery proof to an exactly bound current-scope result.
      if(conclusion==='recovered') {
        const [basis]=await observationRows(c,`SELECT ir.id,ir.request_id,ir.run_id,q.request_snapshot,r.session_id,r.message_id,q.message_id AS request_message
          FROM investigation_results ir JOIN investigation_requests q ON q.id=ir.request_id
          JOIN agent_runs r ON r.id=ir.run_id AND r.idempotency_key=CONCAT('investigation:',q.id)
          WHERE ir.investigation_id=? ORDER BY ir.version DESC LIMIT 1 FOR SHARE`,[id]);
        if(basis&&decode(basis.request_snapshot)?.scopeVersion===inv.scopeVersion&&basis.session_id===inv.sessionId&&basis.message_id===basis.request_message) {
          const evidence=new InvestigationEvidenceStore(this.poolProvider,this.authorization);
          const proof=await evidence.putOnConnection(c,actor,inv,{investigationId:id,requestId:basis.request_id,runId:basis.run_id},`retest:${evidenceHash([id,key,actor.userId])}`,
            prepareEvidence({source:'retest:formal-observations',summary:'原事件规则下的后续正式观测；由人工显式复测读取，不是模型输出。',resources:[resource],observedFrom:command.from,observedTo:command.to,collectedAt:new Date().toISOString(),
              raw:{basisResultId:basis.id,capturedBy:actor.userId,ruleHash:rule.snapshot_hash,partial:false,truncated:false,hasMore:false,observations:observations.map(o=>({id:o.id,at:o.observed_at,value:o.value,quality:o.quality}))}}));
          evidenceId=proof.id;
        }
      }
      const receipt=await this.save(c,actor,inv,key,command,{kind:'retest',scopeVersion:inv.scopeVersion,resources:inv.resources,eventId:command.eventId,from:command.from,to:command.to,
        conclusion,gaps,evidenceId,rule:{metric:rule.metric,unit:rule.unit,resource,id:rule.rule_id,version:rule.version,hash:rule.snapshot_hash,configRevision:snapshot.config_revision},observations,evaluation,modelInvoked:false,actionExecuted:false},
        conclusion==='not_improved'?'in_progress':'unconfirmed');
      await this.authorization.authorize(c as never,actor,inv,'patch');return receipt;
    });
  }
}
