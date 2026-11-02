import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,describe} from 'vitest';
import {startFeedbackFixture} from './feedback-test-fixture.js';
import {registerInvestigationRoutes} from './routes.js';
import {createVerifyToken} from '../auth-middleware.js';
import {signAccessToken} from '../auth/actor-context.js';
import {MysqlRelationSession,newRelationId,relationHash,type StoredRelation} from '../operations/relations/store.js';
const port=Number(process.env.MAX242_TEST_MYSQL_PORT);
describe.skipIf(!port)('MAX242 original workflow HTTP/JWT/SQL',()=>{
 let f:Awaited<ReturnType<typeof startFeedbackFixture>>;
 beforeAll(async()=>{f=await startFeedbackFixture(port);await registerInvestigationRoutes(f.app,createVerifyToken(f.secret,f.contexts),f.bridge);},120000);
 afterAll(async()=>{await f?.close();});
 const post=(id:string,path:string,body:unknown,key:string=randomUUID(),token=f.tokens.owner)=>f.app.inject({method:'POST',url:`/api/investigations/${id}/${path}`,headers:{authorization:`Bearer ${token}`,'idempotency-key':key,'content-type':'application/json'},payload:JSON.stringify(body)});
 async function related(){
  const s=await f.seed();
  await f.rows("INSERT IGNORE INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(103,'Related service','controlled.invalid',3306,'fixture','unused')");
  await f.rows("INSERT IGNORE INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,103,'read-only')");
  const relation:StoredRelation={schemaVersion:1,id:'',relationId:newRelationId(),version:1,contentHash:'',source:{type:'instance',id:101},target:{type:'instance',id:103},relationType:'depends_on',state:'suggested',evidence:[],origin:'manual',author:{kind:'user',id:101},confirmedBy:null,confirmedAt:null,withdrawalReason:null,legacyProvenance:null,observedAt:new Date().toISOString(),validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()};relation.id=relation.relationId;relation.contentHash=relationHash(relation);
  const c=await f.pool.getConnection();try{await new MysqlRelationSession(c).append(relation);}finally{c.release();}
  const token=signAccessToken(await f.contexts.loadActiveActor(101),f.secret);
  return {s,relation,token,command:{expectedVersion:s.base.expectedVersion,confirmed:true,add:[{relationId:relation.id,version:1,hash:relation.contentHash}],remove:[]}};
 }
 it('shows sourced suggestions without adding resources, confirms once and retains immutable original request scopes',async()=>{
  const {s,relation,token,command}=await related();
  const before=await f.app.inject({method:'GET',url:`/api/investigations/${s.inv.id}/workflow`,headers:{authorization:`Bearer ${token}`}});
  expect(before.statusCode).toBe(200);expect(before.json().resources).toHaveLength(2);expect(before.json().suggestions).toContainEqual(expect.objectContaining({relationId:relation.id,origin:'manual',state:'suggested'}));
  const viewer=await f.app.inject({method:'GET',url:`/api/investigations/${s.inv.id}/workflow`,headers:{authorization:`Bearer ${f.tokens.viewer}`}});expect(viewer.statusCode).toBe(200);expect(viewer.json().canOperate).toBe(false);
  const replies=await Promise.all(Array.from({length:8},()=>post(s.inv.id,'scope',command,'scope-once',token)));
  expect(replies.map(r=>r.statusCode)).toEqual(Array(8).fill(200));expect(new Set(replies.map(r=>r.json().id)).size).toBe(1);for(const r of replies)expect(r.json()).toEqual(replies[0].json());
  const [original]=await f.rows('SELECT request_snapshot FROM investigation_requests WHERE id=?',[s.binding.requestId]);expect(original.request_snapshot.resources).toHaveLength(2);
  expect(await f.rows('SELECT * FROM investigation_resources WHERE investigation_id=?',[s.inv.id])).toHaveLength(3);
  expect(await f.rows('SELECT * FROM investigation_workflow_receipts WHERE investigation_id=?',[s.inv.id])).toHaveLength(1);
  expect((await post(s.inv.id,'scope',{...command,remove:[{type:'instance',id:102}]},'scope-once',token)).statusCode).toBe(409);
  expect((await f.app.inject({method:'GET',url:`/api/investigations/${s.inv.id}/workflow`,headers:{authorization:`Bearer ${f.tokens.viewer}`}})).statusCode).toBe(404);
 });
 it('rejects forged confirmation, stale source and active Run before changing scope',async()=>{
  const {s,command,token}=await related();
  expect((await post(s.inv.id,'scope',{...command,confirmed:false},randomUUID(),token)).statusCode).toBe(400);
  expect((await post(s.inv.id,'scope',{...command,add:[{...command.add[0],hash:'f'.repeat(64)}]},randomUUID(),token)).statusCode).toBe(409);
  expect((await post(s.inv.id,'scope',command,randomUUID(),f.tokens.viewer)).statusCode).toBe(403);
  await f.rows('UPDATE investigations SET active_request_id=? WHERE id=?',[s.binding.requestId,s.inv.id]);
  expect((await post(s.inv.id,'scope',command,randomUUID(),token)).statusCode).toBe(409);
  expect(await f.rows('SELECT * FROM investigation_workflow_receipts WHERE investigation_id=?',[s.inv.id])).toHaveLength(0);
 });
 it('does not accept an unrelated event or turn missing observations into a recovery',async()=>{
  const s=await f.seed();
  const reply=await post(s.inv.id,'retest',{expectedVersion:s.base.expectedVersion,eventId:1,from:new Date(Date.now()-30000).toISOString(),to:new Date(Date.now()-1000).toISOString(),confirmed:true});
  expect(reply.statusCode).toBe(400);
  const [inv]=await f.rows('SELECT problem_status FROM investigations WHERE id=?',[s.inv.id]);expect(inv.problem_status).toBe('unconfirmed');
 });
 it('old scope result cannot supply a new recovery confirmation after a scope revision',async()=>{
  const {s,command,token}=await related();expect((await post(s.inv.id,'scope',command,randomUUID(),token)).statusCode).toBe(200);
  const response=await post(s.inv.id,'feedback',{...s.base,expectedVersion:s.base.expectedVersion+1,kind:'recovery',verification:s.verification},randomUUID(),token);
  expect(response.statusCode).toBe(409);expect(await f.rows('SELECT * FROM investigation_feedback WHERE investigation_id=?',[s.inv.id])).toHaveLength(0);
 });
 it('retains historical ACLs after narrowing and gives an identical resource set a new scope identity',async()=>{
  const {s,command,token}=await related();
  const added=(await post(s.inv.id,'scope',command,randomUUID(),token)).json();
  const removed=await post(s.inv.id,'scope',{expectedVersion:added.version,confirmed:true,add:[],remove:[{type:'instance',id:103}]},randomUUID(),token);
  expect(removed.statusCode).toBe(200);expect(removed.json().scopeVersion).not.toBe(s.inv.scopeVersion);
  await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=103');
  for(const suffix of ['', '/workflow','/context-facts'])expect((await f.app.inject({method:'GET',url:`/api/investigations/${s.inv.id}${suffix}`,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(404);
  await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,103,'read-only')");
  expect((await f.app.inject({method:'GET',url:`/api/investigations/${s.inv.id}/workflow`,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(200);
 });

 it.each(['retest:formal-observations','controlled-observation'].flatMap(source=>['not_improved','insufficient_evidence'].flatMap(conclusion=>['recovery','close'].map(kind=>({source,conclusion,kind})))))('rejects $source $kind after $conclusion without changing state or audit',async({source,conclusion,kind})=>{
  const s=await f.seed();
  await f.rows("UPDATE investigation_evidence SET metadata_json=JSON_SET(metadata_json,'$.source',?) WHERE id=?",[source,s.verification.evidenceIds[0]]);
  const receipt={scopeVersion:s.inv.scopeVersion,conclusion,evidenceId:null,from:s.verification.to,to:new Date().toISOString()};
  await f.rows("INSERT INTO investigation_workflow_receipts(id,investigation_id,actor_id,kind,idempotency_key,command_hash,accepted_version,payload) VALUES(?,?,101,'retest',? ,?,99,?)",[randomUUID(),s.inv.id,Buffer.from(randomUUID()),'a'.repeat(64),JSON.stringify(receipt)]);
  const response=await post(s.inv.id,'feedback',{...s.base,kind,...(kind==='close'?{lifecycle:'closed',problemStatus:'resolved'}:{}),verification:s.verification});
  expect(response.statusCode).toBe(409);expect(await f.rows('SELECT * FROM investigation_feedback WHERE investigation_id=?',[s.inv.id])).toHaveLength(0);
  expect((await f.rows('SELECT lifecycle,problem_status,version FROM investigations WHERE id=?',[s.inv.id]))[0]).toMatchObject({lifecycle:'open',problem_status:'unconfirmed',version:s.base.expectedVersion});
  expect(await f.rows("SELECT * FROM investigation_stream_events WHERE investigation_id=? AND source_key LIKE 'feedback:%'",[s.inv.id])).toHaveLength(0);
 });

 it('accepts fresh ordinary evidence after a bad window and preserves retry identity',async()=>{
  const s=await f.seed();
  const receipt={scopeVersion:s.inv.scopeVersion,conclusion:'not_improved',evidenceId:null,from:new Date(Date.parse(s.verification.from)-2000).toISOString(),to:s.verification.from};
  await f.rows("INSERT INTO investigation_workflow_receipts(id,investigation_id,actor_id,kind,idempotency_key,command_hash,accepted_version,payload) VALUES(?,?,101,'retest',?,?,99,?)",[randomUUID(),s.inv.id,Buffer.from(randomUUID()),'a'.repeat(64),JSON.stringify(receipt)]);
  const key=randomUUID(),command={...s.base,kind:'close',lifecycle:'closed',problemStatus:'resolved',verification:s.verification};
  const closed=await post(s.inv.id,'feedback',command,key);expect(closed.statusCode).toBe(200);
  expect((await post(s.inv.id,'feedback',command,key)).json()).toEqual(closed.json());
 });
 it('later submission of an old recovered window cannot erase a newer adverse window',async()=>{
  const s=await f.seed();
  for(const [version,receipt] of [[98,{scopeVersion:s.inv.scopeVersion,conclusion:'not_improved',evidenceId:null,from:s.verification.to,to:new Date().toISOString()}],
    [99,{scopeVersion:s.inv.scopeVersion,conclusion:'recovered',evidenceId:s.proof.id,from:s.verification.from,to:s.verification.to}]] as const)
    await f.rows("INSERT INTO investigation_workflow_receipts(id,investigation_id,actor_id,kind,idempotency_key,command_hash,accepted_version,payload) VALUES(?,?,101,'retest',?,?,?,?)",[randomUUID(),s.inv.id,Buffer.from(randomUUID()),'a'.repeat(64),version,JSON.stringify(receipt)]);
  await f.rows("UPDATE investigation_evidence SET metadata_json=JSON_SET(metadata_json,'$.source','retest:formal-observations') WHERE id=?",[s.proof.id]);
  expect((await post(s.inv.id,'feedback',{...s.base,kind:'close',lifecycle:'closed',problemStatus:'resolved',verification:s.verification})).statusCode).toBe(409);
 });
 it('marks historical recovery stale after newer adverse observations without rewriting the original audit',async()=>{
  const s=await f.seed();const accepted=await post(s.inv.id,'feedback',{...s.base,kind:'recovery',verification:s.verification});expect(accepted.statusCode).toBe(200);
  const receipt={scopeVersion:s.inv.scopeVersion,conclusion:'insufficient_evidence',evidenceId:null,from:s.verification.to,to:new Date().toISOString()};
  await f.rows("INSERT INTO investigation_workflow_receipts(id,investigation_id,actor_id,kind,idempotency_key,command_hash,accepted_version,payload) VALUES(?,?,101,'retest',?,?,99,?)",[randomUUID(),s.inv.id,Buffer.from(randomUUID()),'a'.repeat(64),JSON.stringify(receipt)]);
  const response=await f.app.inject({url:`/api/investigations/${s.inv.id}/feedback`,headers:{authorization:`Bearer ${f.tokens.owner}`}});
  expect(response.json().items[0]).toMatchObject({id:accepted.json().id,staleVerification:true,verification:accepted.json().verification});
 });
 it('a newer claimed window still requires actual evidence coverage; non-recovery closure remains available',async()=>{
  const s=await f.seed(),to=new Date(Date.now()-100).toISOString();
  const receipt={scopeVersion:s.inv.scopeVersion,conclusion:'not_improved',evidenceId:null,from:s.verification.to,to};
  await f.rows("INSERT INTO investigation_workflow_receipts(id,investigation_id,actor_id,kind,idempotency_key,command_hash,accepted_version,payload) VALUES(?,?,101,'retest',?,?,99,?)",[randomUUID(),s.inv.id,Buffer.from(randomUUID()),'a'.repeat(64),JSON.stringify(receipt)]);
  expect((await post(s.inv.id,'feedback',{...s.base,kind:'recovery',verification:{...s.verification,from:to,to:new Date().toISOString()}})).statusCode).toBe(400);
  expect((await post(s.inv.id,'feedback',{...s.base,kind:'close',lifecycle:'closed',problemStatus:'unconfirmed'})).statusCode).toBe(200);
  expect((await f.rows('SELECT problem_status FROM investigations WHERE id=?',[s.inv.id]))[0].problem_status).toBe('unconfirmed');
 });
});
