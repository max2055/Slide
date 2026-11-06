import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { apiClient } from '../../../api/index.js';
import { RoleManagementTab, InstancePermissionsTab } from './rbac-page.ts';

// MAX-354 / MAX-356: the API commits each write independently.
for (const kind of ['role', 'instance'] as const) {
  describe(`${kind} permission save recovery`, () => {
    afterEach(() => vi.restoreAllMocks());
    async function setup(initial = [1, 2]) {
      const role = kind === 'role';
      const view: any = role ? new RoleManagementTab() : new InstancePermissionsTab();
      const items = [1, 2, 3, 4].map(id => ({ id, name: `对象${id}`, resource: 'db', code: `db.${id}` }));
      const server = new Set(initial);
      const endpoint = role ? '/v1/rbac/roles/9/permissions' : '/v1/rbac/users/9/instances';
      const selected = role ? 'checkedPermIds' : 'grantedInstanceIds';
      const baseline = role ? 'savedPermIds' : 'savedGrantedIds';
      const error = role ? 'permError' : 'saveError';
      const open = () => role ? view._openPermModal({ id: 9, name: '测试角色' }) : view._openModal({ id: 9, username: '测试用户' });
      const save = () => role ? view._savePermissions() : view._saveInstancePerms();
      const close = () => role ? view._closePermModal() : view._closeModal();
      const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
        if (url === endpoint) return role ? items.filter(i => server.has(i.id)) : [...server];
        return items;
      });
      const post = vi.spyOn(apiClient, 'post').mockImplementation(async (_url: string, body: any) => { server.add(body[role ? 'permissionId' : 'instanceId']); return {}; });
      const del = vi.spyOn(apiClient, 'delete').mockImplementation(async (url: string) => { server.delete(Number(url.split('/').pop())); return {}; });
      view._loadRoles = vi.fn(); view._loadUsers = vi.fn();
      await open();
      const dom = () => {
        const host = document.createElement('div');
        render(role ? view._renderPermModal() : view._renderModal(), host);
        return host;
      };
      return { view, server, endpoint, selected, baseline, error, open, save, close, get, post, del, dom };
    }
    it('reconciles a mid-grant failure and reports only server-confirmed changes', async () => {
      const h = await setup();
      h.view[h.selected] = new Set([2, 3, 4]);
      h.post.mockImplementationOnce(async () => { h.server.add(3); return {}; }).mockRejectedValueOnce(new Error('授权失败'));
      await h.save();
      expect([...h.view[h.selected]].sort()).toEqual([1, 2, 3]);
      expect(h.view[h.baseline]).toEqual(h.view[h.selected]);
      expect(h.dom().textContent).toContain('新增授权：对象3');
      expect(h.dom().textContent).toContain('已重新加载');
      expect(h.del).not.toHaveBeenCalled();
      h.close(); await h.open();
      expect([...h.dom().querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map(i => Number(i.id.split('-')[1]))).toEqual([1, 2, 3]);
    });
    it('reconciles a mid-revoke failure, then retries only the remaining differences', async () => {
      const h = await setup();
      h.view[h.selected] = new Set([3]);
      h.del.mockImplementationOnce(async () => { h.server.delete(1); return {}; }).mockRejectedValueOnce(new Error('回收失败'));
      await h.save();
      expect(h.view[h.selected]).toEqual(new Set([2, 3]));
      expect(h.dom().textContent).toContain('新增授权：对象3');
      expect(h.dom().textContent).toContain('撤销授权：对象1');
      h.view[h.selected] = new Set([3]);
      await h.save();
      expect(h.server).toEqual(new Set([3]));
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.del.mock.calls.map(c => c[0])).toEqual([`${h.endpoint}/1`, `${h.endpoint}/2`, `${h.endpoint}/2`]);
    });
    it('uses server state even when a committed write loses its response', async () => {
      const h = await setup();
      h.view[h.selected] = new Set([1, 2, 3]);
      h.post.mockImplementationOnce(async () => { h.server.add(3); throw new Error('连接断开'); });
      await h.save();
      expect(h.view[h.selected]).toEqual(new Set([1, 2, 3]));
      expect(h.dom().textContent).toContain('新增授权：对象3');
    });
    it('blocks saving after failed reconciliation until a successful reopen', async () => {
      const h = await setup();
      h.view[h.selected] = new Set([1, 2, 3, 4]);
      h.post.mockImplementationOnce(async () => { h.server.add(3); return {}; }).mockRejectedValueOnce(new Error('写入失败'));
      h.get.mockRejectedValueOnce(new Error('读取失败'));
      await h.save();
      expect(h.dom().textContent).toContain('重新加载失败');
      expect(h.dom().textContent).toContain('对象3');
      expect(h.dom().querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true);
      await h.save();
      expect(h.post).toHaveBeenCalledTimes(2);
      h.close(); await h.open();
      expect(h.view[h.selected]).toEqual(new Set([1, 2, 3]));
      expect(h.dom().querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(false);
    });
    it('does not allow saving stale selections when reopening fails', async () => {
      const h = await setup();
      h.close(); h.get.mockRejectedValue(new Error('不可用')); await h.open();
      expect(h.dom().querySelector<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true);
      await h.save();
      expect(h.post).not.toHaveBeenCalled(); expect(h.del).not.toHaveBeenCalled();
    });
    if (kind === 'instance') it('reads the real instance_id response on open and recovery', async () => {
      const h = await setup();
      h.get.mockImplementation(async (url: string) => url === h.endpoint
        ? [...h.server].map(instance_id => ({ instance_id, access_level: 'read-only' }))
        : [1, 2, 3].map(id => ({ id, name: `对象${id}` })));
      await h.open();
      expect(h.view[h.selected]).toEqual(new Set([1, 2]));
      h.view[h.selected] = new Set([1, 2, 3]);
      h.post.mockImplementationOnce(async () => { h.server.add(3); throw new Error('回执丢失'); });
      await h.save();
      expect(h.view[h.selected]).toEqual(new Set([1, 2, 3]));
    });
    it('successfully saves grants and revokes and reopens from server state', async () => {
      const h = await setup();
      h.view[h.selected] = new Set([2, 3]);
      await h.save(); await h.open();
      expect(h.server).toEqual(new Set([2, 3]));
      expect(h.view[h.selected]).toEqual(h.server);
      expect(h.view[h.error]).toBeNull();
    });
    it('keeps the editor and selection stable while saving', async () => {
      const h = await setup();
      h.view[h.selected] = new Set([1, 2, 3]);
      let done!: () => void;
      h.post.mockImplementationOnce(() => new Promise(resolve => { done = () => { h.server.add(3); resolve({}); }; }));
      const pending = h.save();
      h.close();
      expect(h.dom().querySelector('app-dialog')).not.toBeNull();
      expect([...h.dom().querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(i => i.disabled)).toBe(true);
      await h.save(); expect(h.post).toHaveBeenCalledTimes(1);
      done(); await pending;
    });
  });
}
