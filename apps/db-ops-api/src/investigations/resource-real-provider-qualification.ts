/** Opt-in T10 browser qualification. SELECT-only shared configuration; synthetic targets;
 * one linked scene of the existing T09-System-V1 ledger. Never production-imported. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import type { LLMProvider } from '@slide/agent-core';
import { llmDatabaseService } from '../llm-database-service.js';
import { decryptData } from '../db-connection.js';
import { createConfiguredAgentProvider } from '../adapter/llm-provider-factory.js';
import { SYSTEM_BATCH_LEDGER, SYSTEM_STANDING_AUTHORIZATION, initializeSystemJournal,
  readSystemJournal, reserveSystemSend, receiveSystemUsage, stopSystemSends } from './system-real-provider-budget.js';

export async function resourceQualificationProvider() {
  assert(process.env.T10_CONFIG_ENV && process.env.T10_REAL_JOURNAL && process.env.T10_REAL_EVIDENCE,'T10_EXPLICIT_PATHS_REQUIRED');
  config({path:process.env.T10_CONFIG_ENV,quiet:true});
  const shared=mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT??3306),user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,database:process.env.DB_NAME??'db_ops_ai'});
  let provider: LLMProvider;
  let outputCeiling=0, key='';
  try {
    const select={execute:async(sql:string,values?:any[])=>{assert(/^SELECT\s/i.test(sql),'T10_SHARED_WRITE_FORBIDDEN');return shared.execute(sql,values);}};
    const stored=(await llmDatabaseService.getAllProviders(select as never)).find(p=>p.enabled&&p.is_default);
    assert(stored?.name==='deepseek'&&stored.default_model==='deepseek-flash'&&stored.api_base_url==='https://api.deepseek.com/v1'
      &&stored.api_format==='openai-completions'&&stored.supports_function_call&&stored.api_key_encrypted,'T10_PROVIDER_CONFIGURATION_CHANGED');
    const bindings=await llmDatabaseService.getSceneBindings(select as never);assert.equal(bindings.length,0);
    key=decryptData(stored.api_key_encrypted!);outputCeiling=Math.min(stored.max_tokens!,2048);
    assert(Number.isSafeInteger(outputCeiling)&&outputCeiling>0);
    provider=await createConfiguredAgentProvider({getAllProviders:async()=>[{...stored,max_tokens:outputCeiling}],getSceneBindings:async()=>bindings,
      getProviderApiKey:async(name)=>{assert.equal(name,stored.name);return key;}},'fault_diagnosis',true,false);
  } finally {await shared.end();}
  const journal=resolve(process.env.T10_REAL_JOURNAL!),evidence=resolve(process.env.T10_REAL_EVIDENCE!);
  const pointer=JSON.parse(readFileSync(SYSTEM_BATCH_LEDGER,'utf8'));
  const previous=readSystemJournal(pointer.activeJournal);
  assert(previous.stopped&&!previous.pending&&previous.batch?.reservedTokens===0,'T10_PRIOR_SCENE_UNCERTAIN');
  assert.equal(createHash('sha256').update(readFileSync(pointer.activeJournal)).digest('hex'),pointer.sha256);
  mkdirSync(dirname(journal),{recursive:true,mode:0o700});mkdirSync(dirname(evidence),{recursive:true,mode:0o700});
  initializeSystemJournal(journal,{authorization:SYSTEM_STANDING_AUTHORIZATION,previousJournal:pointer.activeJournal});
  const record=(value:unknown)=>appendFileSync(evidence,JSON.stringify(value)+'\n',{mode:0o600});
  record({configuration:{model:provider!.getDefaultModel(),outputCeiling,sharedWrites:0},baseline:previous,initialized:readSystemJournal(journal)});
  const client=(provider! as any).client as {fetch:typeof fetch;maxRetries:number};assert.equal(client.maxRetries,0);
  const originalFetch=client.fetch;
  client.fetch=async(input,init)=>{
    const request=new Request(input,init),bodyText=await request.clone().text(),body=JSON.parse(bodyText);
    assert.equal(request.url,'https://api.deepseek.com/v1/chat/completions');assert.equal(request.method,'POST');assert.equal(body.model,'deepseek-flash');assert(!body.stream);
    assert(!bodyText.includes(key),'T10_SECRET_IN_BODY');assert(Number.isSafeInteger(body.max_tokens)&&body.max_tokens>0&&body.max_tokens<=outputCeiling);
    const send=reserveSystemSend(journal,Buffer.byteLength(bodyText)+1024,body.max_tokens);
    record({sequence:send.sequence,requestHash:createHash('sha256').update(bodyText).digest('hex'),requestBytes:Buffer.byteLength(bodyText),
      toolResults:body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>({toolCallId:m.tool_call_id,content:m.content})),budget:readSystemJournal(journal)});
    try {
      const response=await originalFetch(input,{...init,redirect:'error'});
      if(!response.ok)throw Error(`PROVIDER_HTTP_${response.status}`);
      const raw=await response.clone().json() as any;
      const usage=receiveSystemUsage(journal,send.sequence!,{inputTokens:raw.usage?.prompt_tokens,outputTokens:raw.usage?.completion_tokens,
        cachedInputTokens:raw.usage?.prompt_cache_hit_tokens??raw.usage?.prompt_tokens_details?.cached_tokens??0});
      assert(raw.choices?.length===1&&['stop','tool_calls'].includes(raw.choices[0].finish_reason),'T10_PROVIDER_PROTOCOL');
      record({sequence:send.sequence,usage:raw.usage,choice:raw.choices[0],budget:usage});return response;
    }catch(error){const reason=error instanceof Error&&/^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)?error.message:'T10_PROVIDER_UNCERTAIN';
      stopSystemSends(journal,reason);throw Error(reason);}
  };
  return {provider:provider!,journal,evidence,finish:()=>{stopSystemSends(journal,'T10_RESOURCE_QUALIFICATION_FINISHED');const state=readSystemJournal(journal);record({finished:true,state});return state;}};
}
