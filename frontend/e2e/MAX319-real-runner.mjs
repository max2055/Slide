import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, mkdirSync, writeFileSync } from 'node:fs';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import bcrypt from '../../apps/db-ops-api/node_modules/bcrypt/bcrypt.js';
const name = `slide-max319-real-${process.pid}`;
const targetHost = process.env.MAX319_TARGET_HOST;
if (!targetHost) throw new Error('MAX319_TARGET_HOST must be a local non-loopback IPv4 address reachable by the API');
const logDir = '.max319-runtime'; mkdirSync(logDir, {recursive:true});
const secret = () => randomBytes(24).toString('hex');
const children = [];
const run = (cmd,args,env=process.env,log) => new Promise((resolve,reject)=>{
 const child = spawn(cmd,args,{env,stdio:log?['ignore',openSync(log,'a'),openSync(log,'a')]:['ignore','pipe','pipe']}); let out='';let err='';
 child.stdout?.on('data',b=>out+=b); child.stderr?.on('data',b=>err+=b);
 child.on('error',reject);child.on('exit',code=>code===0?resolve(out.trim()):reject(new Error(`${cmd} exit ${code}: ${err.slice(-300)}`)));
});
const start = (cmd,args,env,log) => {const child=spawn(cmd,args,{env,stdio:['ignore',openSync(log,'a'),openSync(log,'a')]});children.push(child);return child;};
const ready = async url => {for(let i=0;i<90;i++){try{if((await fetch(url)).ok)return;}catch{} await new Promise(r=>setTimeout(r,500));}throw new Error('readiness timeout '+url);};
let db;
try {
 const rootPassword=secret();
 await run('docker',['run','--detach','--rm','--name',name,'--label','slide.task=MAX-319','--env','MYSQL_ROOT_PASSWORD','--publish',`${targetHost}::3306`,'mysql:8.4'],{...process.env,MYSQL_ROOT_PASSWORD:rootPassword});
 const port=Number((await run('docker',['port',name,'3306/tcp'])).split(':').at(-1));
 const env={...process.env,DB_HOST:targetHost,DB_PORT:String(port),DB_USER:'root',DB_PASSWORD:rootPassword,DB_NAME:'db_ops_ai_qualification_max319',ENCRYPTION_KEY:randomBytes(32).toString('hex'),JWT_SECRET_KEY:secret(),PORT:'3319',AGENT_WS_PORT:'29319',MAX319_REAL:'1',MAX319_TARGET_HOST:targetHost,MAX319_SAVED_PASSWORD:secret(),MAX319_TEST_PASSWORD:secret(),MAX319_ADMIN_PASSWORD:secret(),MAX319_BASE_URL:'http://127.0.0.1:5319',VITE_API_PROXY_TARGET:'http://127.0.0.1:3319',VITE_AGENT_WS_PROXY_TARGET:'http://127.0.0.1:29319',VITE_AGENT_WS_URL:'ws://127.0.0.1:29319',QUALIFICATION_CANCELLABLE_LLM_PORT:'29320'};
 for(let i=0;i<90;i++){try{db=await mysql.createConnection({host:env.DB_HOST,port,user:'root',password:rootPassword,connectTimeout:2000});break;}catch{await new Promise(r=>setTimeout(r,500));}}
 if(!db)throw new Error('mysql readiness timeout');
 await run('pnpm',['--filter','slide-api','exec','tsx','init-db.ts'],env,`${logDir}/init.log`);
 await db.query(`USE ${env.DB_NAME}`);
 await db.execute("UPDATE users SET password_hash=? WHERE username='admin'",[await bcrypt.hash(env.MAX319_ADMIN_PASSWORD,12)]);
 await db.query("INSERT IGNORE INTO user_roles (user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
 await db.query('CREATE DATABASE max319_target');
 await db.query("CREATE USER 'max319_target'@'%' IDENTIFIED BY ?",[env.MAX319_SAVED_PASSWORD]);
 await db.query("ALTER USER 'max319_target'@'%' IDENTIFIED BY ? RETAIN CURRENT PASSWORD",[env.MAX319_TEST_PASSWORD]);
 await db.query("GRANT SELECT ON max319_target.* TO 'max319_target'@'%'");
 for(const password of [env.MAX319_SAVED_PASSWORD,env.MAX319_TEST_PASSWORD]){const c=await mysql.createConnection({host:env.DB_HOST,port,user:'max319_target',password,database:'max319_target'});await c.query('SELECT 1');await c.end();}
 await run('pnpm',['--filter','slide-api','exec','tsx','../../scripts/qualification/configure-cancellable-provider.ts'],env,`${logDir}/provider.log`);
 // Loopback provider is deliberately unavailable; this acceptance must never send a model request.
 const server=spawn(process.execPath,['--import','tsx','server.ts'],{cwd:'apps/db-ops-api',env,stdio:['ignore',openSync(`${logDir}/api.log`,'a'),openSync(`${logDir}/api.log`,'a')]});children.push(server);
 await ready('http://127.0.0.1:3319/api/health/ready');
 start(process.execPath,['frontend/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5319','--strictPort','frontend'],env,`${logDir}/vite.log`);
 await ready(env.MAX319_BASE_URL);
 writeFileSync(`${logDir}/ownership.json`,JSON.stringify({task:'MAX-319',container:name,port,apiPid:server.pid,frontendPid:children.at(-1).pid,cwd:process.cwd(),branch:'agent/15coder1/max-319',logs:logDir},null,2));
 console.log('MAX319 resources', JSON.stringify({container:name,port,apiPid:server.pid,frontendPid:children.at(-1).pid}));
 await run('pnpm',['--filter','slide-frontend','exec','playwright','test','--config','playwright.MAX319.config.ts'],env,`${logDir}/playwright.log`);
 console.log('MAX319 real business acceptance PASS; model calls 0');
} catch(error){console.error(error.message);process.exitCode=1;}
finally {
 await db?.end();
 for(const child of children.reverse()){if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,10000))]);}}
 try{await run('docker',['stop','--timeout','10',name]);console.log('MAX319 container cleaned');}catch(error){console.error(error.message);process.exitCode=1;}
}
