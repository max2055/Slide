import {it} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {OpenAIProvider} from '@slide/agent-core';
import {OperationsBudgetJournal} from '../product-budget.js';
it('installed SDK node-fetch preserves effective summary transport and metering',async()=>{const previousInfo=console.info;try{
const {bindSourceProvider}=await import(new URL('./provider.js',import.meta.url).href);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'max207-nodefetch-'));
const journal=new OperationsBudgetJournal(path.join(dir,'synthetic.jsonl'));journal.initialize();
const provider=new OpenAIProvider({apiKey:'synthetic',model:'deepseek-flash',baseURL:'https://api.deepseek.com/v1'});
const client=(provider as any).client,transport=client.fetch.bind(client);let requests=0,cause:any,transportShape:any,observed:any;
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;
 requests++;const body=JSON.parse(raw);
 observed={length:Number(req.headers['content-length']),bytes:Buffer.byteLength(raw),thinking:body.thinking?.type};
 res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic',model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"goal":["inspect"],"constraints":[],"done":[],"pending":[],"evidence":[],"uncertain":[]}'}}],usage:{prompt_tokens:70,completion_tokens:20}}));
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as any;
try{
 client.fetch=async(input:any,init:any)=>{
  transportShape={type:typeof input,constructor:input?.constructor?.name};
  const local='http://127.0.0.1:'+address.port+'/v1/chat/completions';
  // Keep the real installed SDK transport and its input class. Route only to
  // loopback, so this test can never send to a product endpoint.
  const mapped=typeof input==='string'?local:new Request(local,{method:input.method,headers:input.headers,body:await input.clone().text()});
  try{return await transport(mapped,{...init,agent:undefined});}catch(error:any){cause={name:error.name,code:error.code,message:error.message};throw error;}
 };
 bindSourceProvider(provider,journal);
 const response=await provider.chat([],[],{maxTokens:2048,requestIdentity:{id:'one',purpose:'summary',sourceHash:'a'.repeat(64)}} as any);
 assert.equal(response.finishReason,'stop',JSON.stringify({cause,transportShape,requests}));assert.equal(requests,1);assert.equal(observed.length,observed.bytes);assert.equal(observed.thinking,'disabled');assert.equal(journal.read().pending,null);
}finally{await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});}
}finally{console.info=previousInfo;}},20000);
