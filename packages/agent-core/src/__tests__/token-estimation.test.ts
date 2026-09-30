import { afterEach, expect, it, vi } from 'vitest';
import { conservativePromptEstimate, estimateWithProvider, FamilyTokenCounter, FAMILY_TOKENIZER_VERSION } from '../token-estimation.js';
import { resolveContextConfig } from '../model-context.js';
import { ContextManager } from '../runtime/context-manager.js';
import { AgentRunner, NoopHook } from '../runner.js';
import { OpenAIProvider } from '../openai-provider.js';
import { ToolRegistry } from '../tool-registry.js';
import { Session } from '../session.js';
import type { AgentRunSpec, LLMProvider, Message } from '../types.js';
import { evaluateTokenCalibration } from './helpers/token-calibration.js';

const messages: Message[] = [{ role: 'user', content: '中文 / English / SELECT 1 / {"状态":"待分析"}' }];
const spec = (extra: Partial<AgentRunSpec> = {}): AgentRunSpec => ({ model: 'test', initialMessages: messages,
  tools: new ToolRegistry(), hook: new NoopHook(), maxIterations: 2, maxToolResultChars: 1000, ...extra });
const provider = (countPromptTokens?: LLMProvider['countPromptTokens']): LLMProvider => ({ getDefaultModel: () => 'test', countPromptTokens,
  chat: async () => ({ content: 'complete', finishReason: 'stop', toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: {} }),
  chatStream: async () => { throw new Error('unused'); } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('freezes 140 samples, with 100 independently encoded text/schema ground truths and no margin underestimates', () => {
  const report = evaluateTokenCalibration();
  expect(report.sampleCount).toBe(140);
  expect(report.methods['family-tokenizer']).toMatchObject({ groundTruthSamples: 100, underestimationRate: 0,
    rawP50AbsoluteRelativeError: 0, rawP95AbsoluteRelativeError: 0 });
  expect(report.methods['conservative-heuristic']).toMatchObject({ groundTruthSamples: 100, underestimationRate: 0 });
  expect(report.methods.exact.groundTruthSamples).toBe(0); // no vendor chat-usage calibration
  expect(report.samples.filter(s => ['unknown', 'image'].includes(s.category)).every(s =>
    s.method === 'conservative-heuristic' && s.groundTruth === null && s.relativeError === null)).toBe(true);
});
it('does not label an undefined counter result exact and keeps method/model/version/margin per estimate', () => {
  const manager = new ContextManager(spec(), provider(() => undefined));
  expect(manager.estimation).toBe('estimated');
  expect(manager.estimate(messages)).toMatchObject({ method: 'conservative-heuristic', model: 'test',
    version: 'utf8-upper-bound/v1', margin: { ratio: 0, fixedTokens: 0 }, fallbackReason: 'TOKENIZER_UNSUPPORTED' });
  expect(manager.estimation).toBe('estimated');
});
it.each([0, NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])('invalid count %s degrades to a labeled byte upper bound', value => {
  const estimate = estimateWithProvider(messages, [], 'test', provider(() => value));
  expect(estimate).toMatchObject({ method: 'conservative-heuristic', fallbackReason: 'TOKENIZER_INVALID' });
  expect(estimate.tokens).toBe(conservativePromptEstimate(messages, []).tokens);
});
it('exceptions, model mismatches and invalid structured estimates degrade without leaking exception text', () => {
  expect(estimateWithProvider(messages, [], 'test', provider(() => { throw new Error('secret-token'); }))).toMatchObject({ fallbackReason: 'TOKENIZER_FAILED' });
  expect(estimateWithProvider(messages, [], 'other-model', provider(() => 10))).toMatchObject({ fallbackReason: 'TOKENIZER_MODEL_MISMATCH' });
  const count: any = () => ({ tokens: 1, rawTokens: 500, method: 'exact', model: 'test', version: 'test-v1',
    margin: { ratio: 0.1, fixedTokens: 10, floorTokens: 0 } });
  expect(estimateWithProvider(messages, [], 'test', provider(count))).toMatchObject({ fallbackReason: 'TOKENIZER_INVALID' });
  expect(JSON.stringify(estimateWithProvider(messages, [], 'test', provider(() => { throw new Error('secret-token'); })))).not.toContain('secret-token');
});
it('legacy exact counts retain compatibility for their default model and structured counts retain declared provenance', () => {
  const manager = new ContextManager(spec(), provider(() => 70));
  expect(manager.tokens(messages)).toBe(70); expect(manager.estimation).toBe('provider');
  expect(manager.lastEstimate).toMatchObject({ method: 'exact', version: 'legacy-provider-counter/v1' });
  const p = provider(() => ({ tokens: 90, rawTokens: 70, method: 'exact', model: 'test', version: 'provider-count/v2',
    margin: { ratio: 0, fixedTokens: 20, floorTokens: 0 } }));
  expect(estimateWithProvider(messages, [], 'test', p)).toMatchObject({ method: 'exact', tokens: 90 });
});
it('family tokenizer preserves the existing upper bound for uncalibrated chat framing, including special tokens and schemas', () => {
  const counter = new FamilyTokenCounter();
  const prompt: Message[] = [{ role: 'user', content: '<|endoftext|> e\u0301 🧪 中文'.repeat(100) }];
  const estimate = counter.count(prompt, [], 'gpt-4o')!;
  expect(estimate.method).toBe('family-tokenizer');
  expect(estimate.version).toContain(FAMILY_TOKENIZER_VERSION);
  expect(estimate.tokens).toBeGreaterThanOrEqual(conservativePromptEstimate(prompt, []).tokens);
});
it('cache is hashed, bounded, expires, invalidates and never shares mutable results', () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const counter = new FamilyTokenCounter();
  const first = counter.count(messages, [], 'gpt-4o')!;
  first.tokens = 1;
  expect(counter.count(messages, [], 'gpt-4o')!.tokens).toBeGreaterThan(1);
  for (let i = 0; i < 70; i++) counter.count([{ role: 'user', content: String(i) }], [], 'gpt-4o');
  expect(counter.size).toBe(64);
  now += 300_001;
  counter.count(messages, [], 'gpt-4o'); expect(counter.size).toBe(1);
  counter.invalidate(); expect(counter.size).toBe(0);
});
it('unknown models, alternate endpoints, media and very large payloads never get an exact/family label by inference', () => {
  const native = new OpenAIProvider({ apiKey: 'fixture', model: 'gpt-4o' });
  const alternate = new OpenAIProvider({ apiKey: 'fixture', model: 'gpt-4o', baseURL: 'https://api.openai.com.evil.test/v1' });
  expect(estimateWithProvider(messages, [], 'gpt-4o', native).method).toBe('family-tokenizer');
  expect(estimateWithProvider(messages, [], 'gpt-4o', alternate).method).toBe('conservative-heuristic');
  expect(native.countPromptTokens(messages, [], 'unknown-model')).toBeUndefined();
  expect(native.countPromptTokens([{ role: 'user', content: 'x'.repeat(1_000_001) }], [])).toBeUndefined();
  const media: Message[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/huge.png' } }] }];
  expect(estimateWithProvider(media, [], 'test', provider(() => 1))).toMatchObject({ method: 'conservative-heuristic', fallbackReason: 'MEDIA_UNCALIBRATED' });
  const manager = new ContextManager(spec(), provider(() => 1));
  expect(() => manager.assertFits(media)).toThrow('Protected context exceeds input budget');
});
it('OpenAI SDK environment endpoints cannot accidentally inherit native tokenizer capabilities', () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://custom.invalid/v1');
  const p = new OpenAIProvider({ apiKey: 'fixture', model: 'gpt-4o' });
  expect(p.countPromptTokens(messages, [])).toBeUndefined(); expect(p.getModelCapabilities()).toBeUndefined();
});
it('known window/output limits, smaller explicit limits, unknown fallback, watermark and the exact boundary are applied', () => {
  const p = provider(() => 2048);
  p.getModelCapabilities = model => ({ model: model!, contextWindowTokens: 4096, maxOutputTokens: 1024,
    source: 'configuration', version: 'fixture/v1' });
  const manager = new ContextManager(spec({ maxTokens: 1024 }), p);
  expect(manager.inputBudget).toBe(2048);
  expect(manager.watermark).toBe(0.8); expect(manager.target).toBe(0.5);
  expect(manager.requestReservation()).toBe(4096);
  manager.assertFits(messages);
  p.countPromptTokens = () => 2049; expect(() => manager.assertFits(messages)).toThrow();
  expect(resolveContextConfig(spec({ contextWindowTokens: 3000, maxTokens: 500 }), p)).toMatchObject({ contextWindowTokens: 3000, maxTokens: 500 });
  expect(resolveContextConfig(spec({ contextWindowTokens: 200_000, maxTokens: 500 }), p).contextWindowTokens).toBe(4096);
  expect(resolveContextConfig(spec())).toMatchObject({ contextWindowTokens: 8192, source: 'conservative-fallback' });
  expect(() => resolveContextConfig(spec({ maxTokens: 1025 }), p)).toThrow('INVALID_MODEL_CONTEXT');
  expect(() => resolveContextConfig(spec({ contextWindowTokens: Infinity }), p)).toThrow('INVALID_MODEL_CONTEXT');
});
it('session history uses conservative CJK budgets, retaining whole latest turns and canonical facts', () => {
  expect(Session.estimateTokens('中文')).toBe(6);
  const session = new Session('test');
  session.addMessage('user', '中文'.repeat(100)); session.addMessage('assistant', 'old');
  session.addMessage('user', 'new');
  const before = JSON.stringify(session.messages);
  expect(session.getHistory(undefined, 600).filter(m => m.role === 'user').map(m => m.content)).toEqual(['new']);
  expect(JSON.stringify(session.messages)).toBe(before);
});
it('persists method/config separately from measured usage and retains unknown reservations across restored runs', async () => {
  let checkpoint: any;
  const result = await new AgentRunner(provider(() => undefined)).run(spec({ checkpointCallback: async p => { checkpoint = p; } }));
  expect(result.runtimeState).toMatchObject({ usage: {}, unknownRequests: 1, reservedTokens: 8192 });
  expect(checkpoint.context_estimate_v1).toMatchObject({ method: 'conservative-heuristic', model: 'test' });
  expect(checkpoint.context_config_v1).toMatchObject({ contextWindowTokens: 8192, source: 'conservative-fallback' });
  expect(JSON.stringify(checkpoint.context_estimate_v1)).not.toContain('SELECT');
  const restored = await new AgentRunner(provider()).run(spec({ resumeCheckpoint: checkpoint, maxIterations: 3 }));
  expect(restored.runtimeState?.reservedTokens).toBeGreaterThanOrEqual(result.runtimeState!.reservedTokens);
});
