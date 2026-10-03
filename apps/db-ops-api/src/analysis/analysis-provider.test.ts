import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@slide/agent-core';
import { setAnalysisProviderIdentity } from './analysis-execution.js';
import { guardedAnalysisProvider } from './analysis-provider.js';

const response: LLMResponse = { content: 'ok', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };
describe('analysis actual provider boundary', () => {
  it.each(['chat', 'chatStream'] as const)('checks live authority before every %s and stops after an uncertain request', async method => {
    const send = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('ECONNRESET'));
    const check = vi.fn(async () => {});
    const guarded = guardedAnalysisProvider({ chat: send, chatStream: send, getDefaultModel: () => 'test' }, check);
    await (guarded[method] as any)([], []);
    await expect((guarded[method] as any)([], [])).rejects.toThrow('ECONNRESET');
    await expect((guarded[method] as any)([], [])).rejects.toThrow('ANALYSIS_PROVIDER_RESULT_UNKNOWN');
    expect(send).toHaveBeenCalledTimes(2); expect(check).toHaveBeenCalledTimes(2);
  });
  it('also blocks runner retries when a provider returns an error response', async () => {
    const chat = vi.fn(async () => ({ ...response, finishReason: 'error', error: 'provider timeout' }));
    const guarded = guardedAnalysisProvider({ chat, chatStream: chat, getDefaultModel: () => 'test' }, async () => {});
    await guarded.chat([], []); await expect(guarded.chat([], [])).rejects.toThrow('ANALYSIS_PROVIDER_RESULT_UNKNOWN'); expect(chat).toHaveBeenCalledOnce();
  });
  it('a before-send authority failure neither sends nor poisons the safe retry window', async () => {
    const chat = vi.fn(async () => response); const check = vi.fn().mockRejectedValueOnce(new Error('ANALYSIS_AUTHORITY_REVOKED')).mockResolvedValue(undefined);
    const guarded = guardedAnalysisProvider({ chat, chatStream: chat, getDefaultModel: () => 'test' } as LLMProvider, check);
    await expect(guarded.chat([], [])).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED'); expect(chat).not.toHaveBeenCalled();
    await guarded.chat([], []); expect(chat).toHaveBeenCalledOnce();
  });  it('distinguishes actual model, system prompt and input; records unavailable usage truthfully', async () => {
    const events: any[] = [];
    const raw = { chat: async () => response, chatStream: async () => response, getDefaultModel: () => 'model-A' };
    setAnalysisProviderIdentity(raw, { provider: 'actual', routeVersion: 'route-v1' });
    const guarded = guardedAnalysisProvider(raw, async () => {}, undefined, async event => { events.push(event); });
    await guarded.chat([{ role: 'system', content: 'prompt-A' }, { role: 'user', content: 'input-A' }], [], { model: 'model-A' });
    await guarded.chat([{ role: 'system', content: 'prompt-B' }, { role: 'user', content: 'input-A' }], [], { model: 'model-B' });
    expect(events[0].request).toMatchObject({ provider: 'actual', model: 'model-A', routeVersion: 'route-v1', requestNumber: 1 });
    expect(events[2].request.model).toBe('model-B');
    expect(events[0].request.promptHash).not.toBe(events[2].request.promptHash);
    expect(events[0].request.inputHash).not.toBe(events[2].request.inputHash);
    expect(events[1]).toEqual({ kind: 'response', requestNumber: 1, usage: null });
  });

});
