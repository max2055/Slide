import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRunner, NoopHook, ToolRegistry } from '../../packages/agent-core/src/index.js';
import type { AgentRunSpec, LLMProvider, LLMResponse, RuntimeEvent } from '../../packages/agent-core/src/index.js';
import { detectTextRepetition, MAX_ANALYZED_CHARS } from '../../packages/agent-core/src/runtime/text-repetition.js';

const mode = process.argv[2] ?? 'deterministic';
const root = fileURLToPath(new URL('../..', import.meta.url));
const source = createHash('sha256');
for (const directory of ['packages/agent-core/src', 'apps/db-ops-api/src', 'tests/qualification', 'scripts/qualification']) {
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && /\.(?:ts|json|mjs|sh)$/.test(file)) source.update(relative(root, file)).update('\0').update(readFileSync(file));
  } };
  walk(resolve(root, directory));
}
console.log(JSON.stringify({ manifest: { pid: process.pid, cwd: process.cwd(), command: `agent-runtime.ts ${mode}`, sourceSha256: source.digest('hex'), node: process.version, log: process.env.QUALIFICATION_RUNTIME_LOG } }));

const ok = (content = '数据库连接正常。', finishReason = 'stop'): LLMResponse => ({ content, finishReason, toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 20 } });
const bad = '正在分析数据库状态……\n'.repeat(20);
const spec = (extra: Partial<AgentRunSpec> = {}): AgentRunSpec => ({ initialMessages: [{ role: 'user', content: '诊断数据库并输出结论' }], tools: new ToolRegistry(), model: 'controlled-fixture', maxIterations: 200, maxToolResultChars: 1000, hook: new NoopHook(),
  budgetLimits: { maxToolCalls: 500, maxProviderAttempts: 600, maxTotalTokens: 1_000_000, maxNoProgressSteps: 12 }, ...extra });
const provider = (chat: LLMProvider['chat']): LLMProvider => ({ getDefaultModel: () => 'controlled-fixture', chat, chatStream: (m,t,_c,o) => chat(m,t,o) });
async function replay(responses: LLMResponse[], extra: Partial<AgentRunSpec> = {}) {
  let requests = 0; const events: RuntimeEvent[] = []; const checkpoints: unknown[] = [];
  const result = await new AgentRunner(provider(async () => responses[Math.min(requests++, responses.length - 1)])).run(spec({
    onRuntimeEvent: e => { events.push(e); }, checkpointCallback: async c => { checkpoints.push(c); }, ...extra }));
  assert(!JSON.stringify(events).includes('诊断数据库'));
  return { result, requests, events, checkpoints };
}
async function deterministic() {
  const cases = [
    { name: 'repetition exhausted', responses: [ok(bad)], kind: 'failed', requests: 3 },
    { name: 'candidate recovery', responses: [ok(bad), ok()], kind: 'response_ready', requests: 2 },
    { name: 'length exhausted', responses: [ok('未完片段', 'length')], kind: 'partial', requests: 4 },
    { name: 'empty remedy length', responses: [ok(''), ok('甲', 'length'), ok('乙')], kind: 'response_ready', requests: 3 },
    { name: 'stream reset replay', responses: [{ ...ok(''), finishReason: 'error', error: 'reset', errorCode: 'ECONNRESET' }, ok()], kind: 'response_ready', requests: 2 },
    { name: 'auth never retries', responses: [{ ...ok(''), finishReason: 'error', providerStatus: 401, error: 'denied' }], kind: 'failed', requests: 1 },
  ];
  for (const c of cases) {
    const r = await replay(c.responses); assert.equal(r.result.resolution?.kind ?? (r.result.stopReason === 'completed' ? 'response_ready' : undefined), c.kind); assert.equal(r.requests, c.requests);
    assert(!JSON.stringify([r.result.messages, r.checkpoints]).includes('正在分析数据库状态'));
    if (c.name === 'empty remedy length') assert.equal(r.result.finalContent, '甲乙');
    console.log(JSON.stringify({ scenario: c.name, resolution: r.result.resolution?.kind, budget: r.result.runtimeState, events: r.events }));
  }
  const samples = JSON.parse(readFileSync(new URL('../../packages/agent-core/src/__tests__/fixtures/text-repetition.json', import.meta.url), 'utf8')) as Array<{ id: string; category: string; text: string; request: string; reject: boolean }>;
  const normal = samples.filter(s => !s.reject); assert(normal.length >= 200);
  const falseRejects = normal.filter(s => detectTextRepetition(s.text, s.request).repeated).length;
  const misses = samples.filter(s => s.reject && !detectTextRepetition(s.text, s.request).repeated).length;
  assert(falseRejects / normal.length <= .01); assert.equal(misses, 0);
  // This frozen corpus is offline evaluation, not production observe/enforce traffic.
  for (const sample of normal) { const r = await replay([ok(sample.text)], { initialMessages: [{ role: 'user', content: sample.request }] }); assert.equal(r.requests, 1); }
  const bench = Array.from({ length: 5000 }, (_, i) => `数据库对象${i}的采样值为${i * 17}。`).join('').padEnd(100_000, 'x').slice(0, 100_000);
  const durations: number[] = [];
  for (let i = 0; i < 110; i++) { const start = performance.now(); detectTextRepetition(bench); if (i >= 10) durations.push(performance.now() - start); }
  durations.sort((a,b) => a-b); const p95Ms = durations[Math.ceil(durations.length * .95) - 1]; assert(p95Ms < 50, `detector p95 ${p95Ms}ms`);
  for (const size of [100_000, 1_000_000, 10_000_000]) assert(detectTextRepetition('文'.repeat(size)).analyzedChars <= MAX_ANALYZED_CHARS);
  console.log(JSON.stringify({ mode, normal: normal.length, falseRejects, misses, extraNormalRequests: 0, benchmark: { chars: bench.length, samples: durations.length, p95Ms, cpu: cpus()[0].model, platform: platform(), release: release(), node: process.version }, productionRollout: 'unverified' }));
}
async function soak() {
  const durationSeconds = Number(process.argv[3] ?? 1800);
  assert(Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 3600);
  const started = Date.now(); let steps = 0; let active = 0; let peakActive = 0;
  const resources: Array<{ elapsed: number; heap: number; resources: number }> = [];
  const tools = new ToolRegistry();
  tools.register({ name: 'read_sample', description: 'Controlled read-only progress', readOnly: true, concurrencySafe: true, exclusive: false, parameters: { type: 'object', properties: {} }, execute: async args => ({ sample: args.n }) });
  const p = provider(async (_m,_t,o) => {
    active++; peakActive = Math.max(active, peakActive);
    try { await delay(durationSeconds * 1000 / 60, undefined, { signal: o?.signal }); }
    finally { active--; }
    steps++; resources.push({ elapsed: Date.now() - started, heap: process.memoryUsage().heapUsed, resources: process.getActiveResourcesInfo().length });
    if (steps % 2 === 0) console.log(JSON.stringify({ soakProgress: steps, ...resources.at(-1) }));
    return steps < 60 ? { ...ok(), content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true, toolCalls: [{ id: `read-${steps}`, name: 'read_sample', arguments: { n: steps } }] } : ok();
  });
  const result = await new AgentRunner(p).run(spec({ tools, llmTimeoutS: 60 }));
  assert.equal(result.stopReason, 'completed'); assert.equal(steps, 60); assert.equal(active, 0); assert.equal(peakActive, 1);
  const controller = new AbortController(); const cancel = new AgentRunner(p).run(spec({ signal: controller.signal }));
  controller.abort(); assert.equal((await cancel).stopReason, 'cancelled'); assert.equal(active, 0);
  const deadline = await new AgentRunner(p).run(spec({ runTimeoutMs: 20 })); assert.equal(deadline.resolution?.reasonCode, 'RUN_DEADLINE'); assert.equal(active, 0);
  const head = resources.slice(10, 20); const tail = resources.slice(-10);
  const max = (a: typeof resources, k: 'heap' | 'resources') => Math.max(...a.map(s => s[k]));
  assert(max(tail, 'resources') <= max(head, 'resources') + 2, 'active handles grew');
  assert(max(tail, 'heap') - max(head, 'heap') < 64 * 1024 * 1024, 'heap growth exceeds 64MiB envelope');
  console.log(JSON.stringify({ mode, qualification: durationSeconds >= 1800 ? '30-minute-controlled' : 'smoke-only', elapsedMs: Date.now() - started, steps, active, peakActive, resources, budget: result.runtimeState }));
}
if (mode === 'deterministic') await deterministic();
else if (mode === 'soak') await soak();
else if (mode === 'provider') await import('./agent-runtime-provider.js');
else if (mode === 'mysql') await import('./agent-runtime-mysql.js');
else throw new Error('Unknown qualification mode');
