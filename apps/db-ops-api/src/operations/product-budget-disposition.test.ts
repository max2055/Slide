import {it} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {OperationsBudgetJournal} from './product-budget.js';
it.skipIf(!process.env.SLIDE_AUTHORIZED_PENDING_FIXTURE)('only the exact authorized unknown is conservatively appended once',async()=>{const previousInfo=console.info;try{
const authorization='01a156ae-9f84-7acd-b1a5-a48bed356da9';
const baseline=fs.readFileSync(process.env.SLIDE_AUTHORIZED_PENDING_FIXTURE!);
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(baseline),'6f071978def110c5645ba56529989381311149cb931c68d8be9233570e6f998b');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'max207-disposition-'));
const cases:string[]=[];
function fixture(name:string,raw=baseline){const file=path.join(dir,name);fs.writeFileSync(file,raw);fs.writeFileSync(file+'.sha256',hash(raw));return {file,journal:new OperationsBudgetJournal(file)};}
const apply=(j:any,id=authorization)=>j.conservativelyAccountAuthorizedUnknown(id);

try{
 const {file,journal}=fixture('main');
 assert.equal(typeof (journal as any).conservativelyAccountAuthorizedUnknown,'function','exact authorized unknown disposition is missing');
 assert.throws(()=>apply(journal,'wrong'),/AUTHORIZATION_INVALID/);assert.deepEqual(fs.readFileSync(file),baseline);cases.push('wrong or missing authorization leaves original bytes intact');
 const result=apply(journal);assert.equal(result.usedTokens,29618);assert.equal(result.measuredTokens,12397);assert.equal(result.conservativelyAccountedTokens,17221);assert.equal(result.requests,4);assert.equal(result.pending,null);assert.equal(result.reservedTokens,0);assert.equal(result.stopped,false);
 assert.deepEqual(fs.readFileSync(file).subarray(0,baseline.length),baseline);const audit=JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n').at(-1)!);assert.equal(audit.kind,'conservative-disposition');assert.equal(audit.noReplay,true);assert.equal(audit.actualUsageUnknown,true);assert(!('usage' in audit));cases.push('exact append preserves unknown history and separates measured from conservative totals');
 const accounted=fs.readFileSync(file);assert.throws(()=>apply(journal),/DISPOSITION_INVALID/);assert.deepEqual(fs.readFileSync(file),accounted);cases.push('duplicate disposition rejected without append');
 const next=journal.reserve(100,100);assert.equal(next.sequence,5);journal.settle(next.sequence,{inputTokens:20,outputTokens:10,cachedInputTokens:10});let state=journal.read();assert.equal(state.usedTokens,29648);assert.equal(state.measuredTokens,12427);assert.equal(state.conservativelyAccountedTokens,17221);cases.push('fresh send retains cumulative accounting and cached input stays a subset');
 const unknown=journal.reserve(100,100);assert.throws(()=>journal.settle(unknown.sequence,null),/USAGE_UNKNOWN/);assert.throws(()=>journal.reserve(1,1),/STOPPED/);assert.throws(()=>apply(journal),/DISPOSITION_INVALID/);cases.push('a later unknown send remains stopped and cannot reuse this authorization');
 for(const [name,from,to] of [['sequence','"sequence":4','"sequence":5'],['bound','15173','15174'],['time','00:13:24.133Z','00:13:24.134Z'],['stop','USAGE_UNKNOWN','BOUND_EXCEEDED'],['usage','"inputTokens":1397','"inputTokens":1398']]){
  const f=fixture(name,Buffer.from(baseline.toString().replace(from,to)));assert.throws(()=>apply(f.journal));assert.equal(fs.readFileSync(f.file,'utf8'),baseline.toString().replace(from,to));
 }cases.push('wrong sequence bound timestamp stop and prior usage all rejected');
 for(const field of ['sequence','tokens','authorizationCommentId','priorJournalSha256','noReplay','actualUsageUnknown']){
  const bad={...audit,[field]:field==='sequence'?5:field==='tokens'?17220:field==='noReplay'||field==='actualUsageUnknown'?false:'wrong'};
  const f=fixture('audit-'+field,Buffer.concat([baseline,Buffer.from(JSON.stringify(bad)+'\n')]));assert.throws(()=>f.journal.read(),/JOURNAL_INVALID/);
 }cases.push('persisted disposition validates every authorization and noReplay binding');
 const crash=fixture('crash');fs.writeFileSync(crash.file+'.sha256.next','held');assert.throws(()=>apply(crash.journal),/EEXIST/);assert.deepEqual(fs.readFileSync(crash.file).subarray(0,baseline.length),baseline);assert.throws(()=>crash.journal.read(),/JOURNAL_INVALID/);assert(!fs.existsSync(crash.file+'.lock'));cases.push('append-pointer failure is fail closed without replay or automatic repair');
 const race=fixture('race');
 const launch=()=>new Promise<any>((resolve,reject)=>{const c=fork(new URL('./test-fixtures/product-budget-worker.ts',import.meta.url),[race.file,'disposition'],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});let reply:any,stderr='';c.on('message',m=>reply=m);c.stderr!.on('data',b=>stderr+=b);c.on('error',reject);c.on('exit',code=>code===0?resolve(reply):reject(Error(stderr)));});
 const concurrent=await Promise.all([launch(),launch()]);assert.equal(concurrent.filter(r=>r.ok).length,1);assert.equal(race.journal.read().usedTokens,29618);assert.equal(fs.readFileSync(race.file,'utf8').trim().split('\n').length,10);cases.push('two actual processes account once under the original exclusive lock');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
}finally{console.info=previousInfo;}},20000);
