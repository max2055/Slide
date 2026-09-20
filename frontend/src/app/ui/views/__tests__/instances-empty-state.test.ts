import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../../api/index.js', () => ({ authFetch: vi.fn(async () => ({ ok: true, json: async () => [] })) }));
import '../instances-db.js';
afterEach(() => document.body.replaceChildren());
it('keeps the create action and resource headers accessible for an empty inventory', async () => {
  const page = document.createElement('instances-page') as any; document.body.append(page);
  await vi.waitFor(() => expect(page.shadowRoot.querySelector('resource-metrics-table')).not.toBeNull());
  const table = page.shadowRoot.querySelector('resource-metrics-table'); await table.updateComplete;
  expect(table.shadowRoot.querySelectorAll('thead')).toHaveLength(1);
  expect(table.shadowRoot.textContent).toContain('没有符合条件的资源');
  expect([...page.shadowRoot.querySelectorAll('button')].some((b: HTMLButtonElement) => b.textContent?.includes('添加实例'))).toBe(true);
});
