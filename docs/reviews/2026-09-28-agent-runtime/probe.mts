import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = process.env.SLIDE_REVIEW_ROOT;
if (!root) throw new Error('SLIDE_REVIEW_ROOT required');
const { AgentRunner, NoopHook } = await import(pathToFileURL(`${root}/packages/agent-core/src/runner.ts`).href);
const { ToolRegistry } = await import(pathToFileURL(`${root}/packages/agent-core/src/tool-registry.ts`).href);
const { loadAgentRuntimeLimits } = await import(pathToFileURL(`${root}/apps/db-ops-api/src/security/agent-runtime-limits.ts`).href);
function response(content: string, finishReason = 'stop') {
  return { content, finishReason, toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
const cases = [
  { name: 'repeated_text_accepted', responses: [response('正在分析数据库状态……\n'.repeat(20))] },
  { name: 'length_exhaustion_accepted', responses: [1,2,3,4].map(i => response(`截断片段${i}`, 'length')) },
  { name: 'continuation_final_drops_prefix', responses: [response('第一部分结论。', 'length'), response('第二部分结论。')] },
  { name: 'empty_finalization_length_bypasses_recovery', responses: [response(''), response(''), response('仍未完成的截断答案', 'length')] },
];
const observations = [];
for (const scenario of cases) {
  let requests = 0;
  const chat = async () => scenario.responses[Math.min(requests++, scenario.responses.length - 1)];
  const result = await new AgentRunner({ chat, chatStream: chat, getDefaultModel: () => 'fixture' }).run({
    initialMessages: [{ role: 'user', content: '诊断数据库并输出结论' }], tools: new ToolRegistry(), model: 'fixture',
    maxIterations: 10, maxToolResultChars: 1000, hook: new NoopHook(),
  });
  observations.push({ name: scenario.name, requests, stopReason: result.stopReason, error: result.error,
    finalContent: result.finalContent, assistantMessages: result.messages.filter(m => m.role === 'assistant').map(m => m.content) });
}
const saved = process.env.AGENT_RUN_TIMEOUT_MS;
delete process.env.AGENT_RUN_TIMEOUT_MS;
const defaultRunTimeoutMs = loadAgentRuntimeLimits().runTimeoutMs;
if (saved !== undefined) process.env.AGENT_RUN_TIMEOUT_MS = saved;
console.log(JSON.stringify({ baseline: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), defaultRunTimeoutMs, observations }, null, 2));
