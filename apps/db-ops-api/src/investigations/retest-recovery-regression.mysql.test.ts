// Ported from Chief edc0688e4; author reruns are regression evidence, not a new independent review.
// Real SQL/workflow/evaluator, synthetic observation port and entry-event authorization port.
// This suite tests window/evaluation semantics, not event ACL or collector qualification.
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {startFeedbackFixture} from './feedback-test-fixture.js';
import {InvestigationWorkflow} from './workflow.js';
import {baseline,portOf,near} from '../metrics/triggers/test-support.js';
import {resolveTriggerRules} from '../metrics/triggers/resolve.js';
import {compileTriggerSnapshot} from '../metrics/triggers/compile.js';
vi.mock('./entry-routes.js',()=>({checkEntryEvents:vi.fn(async()=>{})}));
describe.skipIf(!Number(process.env.MAX242_TEST_MYSQL_PORT))('B1 recovery chronology isolated MySQL',()=>{
let f:Awaited<ReturnType<typeof startFeedbackFixture>>;let n=800;
beforeAll(async()=>{f=await startFeedbackFixture(Number(process.env.MAX242_TEST_MYSQL_PORT));await f.rows("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(7,'window fixture','fixture.invalid',3306,'fixture','unused')");await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,7,'read-only')");},120000);
afterAll(async()=>{await f?.close();});
async function setup(){
 const s=await f.seed();const b=await baseline();const snapshot=compileTriggerSnapshot(await resolveTriggerRules(b.resolution,b.catalog,portOf([b.version]).port));const rule=snapshot.rules.find(r=>r.rule_id==='alpha-threshold')!;const now=Date.now();const from=new Date(now-600000).toISOString(),to=new Date(now-1000).toISOString();const eventId=n++;
 await f.rows('DELETE FROM investigation_resources WHERE investigation_id=?',[s.inv.id]);
 await f.rows("INSERT INTO investigation_resources(investigation_id,resource_type,resource_id,role) VALUES(?,'instance',7,'primary')",[s.inv.id]);
 await f.rows("UPDATE investigation_create_keys SET command_snapshot=JSON_SET(command_snapshot,'$.context.entry',CAST(? AS JSON)) WHERE investigation_id=?",[JSON.stringify({to:new Date(now-700000).toISOString(),sourceEventIds:[eventId]}),s.inv.id]);
 const identity='sha256:'+String(eventId).padStart(64,'0');
 await f.rows('INSERT INTO metric_trigger_episodes(episode_id,identity_hash,resource_key,config_revision,event_id,alert_id,payload,snapshot) VALUES(?,?,?,?,?,?,?,?)',[identity,identity,'instance:7',snapshot.config_revision,eventId,eventId,JSON.stringify({rule_id:rule.rule_id,scope:rule.scope,version:rule.version,body_hash:rule.body_hash,opened_at:new Date(now-800000).toISOString()}),JSON.stringify({configuration:snapshot,opening:{dimensions:{}}})]);
 const actor=await f.contexts.loadActiveActor(101);const wf=new InvestigationWorkflow(()=>f.pool,f.authorization);
 const command={expectedVersion:s.base.expectedVersion,eventId,from,to,confirmed:true};
 const sample=(at:string,value=60)=>({id:randomUUID(),...near(value,{observed_at:at})});
 const full=Array.from({length:7},(_,i)=>sample(new Date(now-600000+i*99833).toISOString()));
 return {s,wf,actor,command,sample,full};
}
it.each(['recovered','not_improved','gap','truncated','missing','partial'])('CHIEF retest %s is classified without false recovery',async(kind)=>{
 const x=await setup();let obs:any[]=x.full;let more=false;
 if(kind==='not_improved')obs=obs.map(o=>({...o,value:{encoding:'float64',value:95}}));
 if(kind==='gap')obs=[obs[0],obs.at(-1)];
 if(kind==='truncated')more=true;
 if(kind==='missing')obs=[];
 if(kind==='partial')obs=obs.map(o=>({...o,quality:{status:'partial',reason:'incomplete'}}));
 const receipt=await x.wf.retest(x.actor,x.s.inv.id,randomUUID(),x.command,{observations:async()=>({observations:obs,has_more:more})} as any);
 expect(receipt.conclusion).toBe(['recovered','not_improved'].includes(kind)?kind:'insufficient_evidence');
 const state=(await f.rows('SELECT problem_status,lifecycle FROM investigations WHERE id=?',[x.s.inv.id]))[0];expect(state.problem_status).not.toBe('resolved');expect(state.lifecycle).not.toBe('closed');
});
it.each(['future','before-original','over24h'])('CHIEF rejects invalid absolute window %s',async(kind)=>{
 const x=await setup();if(kind==='future')x.command.to=new Date(Date.now()+60000).toISOString();
 if(kind==='before-original')x.command.from=new Date(Date.now()-900000).toISOString();
 if(kind==='over24h')x.command.from=new Date(Date.now()-90000000).toISOString();
 const observations=vi.fn(async()=>({observations:x.full,has_more:false}));
 await expect(x.wf.retest(x.actor,x.s.inv.id,randomUUID(),x.command,{observations} as any)).rejects.toThrow();expect(observations).not.toHaveBeenCalled();
});
it.each(['not_improved','insufficient_evidence'])('CHIEF real retest %s cannot be overridden with older ordinary evidence',async(kind)=>{
 const x=await setup();
 await f.rows("UPDATE investigation_requests SET request_snapshot=JSON_SET(request_snapshot,'$.resources',CAST(? AS JSON)) WHERE id=?",[JSON.stringify([{type:'instance',id:7,role:'primary'}]),x.s.binding.requestId]);
 const [q]=await f.rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[x.s.binding.requestId]);
 const snap=typeof q.request_snapshot==='string'?JSON.parse(q.request_snapshot):q.request_snapshot;snap.authority.instanceScopes['7']='read-only';snap.authority.resourceBoundary.instanceIds.push(7);
 await f.rows('UPDATE investigation_requests SET request_snapshot=? WHERE id=?',[JSON.stringify(snap),x.s.binding.requestId]);
 const from=new Date(Date.parse(x.command.from)-120000).toISOString(),to=new Date(Date.parse(x.command.from)-60000).toISOString();
 const proof=await f.evidence.put(x.actor,x.s.binding,randomUUID(),{source:'controlled-observation',summary:'Synthetic older healthy reading',resources:[{type:'instance',id:7}],observedFrom:from,observedTo:to,collectedAt:new Date().toISOString(),raw:{status:'normal'}});
 const receipt=await x.wf.retest(x.actor,x.s.inv.id,randomUUID(),x.command,{observations:async()=>({observations:kind==='not_improved'?x.full.map(o=>({...o,value:{encoding:'float64',value:95}})):[],has_more:false})} as any);
 expect(receipt.conclusion).toBe(kind);
 await expect(f.feedback.add(x.actor,x.s.inv.id,randomUUID(),{...x.s.base,expectedVersion:receipt.version,kind:'close',lifecycle:'closed',problemStatus:'resolved',verification:{method:'Old ordinary observation',from,to,evidenceIds:[proof.id]}})).rejects.toThrow();
});

});
