import { beforeEach, describe, expect, it, vi } from "vitest";

const { post, get, put } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), put: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ apiClient: { post, get, put } }));

import "./llm-config.js";

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
    element.viewMode = 'scenes';
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
    await element._load(); element.viewMode = 'scenes'; await element.updateComplete;
    expect(element.shadowRoot.textContent).toContain('提供商已删除');
    expect(element.shadowRoot.querySelector('select').value).toBe('99');
    put.mockRejectedValue(new Error('保存失败'));
    await element._saveScene('chat'); await element.updateComplete;
    expect(element.shadowRoot.querySelector('[role="alert"]').textContent).toContain('保存失败');
    expect(element.sceneDrafts.chat.provider_id).toBe(99);
    element.remove();
  });
});
