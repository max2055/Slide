import { expect, it } from 'vitest';
import { AgentRunner, NoopHook, ToolRegistry, type AgentRunSpec, type LLMProvider, type LLMResponse } from '@slide/agent-core';
import { resolveRuntimePolicy, runtimeSpec } from '../runtime-policy.js';

const answer: LLMResponse = { content: 'Inspection complete.', finishReason: 'stop', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2 }, hasToolCalls: false, shouldExecuteTools: false };

// MAX-477/#691: production long-chat policy -> AgentRunner.run -> TurnLoop ->
// ToolExecutor. Controlled Provider, real safe in-process tool, no external LLM.
it('credits over 256 results, restores bounded checkpoints, and preserves stagnation/tool limits', async () => {
  const policy = resolveRuntimePolicy('chat', { env: { AGENT_RUNTIME_LONG_CHAT: 'true' } });
  expect(policy.budgetLimits).toMatchObject({ maxToolCalls: 500, maxNoProgressSteps: 12 });
  const tools = new ToolRegistry();
  let executions = 0;
  tools.register({ name: 'inspect', description: 'Read a controlled sample', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false,
    execute: async args => { executions++; return { value: args.n }; } });
  let mode: 'unique' | 'repeat' | 'finish' = 'unique';
  let n = 0;
  const checkpoints: NonNullable<AgentRunSpec['resumeCheckpoint']>[] = [];
  const chat: LLMProvider['chat'] = async () => {
    if (mode === 'finish') return answer;
    const current = mode === 'repeat' ? n - 1 : n++;
    return { ...answer, content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true,
      toolCalls: [{ id: `sample-${executions}`, name: 'inspect', arguments: { n: current } }] };
  };
  const provider: LLMProvider = { getDefaultModel: () => 'controlled', chat, chatStream: (m, t, _c, o) => chat(m, t, o) };
  const config: AgentRunSpec = { ...runtimeSpec(policy), tools, model: 'controlled', hook: new NoopHook(), loopGuardThreshold: 1000,
    initialMessages: [{ role: 'user', content: 'Inspect the controlled samples.' }], contextWindowTokens: 200_000, maxTokens: 100, maxToolResultChars: 1000,
    checkpointCallback: async checkpoint => {
      const state = checkpoint.runtime_state_v1;
      if (state) {
        const snapshot = structuredClone(state);
        expect((snapshot as { progressEvidence?: string[] }).progressEvidence?.length ?? 0).toBeLessThanOrEqual(256);
        checkpoints.push({ runtime_state_v1: snapshot });
      }
      if (executions === 280) mode = 'finish';
    } };
  const result = await new AgentRunner(provider).run(config);
  expect(result.stopReason, JSON.stringify({ error: result.error, resolution: result.resolution })).toBe('completed');
  expect(executions).toBe(280);
  expect(result.runtimeState).toMatchObject({ toolCalls: 280, noProgressSteps: 1 });
  expect(result.runtimeState!.progressEvidence).toHaveLength(256);
  expect(result.runtimeState!.progressEvidence!.every(h => /^[a-f0-9]{64}$/.test(h))).toBe(true);

  mode = 'repeat';
  const repeated = await new AgentRunner(provider).run({ ...config, checkpointCallback: undefined, resumeCheckpoint: checkpoints.at(-1) });
  expect(repeated.resolution?.reasonCode).toBe('NO_PROGRESS');
  expect(repeated.runtimeState!.toolCalls - 280).toBeLessThanOrEqual(12);

  // Existing pre-fix 256-entry snapshots remain valid; new evidence must evict.
  mode = 'unique';
  const legacyState = { ...result.runtimeState!, toolCalls: 499, noProgressSteps: 0, progressEvidence: Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(64, '0')) };
  const before = executions;
  const limited = await new AgentRunner(provider).run({ ...config, checkpointCallback: undefined, resumeCheckpoint: { runtime_state_v1: legacyState } });
  expect(limited.resolution?.reasonCode).toBe('MAX_TOOL_CALLS');
  expect(executions - before).toBe(1);
  expect(limited.runtimeState!.progressEvidence).toHaveLength(256);
}, 120_000);
