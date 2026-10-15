// MAX-174 opt-in qualification; continues the existing MAX-155 batch journal.
// Adapted from the audited MAX-160 qualification transport; SELECT-only shared configuration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createConfiguredAgentProvider } from '../../apps/db-ops-api/src/adapter/llm-provider-factory.ts';
import { llmDatabaseService } from '../../apps/db-ops-api/src/llm-database-service.ts';
import { decryptData } from '../../apps/db-ops-api/src/db-connection.ts';
import { selectSceneModel } from '../../apps/db-ops-api/src/llm/scene-routing.ts';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const { config } = require('dotenv');
export const batchLimit = 10_000_000;
export const authorization = '01a13d70-ceb6-7c62-bb16-c445e3c03daf';
export const journal = resolve(homedir(), '.slide/qualification/MAX-157-real-model.jsonl');
const sync = (value: any, flag = 'a') => {
  const fd = openSync(journal, flag, 0o600);
  try { writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
};
const lock = <T>(action: () => T): T => {
  const fd = openSync(journal + '.lock', 'wx', 0o600);
  try { return action(); } finally { closeSync(fd); unlinkSync(journal + '.lock'); }
};
export function budgetState() {
  const entries = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries[0].authorization, authorization);
  assert.equal(entries[0].limit, batchLimit);
  let pending: any, stopped = false, requests = 0, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0;
  for (const entry of entries.slice(1)) {
    if (entry.kind === 'send') {
      assert(!stopped && !pending && entry.sequence === requests + 1, 'JOURNAL_SEQUENCE_INVALID');
      pending = entry; requests++;
    } else if (entry.kind === 'receipt') {
      assert(pending && pending.sequence === entry.sequence, 'JOURNAL_RECEIPT_INVALID');
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens']) assert(Number.isSafeInteger(entry[field]) && entry[field] >= 0);
      assert(entry.cachedInputTokens <= entry.inputTokens);
      inputTokens += entry.inputTokens; outputTokens += entry.outputTokens; cachedInputTokens += entry.cachedInputTokens;
      pending = undefined;
    } else if (entry.kind === 'stop') stopped = true;
    else assert.equal(entry.kind, 'checkpoint');
  }
  const totalTokens = inputTokens + outputTokens;
  const reservedTokens = pending ? pending.inputUpperBound + pending.outputCeiling : 0;
  return { authorization, batchLimit, requests, inputTokens, outputTokens, cachedInputTokens, totalTokens, reservedTokens,
    remainingTokens: Math.max(0, batchLimit - totalTokens - reservedTokens), pending, stopped,
    phase: totalTokens >= batchLimit ? 'stop' : totalTokens >= batchLimit * .8 ? 'converge' : totalTokens >= batchLimit * .5 ? 'report' : 'normal' };
}
export async function configuredProvider(output: string) {
  const isolatedCeiling = 4096;
  assert([4096,8192].includes(isolatedCeiling));
  assert(process.env.MAX174_CONFIG_ENV, 'MAX174_CONFIG_ENV_REQUIRED');
  config({ path: process.env.MAX174_CONFIG_ENV, quiet: true });
  assert.equal(Number(process.env.DB_PORT ?? 3306), 3306, 'MYSQL_3306_REQUIRED');
  const shared = mysql.createPool({ host: process.env.DB_HOST, port: 3306, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  let providers: any[], bindings: any[], chosen: any, key = '', provider: any;
  try {
    const select = { execute: async (sql: string, values?: any[]) => {
      assert(/^SELECT\s/i.test(sql), 'SHARED_WRITE_FORBIDDEN'); return shared.execute(sql, values);
    } };
    providers = await llmDatabaseService.getAllProviders(select as any);
    bindings = await llmDatabaseService.getSceneBindings(select as any);
    chosen = selectSceneModel(providers, bindings, 'fault_diagnosis', { requiresFunctionCall: true });
    assert(chosen.provider.api_key_encrypted, 'PROVIDER_KEY_UNAVAILABLE');
    assert.equal(chosen.model ?? chosen.provider.default_model, 'deepseek-flash');
    assert.equal(chosen.provider.max_tokens, 4096);
    providers = providers.map(p => p.id === chosen.provider.id ? {...p,max_tokens:isolatedCeiling} : p);
    chosen = {...chosen, provider: {...chosen.provider,max_tokens:isolatedCeiling}};
    key = decryptData(chosen.provider.api_key_encrypted);
    provider = await createConfiguredAgentProvider({ getAllProviders: async () => providers, getSceneBindings: async () => bindings,
      getProviderApiKey: async name => { assert.equal(name, chosen.provider.name); return key; } }, 'fault_diagnosis', true, false);
  } finally { await shared.end(); }
  const metadata = { ...chosen.provider }; delete metadata.api_key_encrypted;
  const configuration = { provider: metadata.name, model: provider.getDefaultModel(), source: chosen.source,
    configurationPort: 3306, sharedWrites: 0, outputCeiling: metadata.max_tokens, apiFormat: metadata.api_format };
  mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
  lock(() => {
    assert(existsSync(journal), 'EXISTING_BATCH_JOURNAL_REQUIRED');
    const state = budgetState(); assert(!state.pending && !state.stopped, 'BATCH_HISTORY_REQUIRES_DIAGNOSIS');
  });
  const receiptPath = resolve(output, 'transport-receipts.jsonl');
  mkdirSync(output, { recursive: true });
  const record = (value: any) => {
    const fd = openSync(receiptPath, 'a', 0o600);
    try { writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
  record({ configuration, baseline: budgetState() });
  const client = provider.client;
  assert(client?.maxRetries === 0 && typeof client.fetch === 'function', 'SUPPORTED_TRANSPORT_REQUIRED');
  const original = client.fetch;
  client.fetch = async (input: any, init: any) => {
    const request = new Request(input, init), bodyText = await request.clone().text(), body = JSON.parse(bodyText);
    assert(request.method === 'POST' && !body.stream && body.model === configuration.model, 'TRANSPORT_CONTRACT_INVALID');
    assert(!bodyText.includes(key), 'SECRET_IN_BODY');
    assert(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= metadata.max_tokens, 'OUTPUT_CEILING_INVALID');
    const send = lock(() => {
      const state = budgetState(), inputUpperBound = Buffer.byteLength(bodyText) + 1024;
      assert(!state.pending && !state.stopped, 'BATCH_HISTORY_REQUIRES_DIAGNOSIS');
      assert(state.totalTokens + inputUpperBound + body.max_tokens <= batchLimit, 'BATCH_LIMIT');
      const entry = { kind: 'send', sequence: state.requests + 1, inputUpperBound, outputCeiling: body.max_tokens,
        requestHash: createHash('sha256').update(bodyText).digest('hex') };
      sync(entry); record({ ...entry, state: budgetState() }); return entry;
    });
    const start = performance.now();
    try {
      const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
      const response = await original(input, { ...init, redirect: 'error', signal });
      if (!response.ok) throw Error(`PROVIDER_HTTP_${response.status}`);
      const raw = await response.clone().json();
      record({sequence:send.sequence,responseSegments:raw.choices?.map((c:any)=>({finish:c.finish_reason,contentBytes:Buffer.byteLength(c.message?.content??''),reasoningBytes:Buffer.byteLength(c.message?.reasoning_content??''),tools:c.message?.tool_calls?.map((t:any)=>{let parsed:any,parseError:string|null=null;try{parsed=JSON.parse(t.function.arguments);}catch{parseError='INVALID_JSON';}return {name:t.function.name,argumentBytes:Buffer.byteLength(t.function.arguments??''),parseError,envelopeKeys:parsed?.envelope?Object.keys(parsed.envelope):[],fieldBytes:parsed?.envelope?Object.fromEntries(Object.entries(parsed.envelope).map(([k,v])=>[k,Buffer.byteLength(JSON.stringify(v))])):{}};})}))});
      const usage = { inputTokens: raw.usage?.prompt_tokens, outputTokens: raw.usage?.completion_tokens,
        cachedInputTokens: raw.usage?.prompt_cache_hit_tokens ?? raw.usage?.prompt_tokens_details?.cached_tokens ?? 0 };
      for (const value of Object.values(usage)) assert(Number.isSafeInteger(value) && value >= 0, 'MEASURED_USAGE_REQUIRED');
      assert(usage.cachedInputTokens <= usage.inputTokens && usage.inputTokens <= send.inputUpperBound && usage.outputTokens <= send.outputCeiling, 'USAGE_EXCEEDS_RESERVATION');
      assert(!JSON.stringify(raw.choices).includes(key), 'SECRET_IN_RESPONSE');
      lock(() => { assert.equal(budgetState().pending?.sequence, send.sequence); sync({ kind: 'receipt', sequence: send.sequence, ...usage }); });
      record({ sequence: send.sequence, status: response.status, responseId: raw.id, requestId: response.headers.get('x-request-id'),
        usage, finishReasons: raw.choices?.map((c: any) => c.finish_reason), toolNames: raw.choices?.flatMap((c: any) => c.message?.tool_calls?.map((t: any) => t.function.name) ?? []),
        elapsedMs: performance.now() - start, state: budgetState() });
      console.log(JSON.stringify({ kind: 'measured_model_receipt', sequence: send.sequence, usage, totalTokens: budgetState().totalTokens }));
      return response;
    } catch (error: any) {
      const reason = /^PROVIDER_HTTP_\d+$/.test(error?.message ?? '') ? error.message : 'PROVIDER_OR_USAGE_UNCERTAIN';
      lock(() => sync({ kind: 'stop', reason, sequence: send.sequence }));
      record({ sequence: send.sequence, reason, state: budgetState() }); throw Error(reason);
    }
  };
  provider.chatStream = async () => { throw Error('STREAM_OUTSIDE_QUALIFICATION'); };
  return { provider, configuration, metadata, bindings: bindings!, record,
    finish: () => { lock(() => sync({ kind: 'checkpoint', state: budgetState() })); return budgetState(); } };
}
