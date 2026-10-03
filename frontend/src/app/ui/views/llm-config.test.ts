import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { post, get, put } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), put: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ apiClient: { post, get, put } }));

import "./llm-config.js";

describe('model loading and parameter selection', () => {
  const model = { id: 'step-3.5-flash-2603', name: 'Step 3.5 Flash 2603', contextWindow: 256000, maxTokens: 256000, supportsFunctionCall: true, supportsVision: false, parameterSource: 'catalog' };
  beforeEach(() => {
    get.mockReset(); put.mockReset(); post.mockReset();
    get.mockImplementation(async (url: string) => url === '/llm/configs' ? [{ id: 11, name: 'step', default_model: model.id, context_window: 4096, max_tokens: 2048, supports_function_call: false, models_supported: [] }] : []);
    post.mockResolvedValue({ models: [model], source: 'api' });
    put.mockResolvedValue({ success: true });
  });
  afterEach(() => document.querySelectorAll('llm-config-page').forEach(el => el.remove()));
  async function page() {
    const element = document.createElement('llm-config-page') as any;
    document.body.append(element); await element._load(); await element.updateComplete;
    return element;
  }
  it('loads using the unsaved draft then selects and saves effective limits and clears the saved key field', async () => {
    const element = await page();
    element.form = { ...element.form, api_base_url: 'https://api.stepfun.com/v1', api_key: 'draft-key' };
    await element.updateComplete;
    const load = element.shadowRoot.querySelector('[data-testid="load-models"]');
    expect(load).not.toBeNull();
    load.click(); await vi.waitFor(() => expect(post).toHaveBeenCalled());
    await vi.waitFor(() => expect(element.form.models).toHaveLength(1)); await element.updateComplete;
    expect(post).toHaveBeenCalledWith('/llm/models', expect.objectContaining({ providerName: 'step', baseURL: 'https://api.stepfun.com/v1', apiKey: 'draft-key' }));
    expect(element.form.api_key).toBe('draft-key');
    const select = element.shadowRoot.querySelector('select[aria-label="选择模型"]');
    select.value = model.id; select.dispatchEvent(new Event('change')); await element.updateComplete;
    expect(element.shadowRoot.querySelector('input[aria-label="上下文窗口"]').value).toBe('256000');
    expect(Number(element.shadowRoot.querySelector('input[aria-label="Max Tokens"]').value)).toBeLessThan(256000 - 1024);
    expect(element.shadowRoot.querySelector('input[aria-label="支持工具调用"]').checked).toBe(true);
    await element._save();
    expect(put).toHaveBeenCalledWith('/llm/configs/11', expect.objectContaining({ contextWindow: 256000, maxTokens: 4096, supportsFunctionCall: true, modelsSupported: [model] }));
    expect(put.mock.calls[0][1].apiKey).toBe('draft-key');
    expect(element.form.api_key).toBe('');
  });
  it('surfaces load failures and keeps existing model parameters', async () => {
    const element = await page();
    element.form = { ...element.form, api_base_url: 'https://api.stepfun.com/v1', models: [model], api_key: 'draft-key' };
    post.mockRejectedValue(new Error('MODEL_DISCOVERY_HTTP_401'));
    await element._fetchModels(); await element.updateComplete;
    expect(element.shadowRoot.textContent).toContain('MODEL_DISCOVERY_HTTP_401');
    expect(element.form.models).toEqual([model]); expect(element.form.api_key).toBe('draft-key');
  });
  it('ignores a late discovery response after switching providers', async () => {
    const element = await page();
    element.form = { ...element.form, api_base_url: 'https://api.stepfun.com/v1' };
    let finish!: (value: any) => void;
    post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = element._fetchModels();
    element._selectProvider({ id: 5, name: 'deepseek', default_model: 'deepseek-v4-flash', context_window: 128000, max_tokens: 2048 });
    finish({ models: [model], source: 'api' }); await pending;
    expect(element.form.name).toBe('deepseek'); expect(element.form.models).toEqual([]);
  });
  it('requires explicit parameters for unknown models and blocks invalid output reservations', async () => {
    const element = await page();
    element.form = { ...element.form, models: [{ id: 'unknown', parameterSource: 'unknown' }] };
    element._selectModel('unknown');
    await element._save(); await element.updateComplete;
    expect(put).not.toHaveBeenCalled();
    expect(element.shadowRoot.textContent).toContain('上下文窗口');
    element.form = { ...element.form, context_window: 64000, max_tokens: 64000 };
    await element._save();
    expect(put).not.toHaveBeenCalled();
  });
  it('persists manually entered model parameters and supplier type for a custom proxy', async () => {
    const element = await page();
    element.form = { ...element.form, provider_type: 'mimo', default_model: 'custom-id', context_window: 64000, max_tokens: 2048, supports_function_call: true, models: [] };
    await element._save();
    expect(put).toHaveBeenCalledWith('/llm/configs/11', expect.objectContaining({ modelsSupported: [expect.objectContaining({ id: 'custom-id', contextWindow: 64000, supportsFunctionCall: true, parameterProvider: 'mimo', parameterSource: 'manual' })] }));
  });
});

describe("llm-config-page connection testing", () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ success: true, message: "连接成功" });
  });

  it("sends the current unsaved provider draft when testing", async () => {
    const element = document.createElement("llm-config-page") as any;
    element.editing = { id: 7, name: "deepseek" };
    element.form = {
      name: "deepseek",
      api_key: "new-unsaved-key",
      api_base_url: "https://example.test/v1",
      default_model: "deepseek-chat-new",
      api_format: "openai-completions",
      deployment_type: "api",
    };

    await element._test(element.editing);

    expect(post).toHaveBeenCalledWith("/llm/test", {
      providerName: "deepseek",
      apiKey: "new-unsaved-key",
      baseURL: "https://example.test/v1",
      model: "deepseek-chat-new",
      apiFormat: "openai-completions",
      deploymentType: "api",
    });
  });
});

describe('scene assignments', () => {
  const providers = [{ id: 1, name: 'primary', display_name: 'Primary', enabled: true, is_default: true,
    default_model: 'base', models_supported: [{ id: 'fast' }] }];
  const scenes = [{ scene: 'chat', binding: null, effective: { provider_id: 1, provider_name: 'Primary', model: 'base', source: 'default' }, error: null }];
  beforeEach(() => {
    get.mockReset(); put.mockReset();
    get.mockImplementation(async (url: string) => url === '/llm/configs' ? providers : scenes);
    put.mockResolvedValue({ success: true });
  });
  it('renders effective model, edits provider/model and persists only references', async () => {
    const element = document.createElement('llm-config-page') as any;
    document.body.append(element);
    await element._load();
    element.activeTab = 'scenes';
    await element.updateComplete;
    expect(element.shadowRoot.textContent).toContain('Primary / base（全局默认）');
    const select = element.shadowRoot.querySelector('select');
    select.value = '1'; select.dispatchEvent(new Event('change'));
    await element.updateComplete;
    const model = element.shadowRoot.querySelectorAll('select')[1];
    model.value = 'fast'; model.dispatchEvent(new Event('change'));
    await element.updateComplete;
    await element._saveScene('chat');
    expect(put).toHaveBeenCalledWith('/llm/scenes/chat', { provider_id: 1, model: 'fast' });
    await element._saveScene('chat');
    expect(put).toHaveBeenLastCalledWith('/llm/scenes/chat', { provider_id: null });
    element.remove();
  });
  it('shows dangling bindings and keeps draft after save failure', async () => {
    get.mockImplementation(async (url: string) => url === '/llm/configs' ? providers : [{ scene: 'chat', binding: { provider_id: 99, model: 'gone' }, effective: null, error: '提供商已删除' }]);
    const element = document.createElement('llm-config-page') as any;
    document.body.append(element);
    await element._load(); element.activeTab = 'scenes'; await element.updateComplete;
    expect(element.shadowRoot.textContent).toContain('提供商已删除');
    expect(element.shadowRoot.querySelector('select').value).toBe('99');
    put.mockRejectedValue(new Error('保存失败'));
    await element._saveScene('chat'); await element.updateComplete;
    expect(element.shadowRoot.querySelector('[role="alert"]').textContent).toContain('保存失败');
    expect(element.sceneDrafts.chat.provider_id).toBe(99);
    element.remove();
  });
});

describe('initial provider selection', () => {
  it.each([
    [[{ id: 1, enabled: true }, { id: 2, enabled: true, is_default: true }], 2],
    [[{ id: 1, enabled: false }, { id: 2, enabled: true }], 2],
    [[{ id: 1, enabled: false }], 1],
    [[], null],
  ])('opens the default or available provider for %j', async (rows, selectedId) => {
    get.mockImplementation(async (url: string) => url === '/llm/configs'
      ? rows.map(row => ({ ...row, name: 'provider', default_model: 'base' })) : []);
    const element = document.createElement('llm-config-page') as any;
    await element._load();
    expect(element.selectedId).toBe(selectedId);
    expect(element.viewMode).toBe(selectedId === null ? 'picker' : 'form');
    if (selectedId !== null) expect(element.form.default_model).toBe('base');
  });
});
