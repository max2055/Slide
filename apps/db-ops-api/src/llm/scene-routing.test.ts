import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectSceneModel, resolveSceneModel, sceneForPurpose } from './scene-routing.js';
import { llmDatabaseService } from '../llm-database-service.js';
import { llmService } from '../llm-service.js';
import { createConfiguredAgentProvider } from '../adapter/llm-provider-factory.js';
import { dbConnection } from '../db-connection.js';

const provider = { id: 1, name: 'primary', display_name: 'Primary', enabled: true, is_default: true,
  default_model: 'base', models_supported: [{ id: 'fast' }, { id: 'reasoning' }], supports_function_call: true,
  supports_vision: false, context_window: 8192, deployment_type: 'api', api_format: 'openai-completions' } as any;
const binding = { scene: 'sql_analysis' as const, provider_id: 1, model: 'fast' };
afterEach(() => vi.restoreAllMocks());

describe('scene routing', () => {
  it('uses global default for unbound/unknown purposes and distinct models for one provider', () => {
    expect(selectSceneModel([provider], [], 'chat').model).toBe('base');
    expect(selectSceneModel([provider], [binding], 'other').model).toBe('base');
    expect(selectSceneModel([provider], [binding], 'sql_analysis').model).toBe('fast');
    expect(selectSceneModel([provider], [{ ...binding, model: 'reasoning' }], 'sql_analysis').model).toBe('reasoning');
  });
  it('scene binding takes priority over legacy explicit overrides', () => {
    expect(selectSceneModel([provider], [binding], 'sql_analysis', {}, { provider: 'other', model: 'other' }).model).toBe('fast');
  });
  it.each([
    ['deleted', []], ['disabled', [{ ...provider, enabled: false }]],
    ['missing model', [{ ...provider, models_supported: [] }]],
    ['tool capability', [{ ...provider, supports_function_call: false }]],
  ])('never falls back when a bound provider is %s', (_mode, providers) => {
    expect(() => selectSceneModel([...providers, { ...provider, id: 2 }], [binding], 'sql_analysis', { requiresFunctionCall: true })).toThrow('LLM 配置错误');
  });
  it('fails on unsupported vision/context and a disabled global default', () => {
    expect(() => selectSceneModel([provider], [], 'chat', { requiresVision: true })).toThrow('视觉');
    expect(() => selectSceneModel([provider], [], 'chat', { minContextWindow: 9000 })).toThrow('上下文');
    expect(() => selectSceneModel([{ ...provider, enabled: false }], [], 'chat')).toThrow('已禁用');
  });
  it('routes existing business purposes', () => {
    for (const purpose of ['sql_audit', 'sql_generation', 'topsql_analysis', 'sql_approval']) expect(sceneForPurpose(purpose)).toBe('sql_analysis');
    for (const purpose of ['fault_diagnosis', 'alert_rca', 'resource_diagnosis', 'log_analysis']) expect(sceneForPurpose(purpose)).toBe('fault_diagnosis');
    expect(sceneForPurpose('health_check')).toBe('health_check');
  });
  it('does not treat configuration read failure as no binding', async () => {
    await expect(resolveSceneModel({ getAllProviders: async () => [provider], getSceneBindings: async () => { throw new Error('offline'); } }, 'chat')).rejects.toThrow('offline');
  });
  it('shares resolution between tracked/streaming service and Agent and observes edits immediately', async () => {
    vi.spyOn(llmDatabaseService, 'getAllProviders').mockResolvedValue([provider]);
    const bindings = vi.spyOn(llmDatabaseService, 'getSceneBindings').mockResolvedValue([binding]);
    vi.spyOn(llmDatabaseService, 'getProviderApiKey').mockResolvedValue('test-key');
    const call = vi.spyOn(llmService as any, 'callLLM').mockResolvedValue({ success: true, content: 'ok', model: 'fast' });
    const stream = vi.spyOn(llmService as any, 'callOpenAIStream').mockResolvedValue('ok');
    await llmService.chatWithTracking([], { purpose: 'sql_analysis' });
    expect(call.mock.calls[0][2]).toMatchObject({ model: 'fast' });
    const streamed = await llmService.chatWithStreaming([], { purpose: 'sql_analysis', onChunk: vi.fn() });
    expect(stream.mock.calls[0][2]).toMatchObject({ model: 'fast' });
    expect(streamed.model).toBe('fast');
    expect((await createConfiguredAgentProvider(llmDatabaseService, 'sql_analysis')).getDefaultModel()).toBe('fast');
    bindings.mockResolvedValue([{ ...binding, model: 'reasoning' }]);
    expect((await createConfiguredAgentProvider(llmDatabaseService, 'sql_analysis')).getDefaultModel()).toBe('reasoning');
    bindings.mockResolvedValue([{ ...binding, provider_id: 999 }]);
    expect(await llmService.chatWithTracking([], { purpose: 'sql_analysis' })).toMatchObject({ success: false, error: expect.stringContaining('已删除') });
    const invalid = await createConfiguredAgentProvider(llmDatabaseService, 'sql_analysis');
    await expect(invalid.chat([], [])).rejects.toThrow('已删除');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('persists only references, supports clearing, and propagates read failures', async () => {
    const execute = vi.fn().mockResolvedValue([[binding]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    expect(await llmDatabaseService.getSceneBindings()).toEqual([binding]);
    await llmDatabaseService.saveSceneBinding('sql_analysis', binding);
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO llm_scene_bindings'), ['sql_analysis', 1, 'fast']);
    await llmDatabaseService.saveSceneBinding('sql_analysis', null);
    expect(execute).toHaveBeenLastCalledWith('DELETE FROM llm_scene_bindings WHERE scene = ?', ['sql_analysis']);
    execute.mockRejectedValue(new Error('db offline'));
    await expect(llmDatabaseService.getSceneBindings()).rejects.toThrow('LLM_CONFIGURATION_UNAVAILABLE');
  });
});
