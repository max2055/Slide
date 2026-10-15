import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../../api/index.js';
import { AgentToolsPage } from './agent-tools.js';

const tool = (name: string) => ({ name, description: '用途'.repeat(100), parameters: { type: 'object' }, security: { effect: 'read', approval: 'never', resource: 'instance', permissions: ['instance:view'] } });
async function flush(element: AgentToolsPage) { await new Promise(resolve => setTimeout(resolve, 0)); await element.updateComplete; }
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('MAX-176 full-list lifecycle', () => {
  it('filters the full authorized collection before paging and retains dialog context', async () => {
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValue(new Response(JSON.stringify({ tools: Array.from({ length: 25 }, (_, i) => tool(`工具-${String(i).padStart(2, '0')}`)) })));
    const element = new AgentToolsPage(); document.body.append(element); await flush(element);
    expect(element.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(6);
    const search = element.shadowRoot!.querySelector('input')!;
    search.value = '工具-24'; search.dispatchEvent(new Event('input')); await flush(element);
    expect(element.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(element.shadowRoot!.textContent).toContain('第 1 / 1 页');
    (element.shadowRoot!.querySelector('tbody button') as HTMLButtonElement).click(); await flush(element);
    expect(element.shadowRoot!.querySelector('app-dialog')!.textContent).toContain('工具-24');
    element.shadowRoot!.querySelector('app-dialog')!.dispatchEvent(new CustomEvent('app-dialog-close')); await flush(element);
    expect(search.value).toBe('工具-24');
  });
  it('clears stale records on forbidden refresh and keeps it distinct from an empty success', async () => {
    const request = vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValueOnce(new Response(JSON.stringify({ tools: [tool('previous')] })))
      .mockResolvedValueOnce(new Response('{}', { status: 403 })).mockResolvedValueOnce(new Response(JSON.stringify({ tools: [] })));
    const element = new AgentToolsPage(); document.body.append(element); await flush(element);
    expect(element.shadowRoot!.textContent).toContain('previous');
    await element.load(); await flush(element);
    expect(element.shadowRoot!.textContent).not.toContain('previous');
    expect(element.shadowRoot!.querySelector('[role="alert"]')!.textContent).toContain('权限');
    await element.load(); await flush(element);
    expect(element.shadowRoot!.textContent).toContain('暂无已注册工具');
    expect(element.shadowRoot!.querySelector('[role="alert"]')).toBeNull(); expect(request).toHaveBeenCalledTimes(3);
  });
  it('does not restore a late response after session expiry', async () => {
    let resolve!: (value: Response) => void;
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation(() => new Promise(r => { resolve = r; }));
    const element = new AgentToolsPage(); document.body.append(element); await element.updateComplete;
    window.dispatchEvent(new Event('slide-session-expired'));
    resolve(new Response(JSON.stringify({ tools: [tool('late-private')] }))); await flush(element);
    expect(element.shadowRoot!.textContent).not.toContain('late-private');
    expect(element.shadowRoot!.textContent).toContain('登录已失效');
  });
});

import { AgentSessionsPage } from './agent-sessions.js';
import { AgentSkillsPage } from './agent-skills.js';
const session = (key: string) => ({ key, label: key, kind: 'direct', updatedAt: null, message_count: 105, status: 'mystery', instance_id: 42 });
const skill = (enabled = true) => ({ name: 'path/技能', description: '长用途'.repeat(100), filePath: '/a/very/long/path', enabled, frontmatter: { arbitrary: ['保留'] } });
const response = (data: unknown) => new Response(JSON.stringify(data));
async function settled(element: AgentSessionsPage | AgentSkillsPage) { await new Promise(resolve => setTimeout(resolve, 0)); await element.updateComplete; }
describe('MAX-176 sessions and skills', () => {
  it('paginates complete structured messages and ignores history arriving after close', async () => {
    const request = vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValueOnce(response({ sessions: [session('private /会话')] }))
      .mockResolvedValueOnce(response({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '推理' }, { type: 'text', text: '完整正文' }], timestamp: 1780000000000 }], nextBefore: 9 }))
      .mockResolvedValueOnce(response({ messages: [{ role: 'user', content: '更早正文', timestamp: 1780000000000 }], nextBefore: null }));
    const element = new AgentSessionsPage(); document.body.append(element); await settled(element);
    expect(element.shadowRoot!.querySelector('tbody')!.textContent).toContain('未命名会话');
    expect(element.shadowRoot!.querySelector('tbody')!.textContent).not.toContain('private /会话');
    await element.viewMessages(session('private /会话')); await settled(element);
    expect(request.mock.calls[1][0]).toContain('private%20%2F%E4%BC%9A%E8%AF%9D&paged=true&limit=100');
    expect(element.shadowRoot!.textContent).toContain('思考记录：');
    expect(element.shadowRoot!.textContent).not.toContain('[object Object]');
    expect(element.shadowRoot!.textContent).not.toContain('Invalid Date');
    await element.loadMessages(); await settled(element);
    expect(element.shadowRoot!.textContent).toContain('已加载 2 条 · 已加载全部消息');
    expect(element.shadowRoot!.querySelector('.message')!.textContent).toContain('更早正文');
    let resolve!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const loading = element.viewMessages(session('late'));
    element.shadowRoot!.querySelector('app-dialog')!.dispatchEvent(new CustomEvent('app-dialog-close'));
    resolve(response({ messages: [{ role: 'user', content: 'late secret' }], nextBefore: null })); await loading; await settled(element);
    expect(element.shadowRoot!.textContent).not.toContain('late secret');
  });
  it('keeps history failure distinct from empty and allows retry', async () => {
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValueOnce(response({ sessions: [session('s')] }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(response({ messages: [], nextBefore: null }));
    const element = new AgentSessionsPage(); document.body.append(element); await settled(element);
    await element.viewMessages(session('s')); await settled(element);
    expect(element.shadowRoot!.textContent).toContain('读取消息历史失败');
    expect(element.shadowRoot!.textContent).not.toContain('暂无消息');
    await element.loadMessages(); await settled(element);
    expect(element.shadowRoot!.textContent).toContain('暂无消息');
  });
  it('requires acknowledged and confirmed skill state, encodes name and prevents double submission', async () => {
    localStorage.setItem('permissions', '["config:manage"]');
    const request = vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValueOnce(response({ skills: [skill()] }));
    const element = new AgentSkillsPage(); document.body.append(element); await settled(element);
    let resolve!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValueOnce(response({ skills: [skill(false)] }));
    const pending = element.toggleSkill(skill()); await element.toggleSkill(skill());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain('/path%2F%E6%8A%80%E8%83%BD/toggle');
    resolve(response({ ok: true })); await pending; await settled(element);
    expect(element.shadowRoot!.querySelector('tbody')!.textContent).toContain('已禁用');
    request.mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ skills: [skill(false)] }));
    await element.toggleSkill(skill(false)); await settled(element);
    expect(element.shadowRoot!.querySelector('[role="alert"]')!.textContent).toContain('状态尚未确认');
    expect(element.shadowRoot!.querySelector('tbody')!.textContent).toContain('已禁用');
  });
  it('hides management without permission and does not mutate', async () => {
    localStorage.setItem('permissions', '["ai:view"]');
    const request = vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValue(response({ skills: [skill()] }));
    const element = new AgentSkillsPage(); document.body.append(element); await settled(element);
    expect(element.shadowRoot!.querySelector('tbody')!.textContent).toContain('需配置管理权限');
    await element.toggleSkill(skill()); expect(request).toHaveBeenCalledTimes(1);
    localStorage.removeItem('permissions');
  });
});

describe('MAX-176 authorization during details', () => {
  it('clears prior history if permission is revoked while loading an older page', async () => {
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValueOnce(response({ sessions: [session('secret')] }))
      .mockResolvedValueOnce(response({ messages: [{ role: 'user', content: 'private body', timestamp: 1 }], nextBefore: 9 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    const element = new AgentSessionsPage(); document.body.append(element); await settled(element);
    await element.viewMessages(session('secret')); await settled(element);
    expect(element.shadowRoot!.textContent).toContain('private body');
    await element.loadMessages(); await settled(element);
    expect(element.shadowRoot!.textContent).not.toContain('private body');
    expect(element.shadowRoot!.textContent).toContain('当前没有查看权限');
  });
  it('does not read back or restore a skill mutation after session expiry', async () => {
    localStorage.setItem('permissions', '["config:manage"]');
    const request = vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValueOnce(response({ skills: [skill()] }));
    const element = new AgentSkillsPage(); document.body.append(element); await settled(element);
    let resolve!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = element.toggleSkill(skill()); window.dispatchEvent(new Event('slide-session-expired'));
    resolve(response({ ok: true })); await pending; await settled(element);
    expect(request).toHaveBeenCalledTimes(2);
    expect(element.shadowRoot!.textContent).not.toContain(skill().filePath);
    expect(element.shadowRoot!.textContent).toContain('登录已失效');
    localStorage.removeItem('permissions');
  });
});
