import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry } from '../../packages/agent-core/src/index.js';
import { AnthropicProvider } from '../../apps/db-ops-api/src/adapter/llm-provider.js';

// Explicit qualification variables only. Never discover credentials from production DB/files.
let missing = false;
for (const kind of ['ANTHROPIC', 'OPENAI', 'OLLAMA'] as const) {
  const prefix = `QUALIFICATION_${kind}_`;
  const model = process.env[`${prefix}MODEL`];
  const baseURL = process.env[`${prefix}BASE_URL`];
  const apiKey = process.env[`${prefix}API_KEY`];
  if (kind === 'OLLAMA' && process.env.QUALIFICATION_OLLAMA_DEPLOYED !== 'true') {
    console.log(JSON.stringify({ provider: kind, status: 'unverified', reason: 'deployment not declared' })); continue;
  }
  if (!model || !baseURL || (kind !== 'OLLAMA' && !apiKey)) {
    missing = true; console.log(JSON.stringify({ provider: kind, status: 'unverified', reason: 'explicit test connection missing' })); continue;
  }
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash) throw new Error('Qualification endpoint must not contain credentials or query parameters');
  const provider = kind === 'ANTHROPIC' ? new AnthropicProvider({ model, baseURL, apiKey })
    : new OpenAIProvider({ model, baseURL, apiKey: apiKey ?? 'ollama' });
  const requestIds: string[] = [];
  const chat = provider.chat.bind(provider);
  provider.chat = async (...args) => { const result = await chat(...args); if (result.requestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(result.requestId)) requestIds.push(result.requestId); return result; };
  const started = performance.now();
  const result = await new AgentRunner(provider).run({ initialMessages: [{ role: 'user', content: 'Explain briefly why SELECT 1 is a read-only database connectivity check. Do not execute anything.' }],
    tools: new ToolRegistry(), model, maxIterations: 3, maxTokens: 256, maxToolResultChars: 1000,
    temperature: 0, hook: new NoopHook(), runTimeoutMs: 60_000,
    budgetLimits: { maxToolCalls: 1, maxProviderAttempts: 3, maxTotalTokens: 20_000, maxNoProgressSteps: 3 }, contextWindowTokens: 4096 });
  const passed = result.stopReason === 'completed' && Boolean(result.finalContent?.trim()) && result.runtimeState?.unknownRequests === 0;
  console.log(JSON.stringify({ provider: kind, model, version: process.env[`${prefix}VERSION`] ?? 'unavailable',
    parameters: { temperature: 0, maxTokens: 256 }, requestIds, requestIdStatus: requestIds.length ? 'available' : 'unavailable',
    usage: result.usage, budget: result.runtimeState, elapsedMs: performance.now() - started, status: passed ? 'passed-representative-readonly' : 'failed',
    reasonCode: result.resolution?.reasonCode ?? null }));
  if (!passed) process.exitCode = 1;
}
if (missing && !process.exitCode) process.exitCode = 2;
