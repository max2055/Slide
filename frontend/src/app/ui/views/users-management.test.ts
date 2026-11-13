import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { UsersManagement } from './users-management.ts';
import { apiClient } from '../../../api/index.js';

const user = { id: 42, username: 'dual', email: 'before@example.test', status: 'active' };
let view: any;
beforeEach(() => {
  view = new UsersManagement();
  view.userRoles = new Map([[42, [{ role_id: 2, role_name: 'dba' }, { role_id: 3, role_name: 'auditor' }]]]);
  vi.spyOn(apiClient, 'put').mockResolvedValue({ success: true });
  vi.spyOn(apiClient, 'post').mockResolvedValue({ success: true });
  vi.spyOn(apiClient, 'delete').mockResolvedValue({ success: true });
  view._loadUsers = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

it('MAX-339: changing only profile preserves both roles without role writes', async () => {
  view._openEditModal(user);
  view.formEmail = 'after@example.test';
  await view._saveUser();
  expect(apiClient.put).toHaveBeenCalledWith('/users/42', { email: 'after@example.test', status: 'active' });
  expect(apiClient.delete).not.toHaveBeenCalled();
  expect(apiClient.post).not.toHaveBeenCalled();
});
it('MAX-339: explicit changes submit only the selected role differences', async () => {
  view._openEditModal(user);
  expect(view.formRoleIds).toEqual([2, 3]);
  view.formRoleIds = [3, 4];
  await view._saveUser();
  expect(apiClient.put).toHaveBeenCalledWith('/v1/rbac/users/42/roles', { roleIds: [3, 4], expectedRoleIds: [2, 3] });
  expect(apiClient.delete).not.toHaveBeenCalled();
});
it('MAX-339: cancelling never writes and reopening restores the complete selection', () => {
  view._openEditModal(user);
  view.formRoleIds = [];
  view._closeModal();
  view._openEditModal(user);
  expect(view.formRoleIds).toEqual([2, 3]);
  expect(apiClient.put).not.toHaveBeenCalled();
  expect(apiClient.delete).not.toHaveBeenCalled();
});
it('MAX-339: profile permission rejection never proceeds to role writes', async () => {
  vi.mocked(apiClient.put).mockRejectedValue(new Error('HTTP 403'));
  view._openEditModal(user);
  view.formRoleIds = [];
  await view._saveUser();
  expect(view.saveError).toContain('403');
  expect(view.showModal).toBe(true);
  expect(apiClient.delete).not.toHaveBeenCalled();
});
it('MAX-339: clearing selection explicitly removes both roles', async () => {
  view._openEditModal(user);
  view.formRoleIds = [];
  await view._saveUser();
  expect(apiClient.put).toHaveBeenCalledWith('/v1/rbac/users/42/roles', { roleIds: [], expectedRoleIds: [2, 3] });
  expect(apiClient.post).not.toHaveBeenCalled();
});
it('MAX-339: role catalogue failure retains every bound role in the editor', async () => {
  view.isAdmin = true;
  view.loading = false;
  view._openEditModal(user);
  const { render } = await import('lit');
  const host = document.createElement('div');
  render(view.render(), host);
  const checked = host.querySelectorAll('input[type="checkbox"]:checked');
  expect(checked).toHaveLength(2);
  expect(host.textContent).toContain('数据库管理员');
  expect(host.textContent).toContain('审计员');
});

it('MAX-340: rejected atomic replacement keeps editor open and reports failure', async () => {
  vi.mocked(apiClient.put).mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('角色已被其他操作修改'));
  view._openEditModal(user);
  view.formRoleIds = [4];
  await view._saveUser();
  expect(view.showModal).toBe(true);
  expect(view.saveError).toContain('角色已被其他操作修改');
  expect(view.userRoles.get(42).map((r: any) => r.role_id)).toEqual([2, 3]);
  expect(apiClient.delete).not.toHaveBeenCalled();
});
