import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken } from './actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { dbConnection } from '../db-connection.js';
import { chatDatabaseService } from '../chat-database-service.js';
import { registerChatRoutes } from '../chat-routes.js';
import { canActorDiscoverTool, decideToolPolicy } from '../tools/policy.js';

const engine = vi.hoisted(() => ({ chat: vi.fn() }));
// Admission reaches the real handler/SQL boundary; no actual model is invoked.
vi.mock('../adapter/get-agent-engine.js', () => ({ getAgentEngine: async () => engine }));
import { handleChatSend } from '../chat-handler.js';

// Characterization of existing behavior, not acceptance of a chat:view deny policy.
const port = Number(process.env.MAX683_CHAT_MYSQL_PORT);
describe.skipIf(!port)('MAX-683 baseline ordinary chat permission contract', () => {
  const database='max683_chat_'+randomUUID().replaceAll('-',''),secret=randomUUID();
  let admin:any,pool:any,app:any,a:any,b:any,tokenA:string,tokenB:string,sessionA:string,sessionB:string,bound:string;
  const observations:any[]=[];
  const contexts=new ActorContextService();
  const call=(method:string,url:string,token?:string,payload?:any)=>app.inject({method,url,...(token?{headers:{authorization:'Bearer '+token}}:{}),...(payload?{payload}:{})});
  async function observe(name:string,method:string,url:string,token:string|undefined,status:number,payload?:any) {
    const before=engine.chat.mock.calls.length,r=await call(method,url,token,payload);
    observations.push({name,status:r.statusCode,engineAdmissions:engine.chat.mock.calls.length-before});
    expect(r.statusCode).toBe(status);return r;
  }
  beforeAll(async()=>{
    if(port===3306)throw new Error('MAX683_CHAT_MYSQL_PORT requires an isolated non-platform port');
    const opts={host:'127.0.0.1',port,user:'root',password:process.env.MAX683_CHAT_MYSQL_PASSWORD??'',connectionLimit:4};
    admin=mysql.createPool(opts);await admin.query('CREATE DATABASE '+database);pool=mysql.createPool({...opts,database});
    await new MigrationRunner(pool).run();
    for(const id of [68311,68312]){
      await pool.execute("INSERT INTO users(id,username,password_hash) VALUES(?,?,'disabled-isolated-test')",[id,'chat-contract-'+id]);
      await pool.execute('INSERT INTO roles(id,name) VALUES(?,?)',[id,'chat-contract-'+id]);
      await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)',[id,id]);
      await pool.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='operations:actions:view'",[id]);
    }
    const sql={execute:(q:string,v:any[])=>pool.execute(q,v)};
    a=await contexts.loadInvestigationActorFrom(sql as any,68311,'user',1);
    b=await contexts.loadInvestigationActorFrom(sql as any,68312,'user',1);
    expect(a.permissions).toContain('operations:actions:view');expect(a.permissions).not.toContain('chat:view');
    vi.spyOn(dbConnection,'getPool').mockReturnValue(pool);
    sessionA=(await chatDatabaseService.createSession(a)).session_id;
    sessionB=(await chatDatabaseService.createSession(b)).session_id;
    bound=(await chatDatabaseService.createSession(a)).session_id;
    for(const [actor,key,text] of [[a,sessionA,'PRIVATE_A'],[b,sessionB,'PRIVATE_B'],[a,bound,'INVESTIGATION_PRIVATE']] as any[]) {
      await chatDatabaseService.addMessage(actor,key,{messageId:randomUUID(),role:'user',content:text});
    }
    await pool.execute("INSERT INTO investigations(id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version) VALUES(?,'bound','bound','ops',1,?,'user',?,?)",[randomUUID(),bound,a.userId,'a'.repeat(64)]);
    engine.chat.mockResolvedValue({finalContent:'CONTROLLED_ENGINE_BOUNDARY',stopReason:'completed'});
    tokenA=signAccessToken(a,secret);tokenB=signAccessToken(b,secret);
    app=Fastify();await registerChatRoutes(app,{verifyToken:createVerifyToken(secret,contexts),service:chatDatabaseService,handleChatSend});
  },60000);
  afterAll(async()=>{
    await app?.close();vi.restoreAllMocks();await pool?.end();
    if(admin){await admin.query('DROP DATABASE IF EXISTS '+database);await admin.end();}
    if(process.env.MAX683_CHAT_EVIDENCE)await writeFile(process.env.MAX683_CHAT_EVIDENCE,JSON.stringify({observations,realProviderCalls:0,model:'controlled engine boundary only',schemaDropped:true},null,2));
  });
  it('rejects missing JWT and another user body; permits own body without chat:view',async()=>{
    await observe('no JWT','GET','/api/chat/history?sessionKey='+sessionA,undefined,401);
    const own=await observe('action-only own history','GET','/api/chat/history?sessionKey='+sessionA,tokenA,200);
    expect(own.body).toContain('PRIVATE_A');
    const foreign=await observe('cross-user history','GET','/api/chat/history?sessionKey='+sessionB,tokenA,404);
    expect(foreign.body).not.toContain('PRIVATE_B');
  });
  it('admits own and new ordinary chat to engine without chat:view; rejects foreign and identity spoofing',async()=>{
    await observe('action-only own send','POST','/api/chat/send',tokenA,200,{sessionKey:sessionA,message:'probe'});
    await observe('action-only new send','POST','/api/chat/send',tokenA,200,{message:'probe'});
    await observe('cross-user send','POST','/api/chat/send',tokenB,404,{sessionKey:sessionA,message:'probe'});
    await observe('body identity spoofing','POST','/api/chat/send',tokenB,400,{sessionKey:sessionA,message:'probe',userId:a.userId});
    expect(observations.slice(-4).map(x=>x.engineAdmissions)).toEqual([1,1,0,0]);
  });
  it('permits explicit read-only share but never shared append or linked investigation body',async()=>{
    await chatDatabaseService.grantSessionShare(a,sessionA,b.userId,'read');
    await observe('explicit read share','GET','/api/chat/history?sessionKey='+sessionA,tokenB,200);
    await observe('read share cannot append','POST','/api/chat/send',tokenB,404,{sessionKey:sessionA,message:'probe'});
    const r=await observe('linked investigation history without chat:view','GET','/api/chat/history?sessionKey='+bound,tokenA,404);
    expect(r.body).not.toContain('INVESTIGATION_PRIVATE');
  });
  it('does not turn operations permission into protected tool discovery or execution permission',()=>{
    for(const name of ['query_metrics','get_instance_connection']){
      const tool:any={name,description:'probe',parameters:{type:'object',properties:{}},handler:vi.fn()};
      const withAction={...a,permissions:['operations:actions:view']},withoutAction={...a,permissions:[]};
      const x=decideToolPolicy(withAction,tool,{instance_id:1}),y=decideToolPolicy(withoutAction,tool,{instance_id:1});
      expect(canActorDiscoverTool(withAction,tool)).toBe(false);
      expect(x.allow).toBe(false);expect(y.allow).toBe(false);expect(x.reasonCode).toBe(y.reasonCode);
      observations.push({name:'protected tool '+name,discoverable:false,allow:x.allow,reasonCode:x.reasonCode});
    }
  });
  it('chat admission is unchanged by action permission withdrawal; session revocation is enforced',async()=>{
    await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=68311 AND p.code='operations:actions:view'");
    await observe('no action or chat permission own send','POST','/api/chat/send',tokenA,200,{sessionKey:sessionA,message:'probe'});
    await pool.execute('UPDATE users SET session_version=2 WHERE id=68311');
    await observe('stale JWT after session revocation','GET','/api/chat/history?sessionKey='+sessionA,tokenA,401);
  });
});
