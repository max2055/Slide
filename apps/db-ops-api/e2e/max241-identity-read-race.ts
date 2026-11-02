/** Real HTTP/JWT/MySQL authorization races. Only an owned non3306 fixture is mutated. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import Fastify from 'fastify';
import mysql from 'mysql2/promise';
import {dbConnection} from '../src/db-connection.js';
import {MigrationRunner} from '../src/migrations/runner.js';
import {createOwnedDatabase} from '../src/testing/owned-fixture.js';
import {actorContextService,signAccessToken} from '../src/auth/actor-context.js';
import {createVerifyToken} from '../src/auth-middleware.js';
import {registerInstanceListRoutes} from '../src/instance-list-routes.js';
import {registerResourceIdentityRoutes} from '../src/resources/resource-identity-routes.js';
import {registerNetworkDeviceRoutes} from '../src/network-devices/network-device-routes.js';
import {instanceDatabaseService} from '../src/instance-database-service.js';
import {serverDatabaseService} from '../src/server-database-service.js';
import {networkDeviceDatabaseService} from '../src/network-devices/network-device-database-service.js';
const nonce=randomBytes(8).toString('hex'),directory=resolve('../../docs/slide/development/MAX-241/production/identity-http-'+nonce);
mkdirSync(directory,{recursive:true});
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const handle={nonce,pid:process.pid,cwd:process.cwd(),container:'',schema:'',port:0,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
const save=()=>writeFileSync(join(directory,'lifecycle.json'),JSON.stringify(handle,null,2));save();
let root:mysql.Pool|undefined,owned:Awaited<ReturnType<typeof createOwnedDatabase>>|undefined;
const app=Fastify(),checks:unknown[]=[];let failure='',cleanup='';
try{
 handle.container=docker('run','-d','--rm','--label',`slide.max241.nonce=${nonce}`,'-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-p','127.0.0.1::3306','mysql:8.4');save();
 handle.port=Number(docker('port',handle.container,'3306/tcp').split(':').at(-1));assert(handle.port>0&&handle.port!==3306);save();
 root=mysql.createPool({host:'127.0.0.1',port:handle.port,user:'root',password:''});
 const deadline=Date.now()+45000;for(;;){try{await root.query('SELECT 1');break;}catch(e){if(Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,300));}}
 owned=await createOwnedDatabase(root as any,{nonce,purpose:'identity',handleDir:directory});handle.schema=owned.database;save();
 assert(await dbConnection.initialize({host:'127.0.0.1',port:handle.port,user:'root',password:'',database:owned.database}));const pool=dbConnection.getPool()!;
 await new MigrationRunner(pool as any).run();
 await pool.query("INSERT INTO users(id,username,password_hash) VALUES(741,'identity-reader','no-login')");
 await pool.query("INSERT INTO roles(id,name) VALUES(741,'identity-reader')");
 const permissions=['instance:view','servers:view','network_devices:view'];
 for(const code of permissions)await pool.execute('INSERT IGNORE INTO permissions(code,name,resource,action) VALUES(?,?,?,?)',[code,code,...code.split(':')]);
 await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(741,741)');
 await pool.execute("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,status) VALUES(25,'protected-instance','fixture.invalid',3306,'reader','synthetic-secret','mysql','inactive')");
 await pool.execute("INSERT INTO servers(id,host,label,os_type,credential_type,credential_encrypted,status) VALUES(25,'fixture.invalid','protected-server','linux','password','synthetic-secret','offline')");
 await pool.execute("INSERT INTO network_devices(id,name,label,host) VALUES(25,'protected-network','protected-network','192.0.2.25')");
 const restore=async()=>{
  await pool.query("UPDATE users SET status='active',session_version=1 WHERE id=741");
  await pool.query('DELETE FROM role_permissions WHERE role_id=741');
  await pool.query(`INSERT INTO role_permissions(role_id,permission_id) SELECT 741,id FROM permissions WHERE code IN (${permissions.map(()=>'?').join(',')})`,permissions);
  await pool.query('DELETE FROM instance_permissions WHERE user_id=741');
  await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(741,25,'read-only')");
 };await restore();
 const secret=randomBytes(32).toString('hex'),token=signAccessToken(await actorContextService.loadActiveActor(741),secret),verify=createVerifyToken(secret);
 await registerInstanceListRoutes(app,verify);await registerResourceIdentityRoutes(app,verify);await registerNetworkDeviceRoutes(app,verify);
 await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as {port:number}).port;
 const targets=[
  {type:'instance',url:'/api/database/instances',service:instanceDatabaseService,detail:'getInstanceById',list:'getManagedInstances'},
  {type:'server',url:'/api/servers',service:serverDatabaseService,detail:'getServerById',list:'getAllServers'},
  {type:'network_device',url:'/api/network-devices',service:networkDeviceDatabaseService,detail:'getDeviceById',list:'getAllDevices'},
 ];
 for(const target of targets)for(const list of [false,true])for(const change of ['authorized','permission revoked','account disabled','session invalidated',...(target.type==='instance'?['ACL removed']:[])]){
  await restore();let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r);
  const service=target.service as any,method=list?target.list:target.detail,original=service[method];
  service[method]=async(...args:unknown[])=>{const rows=await original.apply(service,args);entered();await waiting;return rows;};
  const abort=new AbortController(),timer=setTimeout(()=>{release();abort.abort();},15000);
  try{
   const pending=fetch(`http://127.0.0.1:${port}${target.url}${list?'':'/25'}`,{headers:{authorization:`Bearer ${token}`,connection:'close'},signal:abort.signal});
   await Promise.race([started,new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>reject(Error('storage gate timeout')),{once:true}))]);
   if(change==='permission revoked')await pool.query('DELETE FROM role_permissions WHERE role_id=741');
   if(change==='account disabled')await pool.query("UPDATE users SET status='inactive' WHERE id=741");
   if(change==='session invalidated')await pool.query('UPDATE users SET session_version=2 WHERE id=741');
   if(change==='ACL removed')await pool.query('DELETE FROM instance_permissions WHERE user_id=741');
   release();const response=await pending,body=await response.text();
   const expected=change==='authorized'||(change==='ACL removed'&&list)?200:change==='account disabled'||change==='session invalidated'?401:403;
   assert.equal(response.status,expected,`${target.type}/${list}/${change}: ${body}`);
   assert(!body.includes('synthetic-secret'));
   if(change==='authorized')assert(body.includes('protected-'));
   else {assert(!body.includes('protected-'));if(change==='ACL removed'&&list)assert.deepEqual(JSON.parse(body),[]);}
   checks.push({type:target.type,read:list?'list':'detail',change,status:response.status,protectedIdentity:change==='authorized'});
  }finally{clearTimeout(timer);release();service[method]=original;}
 }
 console.log(JSON.stringify({checks:checks.length,status:'passed'}));
}catch(error){failure=error instanceof Error?error.message:String(error);console.error(failure);process.exitCode=1;}
finally{
 app.server.closeAllConnections();await app.close();await dbConnection.close();
 if(owned){await owned.drop();cleanup='verified owned schema dropped';}
 if(root)await root.end();
 if(handle.container){assert.equal(docker('inspect','--format','{{index .Config.Labels "slide.max241.nonce"}}',handle.container),nonce);docker('stop',handle.container);cleanup+='; nonce-matching container stopped';}
 writeFileSync(join(directory,'result.json'),JSON.stringify({...handle,checks,failure,cleanup:cleanup+'; HTTP closed'},null,2));
 console.log('evidence '+directory);
}
