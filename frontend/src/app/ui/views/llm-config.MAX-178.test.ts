import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { get, put, post } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ apiClient: { get, put, post } }));
import './llm-config.js';
const first = { id: 'first', name: 'First', contextWindow: 64000, maxTokens: 8192, cost: { input: 0 }, opaque: { retained: true } };
const second = { id: 'unknown', parameterSource: 'unknown', opaque: { second: true } };
const provider = { id: 178, name: 'max178', display_name: 'MAX178', default_model: 'first', api_base_url: 'http://fixture.invalid/v1', enabled: true, max_tokens: 2048, context_window: 64000, models_supported: [first, second] };
let view: any;
beforeEach(async () => {
  get.mockReset(); put.mockReset(); post.mockReset();
  get.mockImplementation(async (url: string) => url === '/llm/configs' ? [structuredClone(provider)] : []);
  put.mockResolvedValue({ success: true });
  view = document.createElement('llm-config-page'); document.body.append(view);
  await view._load(); await view.updateComplete;
});
afterEach(() => { view.remove(); vi.restoreAllMocks(); });
describe('MAX-178 model editing boundary', () => {
  it('browses multiple models without rendering per-model forms and collapses advanced fields', () => {
    expect(view.shadowRoot.querySelectorAll('.model-row')).toHaveLength(2);
    expect(view.shadowRoot.querySelector('.advanced').open).toBe(false);
    expect(view.shadowRoot.querySelector('input[aria-label="模型 ID"]')).toBeNull();
  });
  it('isolates the model draft, preserving zero prices, unknown capabilities and extensions', async () => {
    view._editModel(0); view._patchModel({ name: 'Changed' });
    expect(view.form.models[0].name).toBe('First');
    expect(view.modelDraft.cost.input).toBe(0);
    await view._saveModel();
    expect(put).toHaveBeenCalledWith('/llm/configs/178', expect.objectContaining({ modelsSupported: [expect.objectContaining({ name: 'Changed', opaque: { retained: true }, cost: { input: 0 } }), second] }));
    expect(view.form.models[0].supportsVision).toBeUndefined();
    expect(view.connectionDirty).toBe(false);
  });
  it('submits only the edited model, leaving dirty connection URL, key, name and uncommitted model changes alone', async () => {
    view.form = { ...view.form, api_key: 'fake-unsaved-key', api_base_url: 'https://unsaved.invalid', display_name: 'unsaved', models: [...view.form.models, { id: 'not-saved' }] };
    view._editModel(1); view._patchModel({ name: 'Unknown renamed' }); await view._saveModel();
    expect(put.mock.calls[0][1]).toEqual({ modelsSupported: [first, { ...second, name: 'Unknown renamed' }] });
    expect(view.form.api_key).toBe('fake-unsaved-key'); expect(view.form.models).toHaveLength(3);
    expect(view.connectionDirty).toBe(true);
  });
  it('cancel discards model edits without changing connection or making a request', async () => {
    view._editModel(0); view._patchModel({ name: 'discard' }); await view.updateComplete;
    Array.from(view.shadowRoot.querySelector('app-dialog').querySelectorAll('button')).find((el: any) => el.textContent.trim() === '取消')!.dispatchEvent(new MouseEvent('click'));
    expect(view.modelDraft).toBeNull(); expect(view.form.models[0]).toEqual(first); expect(put).not.toHaveBeenCalled();
  });
  it('retains failed model drafts and reports the error in the dialog', async () => {
    put.mockRejectedValue(new Error('HTTP 403 无管理权限'));
    view._editModel(1); view._patchModel({ name: 'Keep me' }); await view._saveModel(); await view.updateComplete;
    expect(view.modelDraft.name).toBe('Keep me'); expect(view.form.models[1]).toEqual(expect.objectContaining(second));
    expect(view.shadowRoot.querySelector('app-dialog [role="alert"]').textContent).toContain('无管理权限');
  });
  it.each([{ id: '' }, { id: 'unknown' }, { contextWindow: 10 }, { maxTokens: -2 }, { cost: { input: -1 } }])('rejects invalid edits %j', async patch => {
    view._editModel(0); view._patchModel(patch); await view._saveModel();
    expect(put).not.toHaveBeenCalled(); expect(view.modelError).not.toBe('');
  });
  it('blocks incompatible default output limits without changing the saved reservation', async () => {
    view._editModel(0); view._patchModel({ maxTokens: 1000 }); await view._saveModel();
    expect(put).not.toHaveBeenCalled(); expect(view.modelError).toContain('Max Tokens');
  });
  it('stages new-provider models and cancellations without sending a premature provider write', async () => {
    view._openCustomForm(); view._addModel(); view._patchModel({ id: 'new-unknown' }); await view._saveModel();
    expect(put).not.toHaveBeenCalled(); expect(view.form.models).toEqual([{ id: 'new-unknown' }]);
    expect(view.modelFeedback).toContain('保存配置后生效');
  });
  it('protects dirty navigation and allows explicit discard', async () => {
    view.form = { ...view.form, display_name: 'dirty' };
    view.shadowRoot.querySelector('.add-btn').click(); await view.updateComplete;
    expect(view.viewMode).toBe('form'); expect(view.discardOpen).toBe(true);
    const discard = Array.from(view.shadowRoot.querySelectorAll('app-dialog button')).find((el: any) => el.textContent.includes('放弃并离开')) as HTMLButtonElement;
    discard.click(); expect(view.viewMode).toBe('picker'); expect(view.testResult).toBeNull();
  });
  it('does not label an immediate enable toggle as an unsaved connection edit', async () => {
    const fresh = { ...provider, enabled: false };
    post.mockResolvedValue({ success: true });
    get.mockImplementation(async (url: string) => url === '/llm/configs' ? [structuredClone(fresh)] : []);
    await view._toggle(provider);
    expect(view.form.enabled).toBe(false); expect(view.connectionDirty).toBe(false);
  });
  it('prevents duplicate writes while saving and keeps the error when API returns success false', async () => {
    let finish!: (data: any) => void; put.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    view._editModel(1); const pending = view._saveModel(); await view._saveModel();
    expect(put).toHaveBeenCalledTimes(1); finish({ success: false, error: '数据库未连接' }); await pending;
    expect(view.modelError).toBe('数据库未连接'); expect(view.modelDraft).not.toBeNull();
  });
});
