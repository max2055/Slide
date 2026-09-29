import { expect, it } from 'vitest';
import { resolveRuntimePolicy } from './runtime-policy.js';
it.each([
  ['chat', 120000, 40], ['invoke', 120000, 8], ['subagent', 120000, 25], ['cron', 300000, 40],
] as const)('preserves legacy %s defaults', (entry, runTimeoutMs, maxIterations) => {
  expect(resolveRuntimePolicy(entry, { env: {} })).toMatchObject({ runTimeoutMs, maxIterations, longChat: false });
  expect(resolveRuntimePolicy(entry, { env: {} }).budgetLimits).toBeUndefined();
});
it.each([
  ['chat', undefined, 200], ['invoke', 120000, 8], ['subagent', 120000, 25], ['cron', 300000, 40],
] as const)('opens only chat deadline under long policy: %s', (entry, runTimeoutMs, maxIterations) => {
  const policy = resolveRuntimePolicy(entry, { env: { AGENT_RUNTIME_LONG_CHAT: 'true' } });
  expect(policy).toMatchObject({ runTimeoutMs, maxIterations, toolTimeoutMs: 60000, streamIdleTimeoutS: 60 });
  expect(policy.budgetLimits).toMatchObject({ maxToolCalls: 500, maxProviderAttempts: 600, maxTotalTokens: 1000000 });
});
it.each(['chat', 'invoke', 'subagent', 'cron'] as const)('preserves explicit legacy limits for %s', entry => {
  const policy = resolveRuntimePolicy(entry, { env: { AGENT_RUNTIME_LONG_CHAT: 'true', AGENT_RUN_TIMEOUT_MS: '17000', AGENT_MAX_ITERATIONS: '3' } });
  expect(policy.maxIterations).toBe(3); expect(policy.runTimeoutMs).toBe(entry === 'cron' ? 300000 : 17000);
});
it('uses chat-specific override, positive milliseconds, and records source', () => {
  const env = { AGENT_RUNTIME_LONG_CHAT: 'true', AGENT_RUN_TIMEOUT_MS: '10000', AGENT_CHAT_RUN_TIMEOUT_MS: '350000' };
  expect(resolveRuntimePolicy('chat', { env })).toMatchObject({ runTimeoutMs: 350000, source: 'AGENT_CHAT_RUN_TIMEOUT_MS' });
  expect(resolveRuntimePolicy('invoke', { env }).runTimeoutMs).toBe(10000);
});
it.each(['', '0', '-1', 'oops', '1.5', 'Infinity', '9007199254740992'])('rejects explicit invalid new-policy value %j', value => {
  for (const key of ['AGENT_CHAT_RUN_TIMEOUT_MS', 'AGENT_RUN_TIMEOUT_MS', 'AGENT_MAX_ITERATIONS']) {
    expect(() => resolveRuntimePolicy('chat', { env: { AGENT_RUNTIME_LONG_CHAT: 'true', [key]: value } })).toThrow(key);
  }
});
it('legacy fallback remains unchanged and does not interpret invalid values as infinite', () => {
  expect(resolveRuntimePolicy('chat', { env: { AGENT_RUN_TIMEOUT_MS: '-1', AGENT_MAX_ITERATIONS: '0', AGENT_CHAT_RUN_TIMEOUT_MS: '0' } })).toMatchObject({ runTimeoutMs: 120000, maxIterations: 40 });
  expect(() => resolveRuntimePolicy('chat', { env: { AGENT_RUNTIME_LONG_CHAT: 'yes' } })).toThrow('AGENT_RUNTIME_LONG_CHAT');
});
it('respects explicit spec steps, cron timeout and immutable snapshots', () => {
  const env = { AGENT_RUNTIME_LONG_CHAT: 'true' };
  const policy = resolveRuntimePolicy('chat', { env, maxIterations: 7 });
  env.AGENT_RUNTIME_LONG_CHAT = 'false';
  expect(policy.maxIterations).toBe(7); expect(policy.longChat).toBe(true); expect(Object.isFrozen(policy.budgetLimits)).toBe(true);
  expect(resolveRuntimePolicy('cron', { env, cronTimeoutSeconds: 900 }).runTimeoutMs).toBe(900000);
});
it('bounds explicit child allowance to parent remainder and rejects exhaustion', () => {
  const parentRemaining = { ...resolveRuntimePolicy('chat', { env: { AGENT_RUNTIME_LONG_CHAT: 'true' } }), maxIterations: 2, runTimeoutMs: 700,
    budgetLimits: { maxToolCalls: 3, maxProviderAttempts: 4, maxTotalTokens: 100, maxNoProgressSteps: 2 } };
  expect(resolveRuntimePolicy('subagent', { env: {}, parentRemaining })).toMatchObject({ maxIterations: 2, runTimeoutMs: 700, budgetLimits: parentRemaining.budgetLimits });
  expect(() => resolveRuntimePolicy('subagent', { env: {}, parentRemaining: { ...parentRemaining, maxIterations: 0 } })).toThrow('exhausted');
});

it('freezes supervisor mode and rejects invalid rollout configuration', () => {
  const env = { AGENT_RUNTIME_SUPERVISOR_MODE: 'observe' };
  const policy = resolveRuntimePolicy('chat', { env });
  env.AGENT_RUNTIME_SUPERVISOR_MODE = 'enforce';
  expect(policy.supervisorMode).toBe('observe');
  expect(resolveRuntimePolicy('chat', { env }).supervisorMode).toBe('enforce');
  expect(() => resolveRuntimePolicy('chat', { env: { AGENT_RUNTIME_SUPERVISOR_MODE: 'off' } })).toThrow('AGENT_RUNTIME_SUPERVISOR_MODE');
});
