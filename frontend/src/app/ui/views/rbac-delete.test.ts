import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { apiClient } from '../../../api/index.js';
import { PermissionManagementTab, RoleManagementTab } from './rbac-page.ts';
import { showToast } from '../components/app-toast-container.ts';

vi.mock('../components/app-toast-container.ts', () => ({ showToast: vi.fn() }));

// MAX-359 / #670: a failed delete must leave the loaded list usable.
for (const kind of ['roles', 'permissions'] as const) {
  describe(`${kind} delete recovery`, () => {
    afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

    async function setup() {
      const view = kind === 'roles' ? new RoleManagementTab() : new PermissionManagementTab();
      const item = { id: 9, name: '测试对象', code: 'db:read', resource: 'db', action: 'read', description: null };
      const get = vi.spyOn(apiClient, 'get').mockResolvedValue([item]);
      const del = vi.spyOn(apiClient, 'delete').mockResolvedValue({});
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await view.firstUpdated();
      const dom = () => {
        const host = document.createElement('div');
        render(view.render(), host);
        return host;
      };
      const remove = () => kind === 'roles' ? (view as any)._deleteRole(item) : (view as any)._deletePermission(item);
      return { get, del, confirm, dom, remove };
    }

    it('keeps the row and actions after failure and allows a successful retry', async () => {
      const h = await setup();
      h.del.mockRejectedValueOnce(new Error('对象仍被引用'));
      await h.remove();
      expect(h.dom().querySelector('tbody')?.textContent).toContain('测试对象');
      expect(h.dom().querySelector<HTMLButtonElement>('.danger')?.disabled).toBe(false);
      expect(h.dom().querySelector('.error-msg')).toBeNull();
      expect(showToast).toHaveBeenCalledExactlyOnceWith('删除失败：对象仍被引用', 'error');
      expect(h.get).toHaveBeenCalledTimes(1);
      h.get.mockResolvedValueOnce([]);
      await h.remove();
      expect(h.del).toHaveBeenNthCalledWith(2, `/v1/rbac/${kind}/9`);
      expect(h.dom().querySelector('app-empty-state')).not.toBeNull();
      expect(h.confirm).toHaveBeenCalledTimes(2);
      expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('does not send a delete or display an error when confirmation is cancelled', async () => {
      const h = await setup();
      h.confirm.mockReturnValue(false);
      await h.remove();
      expect(h.del).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      expect(h.dom().querySelector('tbody')?.textContent).toContain('测试对象');
    });

    it('retains the page error for a failed initial load', async () => {
      const h = await setup();
      h.get.mockRejectedValueOnce(new Error('服务不可用'));
      // Exercise the public initial-load lifecycle again with the failed response.
      const view = kind === 'roles' ? new RoleManagementTab() : new PermissionManagementTab();
      await view.firstUpdated();
      const host = document.createElement('div');
      render(view.render(), host);
      expect(host.querySelector('.error-msg')?.textContent).toContain('加载失败：服务不可用');
      expect(host.querySelector('tbody')).toBeNull();
      expect(showToast).not.toHaveBeenCalled();
    });
  });
}
