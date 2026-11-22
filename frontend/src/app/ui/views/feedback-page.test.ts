import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDataTable } from '../components/app-data-table.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  getSessionContext: vi.fn(),
  getToken: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../../api/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../api/index.js')>(),
  apiClient: mocks,
  authFetch: mocks.read,
}));

import './feedback-page.js';

const feedback = {
  id: 3,
  title: '连接页报错',
  description: '用户在连接页保存配置时看到错误提示，重新加载页面后配置仍未保存，并且连续重试会重复出现相同错误，需要开发者检查保存接口。',
  source: 'agent',
  status: 'pending',
  createdBy: 7,
  createdByUsername: 'alice',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T01:00:00.000Z',
};

async function renderPage() {
  const element = document.createElement('feedback-page');
  document.body.append(element);
  await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledWith('/api/feedback', expect.objectContaining({ cache: 'no-store' })));
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector('[data-read-results]')?.getAttribute('aria-busy')).toBe('false'));
  await element.shadowRoot?.querySelector<AppDataTable>('app-data-table')?.updateComplete;
  return element;
}

describe('feedback-page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetAllMocks();
    mocks.getSessionContext.mockReturnValue(1);
    mocks.getToken.mockReturnValue('feedback-fixture');
    mocks.read.mockImplementation(() => Promise.resolve(Response.json({ feedback: [feedback] })));
    mocks.post.mockResolvedValue({ feedback });
    mocks.put.mockResolvedValue({ feedback: { ...feedback, status: 'accepted' } });
    mocks.delete.mockResolvedValue({ success: true });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('renders the empty message only after receiving an explicit empty list', async () => {
    mocks.read.mockResolvedValueOnce(Response.json({ feedback: [] }));
    const root = (await renderPage()).shadowRoot!;
    expect(root.querySelector('app-empty-state')?.getAttribute('title')).toBe('暂无问题反馈');

    mocks.read.mockResolvedValueOnce(Response.json({}));
    root.querySelector<HTMLButtonElement>('.header-actions .btn-refresh')!.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('响应格式无效'));
    expect(root.querySelector('app-empty-state')).toBeNull();
    expect(root.querySelector('app-data-table')).toBeNull();
  });

  it.each([
    Response.json({}, { status: 401 }),
    Response.json({}, { status: 403 }),
    Response.json({ error: 'SESSION_REFRESH_UNCONFIRMED' }, { status: 503 }),
  ])('clears previous records on HTTP $status when list authorization is denied or uncertain', async response => {
    const root = (await renderPage()).shadowRoot!;
    expect(root.textContent).toContain(feedback.title);
    mocks.read.mockResolvedValueOnce(response);
    root.querySelector<HTMLButtonElement>('.header-actions .btn-refresh')!.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('访问权限'));
    expect(root.textContent).not.toContain(feedback.title);
    expect(root.querySelector('time')).toBeNull();
  });

  it('discards older reads after permission changes and clears the previous scope during a failed recheck', async () => {
    const root = (await renderPage()).shadowRoot!;
    let resolveOldRead!: (response: Response) => void;
    const oldRead = new Promise<Response>(resolve => { resolveOldRead = resolve; });
    mocks.read.mockReturnValueOnce(oldRead);
    root.querySelector<HTMLButtonElement>('.header-actions .btn-refresh')!.click();
    const signal = mocks.read.mock.lastCall?.[1].signal as AbortSignal;
    mocks.read.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503'));
    resolveOldRead(Response.json({ feedback: [feedback] }));
    await oldRead;
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503'));
    expect(root.textContent).not.toContain(feedback.title);
    expect(root.querySelector('time')).toBeNull();
  });

  it('loads Agent-recorded feedback and renders the CRUD controls', async () => {
    const element = await renderPage();
    const root = element.shadowRoot!;
    expect(root.textContent).toContain('问题反馈');
    expect(root.textContent).toContain('连接页报错');
    expect(root.textContent).toContain('Agent');
    expect(root.textContent).toContain('未接收');
    expect(root.querySelector('.serial')?.textContent).toBe('3');
    const headers = [...root.querySelectorAll('app-data-table thead th')].map((header) => header.textContent?.trim());
    expect(headers).toContain('创建时间');
    expect(headers.indexOf('创建时间')).toBeLessThan(headers.indexOf('更新时间'));
    const cells = [...root.querySelectorAll('app-data-table tbody tr td')];
    expect(cells[6]?.textContent).toContain('2026');
    expect(cells[6]?.textContent).not.toBe(cells[7]?.textContent);
    expect(root.querySelector('app-data-table')).not.toBeNull();
    expect(root.querySelector('button[aria-label="编辑 连接页报错"]')).not.toBeNull();
    expect(root.querySelector('button[aria-label="删除 连接页报错"]')).not.toBeNull();
  });

  it('copies and updates a feedback item status', async () => {
    const element = await renderPage();
    const root = element.shadowRoot!;
    root.querySelector<HTMLButtonElement>('button[aria-label="复制 连接页报错 的问题描述"]')!.click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(feedback.description));

    const status = root.querySelector<HTMLSelectElement>('select[aria-label="更新 连接页报错 的状态"]')!;
    status.value = 'accepted';
    status.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/feedback/3', {
      title: feedback.title,
      description: feedback.description,
      status: 'accepted',
    }));
    await element.updateComplete;
    expect(root.querySelector<HTMLSelectElement>('select[aria-label="更新 连接页报错 的状态"]')?.value).toBe('accepted');
  });

  it.each(['HTTP拒绝', '网络失败'])('MAX-430: restores confirmed status after %s and blocks duplicate writes', async () => {
    let reject!: (error: Error) => void;
    mocks.put.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const element = await renderPage();
    const status = element.shadowRoot!.querySelector<HTMLSelectElement>('select.status-select')!;
    status.value = 'resolved';
    status.dispatchEvent(new Event('change'));
    await element.updateComplete;
    expect(status.disabled).toBe(true);
    status.dispatchEvent(new Event('change'));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    reject(new Error('request failed'));
    await vi.waitFor(() => expect(status.disabled).toBe(false));
    expect(status.value).toBe('pending');
    status.value = 'resolved';
    status.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(status.value).toBe('accepted'));
    expect(mocks.put).toHaveBeenCalledTimes(2);
  });

  it('creates a feedback item and refreshes history', async () => {
    const element = await renderPage();
    const root = element.shadowRoot!;
    (root.querySelector('.page-header .btn-primary') as HTMLButtonElement).click();
    await element.updateComplete;

    const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.field');
    fields[0].value = '新问题';
    fields[0].dispatchEvent(new Event('input'));
    fields[1].value = '用户在报表页导出时没有收到文件。';
    fields[1].dispatchEvent(new Event('input'));
    await element.updateComplete;
    (root.querySelector('app-dialog button.btn-primary') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/feedback', {
      title: '新问题',
      description: '用户在报表页导出时没有收到文件。',
    }));
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it('updates and deletes the selected feedback item', async () => {
    const element = await renderPage();
    const root = element.shadowRoot!;
    (root.querySelector('button[aria-label="编辑 连接页报错"]') as HTMLButtonElement).click();
    await element.updateComplete;
    const title = root.querySelector<HTMLInputElement>('input.field')!;
    title.value = '连接页仍然报错';
    title.dispatchEvent(new Event('input'));
    await element.updateComplete;
    (root.querySelector('app-dialog button.btn-primary') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/feedback/3', expect.objectContaining({ title: '连接页仍然报错' })));
    const deleteTrigger = await vi.waitFor(() => {
      const button = root.querySelector<HTMLButtonElement>('button[aria-label="删除 连接页报错"]');
      expect(button).not.toBeNull();
      expect(root.querySelector<HTMLButtonElement>('.header-actions .btn-refresh')?.disabled).toBe(false);
      return button!;
    });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    deleteTrigger.click();
    await element.updateComplete;
    const dialogs = root.querySelectorAll('app-dialog');
    const deleteButton = dialogs[1].querySelector<HTMLButtonElement>('.btn-danger')!;
    deleteButton.click();
    await vi.waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/feedback/3'));
  });
});
