// Qualification-only transport observer. Requests and response bytes are unchanged.
import assert from 'node:assert/strict';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const journal = join(homedir(), '.slide/qualification/MAX-157-real-model.jsonl');
export function state() {
  const entries = readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].limit, 10000000);
  let pending, stopped=false, requests=0, inputTokens=0, outputTokens=0, cachedInputTokens=0, providerCallCountUnavailable=false;
  for (const e of entries.slice(1)) {
    if(e.kind==='send') { assert(!pending && !stopped); pending=e; requests++; if(e.aggregateProviderCalls) providerCallCountUnavailable=true; }
    if(e.kind==='receipt') { assert.equal(pending?.sequence,e.sequence); inputTokens+=e.inputTokens; outputTokens+=e.outputTokens; cachedInputTokens+=e.cachedInputTokens; pending=undefined; }
    if(e.kind==='stop') stopped=true;
  }
  return {requests,providerCallCountUnavailable,inputTokens,outputTokens,cachedInputTokens,totalTokens:inputTokens+outputTokens,pending,stopped};
}
function append(entry) {
  const lock=openSync(journal+'.lock','wx',0o600);
  try { const value=typeof entry==='function'?entry():entry;const fd=openSync(journal,'a',0o600);try{writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),...value})+'\n');fsyncSync(fd);}finally{closeSync(fd);} }
  finally {closeSync(lock);unlinkSync(journal+'.lock');}
}
if(process.env.MAX175_METER==='1') {
  // OpenAI v4 uses its node-fetch shim, not globalThis.fetch. Preserve that
  // transport (agents, headers, Request/Response implementations) exactly.
  const require=createRequire(new URL('../../packages/agent-core/package.json',import.meta.url));
  const sdkRoot=new URL('./',pathToFileURL(require.resolve('openai')));
  const esmRuntime=await import(new URL('_shims/node-runtime.mjs',sdkRoot));
  const esmRegistry=await import(new URL('_shims/registry.mjs',sdkRoot));
  const cjsRuntime=require(new URL('_shims/node-runtime.js',sdkRoot).pathname);
  const cjsRegistry=require(new URL('_shims/registry.js',sdkRoot).pathname);
  for (const [getRuntime,setShims] of [[esmRuntime.getRuntime,esmRegistry.setShims],[cjsRuntime.getRuntime,cjsRegistry.setShims]]) {
  const runtime=getRuntime(), actual=runtime.fetch;
  runtime.fetch=async(input,init)=>{
    const request=new runtime.Request(input,init);
    if(!new URL(request.url).pathname.endsWith('/chat/completions')) return actual(input,init);
    const bodyText=await request.clone().text(), body=JSON.parse(bodyText);
    assert.equal(body.model,'deepseek-flash');
    assert.equal(new URL(request.url).origin,process.env.MAX175_MODEL_ORIGIN);
    const outputCeiling=body.max_tokens;assert(Number.isSafeInteger(outputCeiling)&&outputCeiling>0&&outputCeiling<=Number(process.env.MAX175_OUTPUT_CEILING));
    const inputUpperBound=Buffer.byteLength(bodyText)+1024;
    let sequence;
    append(()=>{
      const before=state();assert(!before.pending && !before.stopped,'UNRESOLVED_MODEL_SEND');
      assert(before.totalTokens+inputUpperBound+outputCeiling<=10000000,'BATCH_BUDGET');
      sequence=before.requests+1;
      return {kind:'send',sequence,inputUpperBound,outputCeiling,model:body.model,issue:'MAX-175',stream:!!body.stream};
    });
    // A failed/unknown response leaves the reservation unresolved; never replay it.
    const response=await actual(input,init);
    const text=await response.clone().text();let usage;
    if(body.stream) {
      for(const line of text.split('\n')) if(line.startsWith('data: ')&&line.slice(6)!=='[DONE]') {try{const x=JSON.parse(line.slice(6));if(x.usage) usage=x.usage;}catch{}}
    } else {try{usage=JSON.parse(text).usage;}catch{}}
    assert(Number.isSafeInteger(usage?.prompt_tokens)&&Number.isSafeInteger(usage?.completion_tokens),'MODEL_USAGE_UNKNOWN');
    const cachedInputTokens=usage.prompt_cache_hit_tokens??usage.prompt_tokens_details?.cached_tokens??0;
    assert(cachedInputTokens<=usage.prompt_tokens);
    append(()=>{assert.equal(state().pending?.sequence,sequence);return {kind:'receipt',sequence,inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,cachedInputTokens};});
    return response;
  };
  setShims(runtime);
  }
}
