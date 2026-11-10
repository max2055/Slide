import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../../api/index.js';
import { RoleManagementTab, InstancePermissionsTab } from './rbac-page.ts';

for (const role of [true, false]) describe(`MAX-360 ${role ? 'role' : 'user'} load ownership`, () => {
  afterEach(() => vi.restoreAllMocks());
  const selected = role ? 'checkedPermIds' : 'grantedInstanceIds';
  const error = role ? 'permError' : 'saveError';
  const loading = role ? 'permLoading' : 'loadingInstances';
  function setup() {
    const view: any = role ? new RoleManagementTab() : new InstancePermissionsTab();
    const pending: { resolve: (v: any) => void; reject: (e: Error) => void }[] = [];
    vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const open = (id: number) => role ? view._openPermModal({ id, name: `角色${id}` }) : view._openModal({ id, username: `用户${id}` });
    const close = () => role ? view._closePermModal() : view._closeModal();
    const resolve = (offset: number, id: number) => {
      pending[offset].resolve([{ id, name: `权限${id}` }]);
      pending[offset + 1].resolve(role ? [{ id }] : [id]);
    };
    return { view, pending, open, close, resolve };
  }
  for (const same of [false, true]) it(`ignores old success after ${same ? 'same-object reopen' : 'A to B switch'}`, async () => {
    const h = setup(); const old = h.open(1);
    if (same) h.close();
    const current = h.open(same ? 1 : 2);
    h.resolve(2, 22); await current;
    h.resolve(0, 11); await old;
    expect(h.view[selected]).toEqual(new Set([22]));
  });
  it('ignores success after closing', async () => {
    const h = setup(); const old = h.open(1); h.close(); h.resolve(0, 11); await old;
    expect(h.view[selected]).toEqual(new Set());
  });
  it('ignores stale failure and its finally while current load is pending', async () => {
    const h = setup(); const old = h.open(1); const current = h.open(2);
    h.pending[0].reject(new Error('过期失败')); await old;
    expect(h.view[error]).toBeNull(); expect(h.view[loading]).toBe(true);
    h.resolve(2, 22); await current;
    expect(h.view[selected]).toEqual(new Set([22])); expect(h.view[loading]).toBe(false);
  });
  it('reports current failure and accepts a normal retry', async () => {
    const h = setup(); const current = h.open(1); h.pending[0].reject(new Error('当前失败')); await current;
    expect(h.view[error]).toContain('当前失败'); expect(h.view[loading]).toBe(false);
    const retry = h.open(1); h.resolve(2, 22); await retry;
    expect(h.view[error]).toBeNull(); expect(h.view[selected]).toEqual(new Set([22]));
  });
});
