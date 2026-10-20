import fs from 'node:fs';
import {OperationsBudgetJournal} from '../product-budget.js';
const [file,mode]=process.argv.slice(2);
const journal=new OperationsBudgetJournal(file);
if(mode==='disposition'){
 try {(journal as any).conservativelyAccountAuthorizedUnknown('01a156ae-9f84-7acd-b1a5-a48bed356da9');process.send!({ok:true});}catch(error){process.send!({ok:false,error:String(error)});}
}else if(mode==='hold'){
 const fd=fs.openSync(file+'.lock','wx',0o600);process.send!({ready:true});
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
 fs.closeSync(fd);fs.unlinkSync(file+'.lock');
}else{
 process.send!({ready:true});await new Promise<void>(r=>process.once('message',()=>r()));
 let operations=0;
 for(let i=0;i<200;i++){
  if(mode==='write'){const send=journal.reserve(100,100);journal.settle(send.sequence,{inputTokens:2,outputTokens:1,cachedInputTokens:0});}
  else journal.read();
  operations++;
 }
 process.send!({operations});
}
