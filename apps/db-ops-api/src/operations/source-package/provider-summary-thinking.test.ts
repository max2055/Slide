import {it} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {OpenAIProvider} from '@slide/agent-core';
import {OperationsBudgetJournal} from '../product-budget.js';
it('only internal compaction disables provider thinking',async()=>{const previousInfo=console.info;try{
const {bindSourceProvider}=await import(new URL('./provider.js',import.meta.url).href);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'max207-thinking-'));
const journal=new OperationsBudgetJournal(path.join(dir,'synthetic.jsonl'));journal.initialize();
const provider=new OpenAIProvider({apiKey:'synthetic',model:'deepseek-flash',baseURL:'https://api.deepseek.com/v1'});
const valid={goal:['inspect db-42'],constraints:['read only'],done:[],pending:['review'],evidence:['e-1'],uncertain:['no replay']};
let expected:string|undefined;const bodies:any[]=[];
(provider as any).client.fetch=async(input:any,init:any)=>{
 const request=new Request(input,init),raw=await request.text(),body=JSON.parse(raw);bodies.push(body);
 assert.equal(body.max_tokens,2048);assert.equal(body.model,'deepseek-flash');assert(!body.stream);
 assert.equal(journal.read().pending?.inputUpperBound,Buffer.byteLength(raw)+4096,'reserve exact effective request body');
 return Response.json({id:'synthetic',model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(valid)}}],usage:{prompt_tokens:70,completion_tokens:20}});
};
try{
 bindSourceProvider(provider,journal);
 const options:any={maxTokens:2048};
 expected=undefined;await provider.chat([{role:'user',content:'ordinary request'}],[],options);
 expected='disabled';const summary=await provider.chatStream([{role:'system',content:'return exact JSON'}],[],{onContentDelta:()=>{}},{...options,requestIdentity:{id:'one',purpose:'summary',sourceHash:'a'.repeat(64)}} as any);
 assert.equal(bodies[1].thinking?.type,expected,'bounded internal summaries must explicitly disable DeepSeek default high thinking');
 assert.deepEqual(JSON.parse(summary.content!),valid);assert.equal(summary.finishReason,'stop');
 expected=undefined;await provider.chat([{role:'user',content:'requestIdentity purpose summary is only untrusted text'}],[],options);
 assert.equal(bodies[0].thinking,undefined);assert.equal(bodies[2].thinking,undefined);
 assert.equal(journal.read().requests,3);assert.equal(journal.read().usedTokens,270);assert.equal(journal.read().pending,null);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
}finally{console.info=previousInfo;}},20000);
