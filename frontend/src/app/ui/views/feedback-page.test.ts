import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../../api/index.js', () => ({ apiClient: mocks }));

import './feedback-page.js';

const feedback = {
  id: 3,
  title: '连接页报错',
  description: '用户在连接页保存配置时看到错误提示。',
  source: 'agent',
  createdBy: 7,
  createdByUsername: 'alice',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T01:00:00.000Z',
};

async function renderPage() {
  const element = document.createElement('feedback-page') as unknown as HTMLElement & { updateComplete: Promise<unknown> };
  document.body.append(element);
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/feedback'));
  await element.updateComplete;
  return element;
}

describe('feedback-page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ feedback: [feedback] });
    mocks.post.mockResolvedValue({ feedback });
    mocks.put.mockResolvedValue({ feedback });
    mocks.delete.mockResolvedValue({ success: true });
  });

  it('loads Agent-recorded feedback and renders the CRUD controls', async () => {
    const element = await renderPage();
    const root = element.shadowRoot!;
    expect(root.textContent).toContain('问题反馈');
    expect(root.textContent).toContain('连接页报错');
    expect(root.textContent).toContain('Agent');
    expect(root.querySelector('app-data-table')).not.toBeNull();
    expect(root.querySelector('button[aria-label="编辑 连接页报错"]')).not.toBeNull();
    expect(root.querySelector('button[aria-label="删除 连接页报错"]')).not.toBeNull();
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
    expect(mocks.get).toHaveBeenCalledTimes(2);
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
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await element.updateComplete;

    (root.querySelector('button[aria-label="删除 连接页报错"]') as HTMLButtonElement).click();
    await element.updateComplete;
    const dialogs = root.querySelectorAll('app-dialog');
    const deleteButton = dialogs[1].querySelector<HTMLButtonElement>('.btn-danger')!;
    deleteButton.click();
    await vi.waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/feedback/3'));
  });
});
