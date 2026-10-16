// Runs alongside the opt-in formal-chain fixture, against its explicit disposable schema.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
const require=createRequire(resolve('apps/db-ops-api/package.json'));
const {chromium,expect}=createRequire(resolve('frontend/package.json'))('@playwright/test');
const mysql=require('mysql2/promise'),bcrypt=require('bcrypt');
const schema=process.env.MAX175_CHECK_SCHEMA!,output=process.env.MAX175_OUTPUT_DIR!;
assert(/^db_ops_ai_qualification_max175_r10_\d+$/.test(schema));assert(output);
const api='http://127.0.0.1:3175',site='http://127.0.0.1:5195';
const result:any={source:'real isolated HTTP/JWT and controlled unreachable task target',schema,http:[]};
await mkdir(output,{recursive:true});
const until=Date.now()+360000;
while(true){try{if((await fetch(site)).status===200&&(await fetch(api+'/api/health/ready')).status===200)break;}catch{}assert(Date.now()<until,'TASK_NOT_READY');await new Promise(ok=>setTimeout(ok,1000));}
const pool=mysql.createPool({host:process.env.MAX175_TARGET_HOST,port:33176,user:'root',password:process.env.MAX175_DB_PASSWORD,database:schema});
let browser:any,userId:number|undefined;
try{
  const pass=randomBytes(24).toString('hex'),username=`max175_permissions_${process.pid}`;
  const [u]=await pool.query("INSERT INTO users(username,email,password_hash,status) VALUES(?,?,?,'active')",[username,username+'@example.invalid',await bcrypt.hash(pass,10)]);userId=u.insertId;
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'",[userId]);
  const login=await fetch(api+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:pass})});assert.equal(login.status,200);const token=(await login.json()).token;
  const call=async(path:string,body?:any)=>{const r=await fetch(api+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();result.http.push({path,status:r.status});return{status:r.status,value};};
  const permissions=(await call('/api/auth/permissions')).value;
  const [resources]=await pool.query("SELECT id FROM database_instances WHERE name='MAX-175 R10 readonly MySQL'");
  assert(resources.length===1,'PRIMARY_TASK_RESOURCE_NOT_READY');const primaryId=resources[0].id;
  const bad=await call('/api/database/instances',{name:'MAX-175 R10 unreachable controlled target',environment:'testing',db_type:'mysql',host:process.env.MAX175_TARGET_HOST,port:33177,username:'unreachable',password:randomBytes(24).toString('hex'),database_name:'unreachable'});assert.equal(bad.status,200);
  result.badResourceId=bad.value.id;
  result.badReload=await call(`/api/database/instances/${bad.value.id}/reload`,{});assert.equal(result.badReload.status,500);assert.equal(result.badReload.value.error,'INTERNAL_ERROR');
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:900}});
  await page.addInitScript(({token,permissions}:any)=>{localStorage.setItem('token',token);localStorage.setItem('slide.control.session_token.v1',token);localStorage.setItem('permissions',JSON.stringify(permissions));localStorage.setItem('slide.i18n.locale','zh-CN');},{token,permissions});
  await page.goto(`${site}/instance-detail?id=${bad.value.id}`);const detail=page.locator('instance-detail-page');await expect(detail).toContainText('MAX-175 R10 unreachable controlled target');
  await expect(detail).toContainText('当前证据不足以判断运行状态');await page.screenshot({path:`${output}/unreachable-real-390.png`,fullPage:true});result.failureNotHealthy=true;
  await page.goto(`${site}/instance-detail?id=${primaryId}`);await expect(detail).toContainText('MAX-175 R10 readonly MySQL');
  await pool.query('DELETE FROM user_roles WHERE user_id=?',[userId]);
  result.revokedGet=await call(`/api/database/instances/${primaryId}`);assert([403,404].includes(result.revokedGet.status));
  await detail.getByRole('button',{name:'刷新',exact:true}).click();await expect(detail).not.toContainText('MAX-175 R10 readonly MySQL');
  await page.screenshot({path:`${output}/revoked-real-390.png`,fullPage:true});result.revokedOldEvidenceCleared=true;
  const unauth=await fetch(api+`/api/database/instances/${primaryId}`);result.unauthStatus=unauth.status;assert.equal(unauth.status,401);
}finally{
  await browser?.close();
  if(userId){await pool.query('DELETE FROM user_roles WHERE user_id=?',[userId]);await pool.query('UPDATE users SET status=\'inactive\' WHERE id=?',[userId]);}
  await pool.end();await writeFile(`${output}/failure-permissions.json`,JSON.stringify(result,null,2));
}
