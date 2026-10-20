import {it} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {OperationsBudgetJournal} from './product-budget.js';
it('live process contention waits and stale locks remain fail closed',async()=>{const previousInfo=console.info;try{
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'max207-lock-'));
const file=path.join(dir,'product-llm.jsonl'),journal=new OperationsBudgetJournal(file);
const cases:string[]=[];
const children:Array<{c:any,ready:Promise<void>,done:Promise<any>}>=[];
function child(mode:string){
 const c=fork(fileURLToPath(new URL('./test-fixtures/product-budget-worker.ts',import.meta.url)),[file,mode],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
 let stderr='',result:any;c.stderr!.on('data',b=>stderr+=b);
 const ready=new Promise<void>(resolve=>c.once('message',()=>resolve()));
 c.on('message',(m:any)=>{if(m.operations)result=m;});
 const done=new Promise<any>((resolve,reject)=>c.once('exit',(code,signal)=>code===0?resolve(result):reject(Error(JSON.stringify({mode,code,signal,stderr})))));
 // Handle early rejection while another child completes.
 done.catch(()=>{});const handle={c,ready,done};children.push(handle);return handle;
}
try{
 journal.initialize();const initial=fs.readFileSync(file);
 const holder=child('hold');await holder.ready;
 const started=performance.now();const state=journal.read();await holder.done;
 assert(performance.now()-started>=100,'must wait for live holder');assert.equal(state.requests,0);assert.deepEqual(fs.readFileSync(file),initial);cases.push('live reader lock contention waits without journal mutation');
 const fd=fs.openSync(file+'.lock','wx',0o600),inode=fs.statSync(file+'.lock').ino;
 try{const begin=performance.now();assert.throws(()=>journal.read(),/LOCK_TIMEOUT/);assert(performance.now()-begin<6500);assert.equal(fs.statSync(file+'.lock').ino,inode);assert.deepEqual(fs.readFileSync(file),initial);cases.push('persistent lock fails bounded and retains exact holder lock');}finally{fs.closeSync(fd);fs.unlinkSync(file+'.lock');}
 const workers=[child('write'),child('read'),child('read'),child('read')];await Promise.all(workers.map(w=>w.ready));workers.forEach(w=>w.c.send('go'));const results=await Promise.all(workers.map(w=>w.done));assert(results.every(r=>r.operations===200));assert.equal(journal.read().usedTokens,600);assert.equal(journal.read().requests,200);cases.push('four real processes serialize 800 reads and reserve-settle cycles');
 const pending=journal.reserve(100,100);assert.throws(()=>journal.reserve(100,100),/USAGE_UNKNOWN/);assert.equal(journal.read().pending!.sequence,pending.sequence);journal.settle(pending.sequence,{inputTokens:1,outputTokens:1,cachedInputTokens:0});cases.push('unknown send remains fail-closed and never replayed');
 const raw=fs.readFileSync(file);fs.appendFileSync(file,'x');assert.throws(()=>journal.read(),/JOURNAL_INVALID/);fs.writeFileSync(file,raw);cases.push('integrity errors are not retried or suppressed');
 fs.unlinkSync(file);assert.throws(()=>journal.read(),/ENOENT/);assert(!fs.existsSync(file+'.lock'));cases.push('non-contention filesystem errors propagate and owned lock releases');
}finally{for(const child of children)if(child.c.exitCode===null&&child.c.signalCode===null)child.c.kill('SIGTERM');await Promise.allSettled(children.map(c=>c.done));fs.rmSync(dir,{recursive:true,force:true});}
}finally{console.info=previousInfo;}},20000);
