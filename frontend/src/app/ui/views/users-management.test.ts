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


it('#625: clearing email sends an explicit empty string', async () => {
  view._openEditModal(user);
  view.formEmail = '';
  await view._saveUser();
  expect(apiClient.put).toHaveBeenCalledWith('/users/42', { status: 'active', email: '' });
  expect(view.showModal).toBe(false);
});

it('#686: failed role binding keeps the created user and retries only its binding', async () => {
  view._openCreateModal();
  view.formUsername = 'created'; view.formPassword = 'password123'; view.formRoleId = 3;
  vi.mocked(apiClient.post).mockResolvedValueOnce({ success: true, userId: 73 })
    .mockRejectedValueOnce(new Error('HTTP 403: 无权限'))
    .mockRejectedValueOnce(new Error('HTTP 500: 暂不可用'))
    .mockResolvedValueOnce({ success: true });
  await view._saveUser();
  expect(view.showModal).toBe(true);
  expect(view.saveError).toContain('用户已创建');
  expect(view.saveError).toContain('角色未绑定');
  expect(view.formPassword).toBe('');
  await view._saveUser();
  expect(view.showModal).toBe(true);
  await view._saveUser();
  expect(apiClient.post).toHaveBeenCalledTimes(4);
  expect(vi.mocked(apiClient.post).mock.calls.slice(1)).toEqual(Array(3).fill([['/v1/rbac/users', 73, 'roles'].join('/'), { roleId: 3 }]));
  expect(view.showModal).toBe(false);
  expect(view._loadUsers).toHaveBeenCalledOnce();
});

it('#686: prevents double saves and closing during a pending create', async () => {
  view._openCreateModal();
  view.formUsername = 'created'; view.formPassword = 'password123';
  let finish!: (result: any) => void;
  vi.mocked(apiClient.post).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = view._saveUser();
  view._closeModal();
  await view._saveUser();
  expect(view.showModal).toBe(true);
  expect(apiClient.post).toHaveBeenCalledOnce();
  finish({ success: true, userId: 74 }); await pending;
  expect(view.showModal).toBe(false);
});


it('#686: an explicit failed role response also retains the pending user', async () => {
  view._openCreateModal(); view.formUsername = 'new'; view.formPassword = 'password123'; view.formRoleId = 3;
  vi.mocked(apiClient.post).mockResolvedValueOnce({ success: true, userId: 75 }).mockResolvedValueOnce({ success: false, error: '角色不存在' });
  await view._saveUser();
  expect(view.saveError).toContain('角色不存在');
  expect(view.createdUserId).toBe(75);
  view.formRoleId = null; await view._saveUser();
  expect(view.formErrors).toContain('用户已创建，请选择要绑定的角色');
  expect(apiClient.post).toHaveBeenCalledTimes(2);
  view._closeModal(); view._openCreateModal();
  expect(view.createdUserId).toBeNull();
  expect(view.formPassword).toBe('');
});

it('#686: successful creation without a role closes normally', async () => {
  view._openCreateModal(); view.formUsername = 'new'; view.formPassword = 'password123';
  vi.mocked(apiClient.post).mockResolvedValueOnce({ success: true, userId: 76 });
  await view._saveUser();
  expect(apiClient.post).toHaveBeenCalledOnce();
  expect(view.showModal).toBe(false);
});
