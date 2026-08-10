import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));

import './instances-db.js';

const response = (body: unknown, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => body,
});

const instance = {
  id: 41,
  name: 'prod-db',
  db_type: 'mysql',
  host: '10.0.0.41',
  port: 3306,
  database_name: 'prod',
  username: 'dba',
  health_status: 'healthy',
  health_score: 99,
  status: 'active',
  created_at: '2026-08-10T00:00:00.000Z',
  environment: 'production',
  description: '',
  hasCredential: true,
  credentialVersion: 1,
};

async function settle(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

async function mountPage() {
  const page = document.createElement('instances-page') as any;
  document.body.append(page);
  await settle(page);
  return page;
}

describe('database instance host relation form', () => {
  beforeEach(() => {
    authFetch.mockReset();
    showToast.mockReset();
    localStorage.setItem('permissions', JSON.stringify(['*']));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem('permissions');
    document.body.replaceChildren();
  });

  it('retries only the host PUT after a created instance relation save fails', async () => {
    let relationWrites = 0;
    const mutationOrder: string[] = [];
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([{ id: 7, host: 'db-host', port: 22, label: 'DB host', os_type: 'RHEL 8', status: 'online', collection_enabled: true }]);
      if (url === '/api/database/instances' && options?.method === 'POST') {
        mutationOrder.push('POST /api/database/instances');
        return response({ id: 73, message: '创建成功' });
      }
      if (url === '/api/database/instances/73/hosts' && options?.method === 'PUT') {
        mutationOrder.push('PUT /api/database/instances/73/hosts');
        relationWrites += 1;
        return relationWrites === 1
          ? response({ error: 'RELATION_WRITE_FAILED' }, false)
          : response({ ok: true, hosts: [] });
      }
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._addInstance();
    page.formData = { name: 'new-db', environment: 'production', db_type: 'mysql', host: '10.0.0.73', port: 3306, username: 'dba', password: 'secret', database_name: 'prod', description: '' };
    await page.updateComplete;
    const field = page.shadowRoot.querySelector('instance-host-field');
    field.dispatchEvent(new CustomEvent('instance-host-change', {
      detail: { hosts: [{ serverId: 7, role: 'primary' }] },
      bubbles: true,
      composed: true,
    }));

    await page._handleSubmit(false);
    expect(page.pendingCreatedInstanceId).toBe(73);
    expect(page.showAddDialog).toBe(true);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances' && options?.method === 'POST')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/73/hosts' && options?.method === 'PUT')).toHaveLength(1);
    expect(mutationOrder).toEqual([
      'POST /api/database/instances',
      'PUT /api/database/instances/73/hosts',
    ]);

    await page.updateComplete;
    const root = page.shadowRoot as ShadowRoot;
    const dialog = root.querySelector('app-dialog') as HTMLElement;
    const baseControls = Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'));
    expect(baseControls.length).toBeGreaterThan(0);
    expect(baseControls.every((control) => control.disabled)).toBe(true);
    const relationField = root.querySelector('instance-host-field') as any;
    expect(relationField.disabled).toBe(false);
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.find((button) => button.textContent?.trim() === '测试连接')?.disabled).toBe(true);
    expect(buttons.find((button) => button.classList.contains('btn-primary'))?.textContent?.trim()).toBe('重试关联');

    relationField.dispatchEvent(new CustomEvent('instance-host-change', {
      detail: { hosts: [{ serverId: 7, role: 'replica' }] },
      bubbles: true,
      composed: true,
    }));

    await page._handleSubmit(false);

    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances' && options?.method === 'POST')).toHaveLength(1);
    const puts = authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/73/hosts' && options?.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(mutationOrder).toEqual([
      'POST /api/database/instances',
      'PUT /api/database/instances/73/hosts',
      'PUT /api/database/instances/73/hosts',
    ]);
    expect(JSON.parse(puts[1][1].body)).toEqual({ hosts: [{ serverId: 7, role: 'replica' }] });
    expect(page.pendingCreatedInstanceId).toBeNull();
    expect(page.showAddDialog).toBe(false);
  });

  it('saves a base edit without reading or writing host relations when relation view is absent', async () => {
    localStorage.setItem('permissions', JSON.stringify(['instance:update']));
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [] });
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return response({ ok: true });
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') return response({ ok: true, hosts: [] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    const field = page.shadowRoot.querySelector('instance-host-field');

    await page._handleSubmit(true);

    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && !options?.method)).toHaveLength(0);
    expect(field).toBeNull();
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41' && options?.method === 'PUT')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toHaveLength(0);
  });

  it.each([
    { label: 'missing', storedPermissions: null },
    { label: 'malformed JSON', storedPermissions: '{not-json' },
    { label: 'a non-array value', storedPermissions: JSON.stringify({ permissions: ['*'] }) },
  ])('fails closed for $label permissions while allowing the base edit', async ({ storedPermissions }) => {
    if (storedPermissions === null) localStorage.removeItem('permissions');
    else localStorage.setItem('permissions', storedPermissions);
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [{ serverId: 7, role: 'primary' }] });
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return response({ ok: true });
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') return response({ ok: true, hosts: [] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    await page._handleSubmit(true);

    expect(page.shadowRoot.querySelector('instance-host-field')).toBeNull();
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && !options?.method)).toHaveLength(0);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41' && options?.method === 'PUT')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toHaveLength(0);
  });

  it('fails closed when reading stored permissions throws while allowing the base edit', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === 'permissions') throw new Error('storage unavailable');
      return null;
    });
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [] });
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return response({ ok: true });
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') return response({ ok: true, hosts: [] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    await page._handleSubmit(true);

    expect(page.shadowRoot.querySelector('instance-host-field')).toBeNull();
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41' && options?.method === 'PUT')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts')).toHaveLength(0);
  });

  it('reveals host relations when permissions arrive after mount and removes the listener on disconnect', async () => {
    localStorage.removeItem('permissions');
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [{ serverId: 7, role: 'primary' }] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    expect(page.shadowRoot.querySelector('instance-host-field')).toBeNull();

    const permissions = ['instance:manage', 'servers:view', 'servers:manage'];
    localStorage.setItem('permissions', JSON.stringify(permissions));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } }));
    await settle(page);

    const field = page.shadowRoot.querySelector('instance-host-field') as any;
    expect(field).toBeTruthy();
    expect(field.disabled).toBe(false);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && !options?.method)).toHaveLength(1);

    const requestUpdate = vi.spyOn(page, 'requestUpdate');
    page.remove();
    requestUpdate.mockClear();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } }));
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it('renders host relations read-only and saves only the base edit with view permission', async () => {
    localStorage.setItem('permissions', JSON.stringify(['instance:update', 'servers:view']));
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [{ serverId: 7, role: 'primary' }] });
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return response({ ok: true });
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') return response({ ok: true, hosts: [] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    const field = page.shadowRoot.querySelector('instance-host-field') as any;

    await page._handleSubmit(true);

    expect(field).toBeTruthy();
    expect(field.disabled).toBe(true);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41' && options?.method === 'PUT')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toHaveLength(0);
  });

  it('keeps host relations read-only without instance manage permission', async () => {
    localStorage.setItem('permissions', JSON.stringify(['servers:view', 'servers:manage']));
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [{ serverId: 7, role: 'primary' }] });
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return response({ ok: true });
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') return response({ ok: true, hosts: [] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    const field = page.shadowRoot.querySelector('instance-host-field') as any;

    await page._handleSubmit(true);

    expect(field).toBeTruthy();
    expect(field.disabled).toBe(true);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41' && options?.method === 'PUT')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toHaveLength(0);
  });

  it('does not block a base edit when a read-only host relation load fails', async () => {
    localStorage.setItem('permissions', JSON.stringify(['instance:update', 'servers:view']));
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ error: 'RESOURCE_FORBIDDEN' }, false, 403);
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return response({ ok: true });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    await page._handleSubmit(true);

    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41' && options?.method === 'PUT')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toHaveLength(0);
  });

  it.each([
    { label: 'exact permissions', permissions: ['instance:manage', 'servers:view', 'servers:manage'] },
    { label: 'resource wildcard', permissions: ['instance:*', 'servers:*'] },
    { label: 'global wildcard', permissions: ['*'] },
  ])('treats $label as full host relation permission', async ({ permissions }) => {
    localStorage.setItem('permissions', JSON.stringify(permissions));
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [{ serverId: 7, role: 'primary' }] });
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return response({ ok: true });
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') return response({ ok: true, hosts: [] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    await page._handleSubmit(true);

    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && !options?.method)).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toHaveLength(1);
  });

  it('does not write host relations when the preceding base instance update is forbidden', async () => {
    const mutationOrder: string[] = [];
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [{ serverId: 7, role: 'primary' }] });
      if (url === '/api/database/instances/41' && options?.method === 'PUT') {
        mutationOrder.push('PUT /api/database/instances/41');
        return response({ error: 'RESOURCE_FORBIDDEN' }, false, 403);
      }
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') {
        mutationOrder.push('PUT /api/database/instances/41/hosts');
        return response({ ok: true, hosts: [] });
      }
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);

    await page._handleSubmit(true);

    expect(mutationOrder).toEqual(['PUT /api/database/instances/41']);
    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toHaveLength(0);
  });

  it('keeps the dialog locked and submits the original host mapping during an in-flight edit', async () => {
    let resolveBaseWrite!: (value: ReturnType<typeof response>) => void;
    const baseWrite = new Promise<ReturnType<typeof response>>((resolve) => { resolveBaseWrite = resolve; });
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) return response({ hosts: [{ serverId: 7, role: 'primary' }] });
      if (url === '/api/database/instances/41' && options?.method === 'PUT') return baseWrite;
      if (url === '/api/database/instances/41/hosts' && options?.method === 'PUT') return response({ ok: true, hosts: [] });
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);
    const submit = page._handleSubmit(true);
    await page.updateComplete;
    const root = page.shadowRoot as ShadowRoot;
    const dialog = root.querySelector('app-dialog') as HTMLElement & { closable: boolean; closeOnOverlay: boolean };
    const cancel = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === '取消');

    page.formData = { ...page.formData, name: 'mutated-after-submit' };
    page.instanceHosts[0].role = 'replica';
    dialog.dispatchEvent(new CustomEvent('app-dialog-close', { bubbles: true, composed: true }));
    await page.updateComplete;
    const lockedState = {
      open: page.showEditDialog,
      closable: dialog.closable,
      closeOnOverlay: dialog.closeOnOverlay,
      cancelDisabled: cancel?.disabled,
    };

    resolveBaseWrite(response({ ok: true }));
    await submit;

    expect(lockedState).toEqual({ open: true, closable: false, closeOnOverlay: false, cancelDisabled: true });
    const relationWrites = authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT');
    expect(relationWrites).toHaveLength(1);
    expect(JSON.parse(relationWrites[0][1].body)).toEqual({ hosts: [{ serverId: 7, role: 'primary' }] });
  });

  it.each(['cancel', 'dialog close'])('refreshes instances and warns when %s abandons a partial create', async (closeMethod) => {
    let instanceReads = 0;
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) {
        instanceReads += 1;
        return response([]);
      }
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances' && options?.method === 'POST') return response({ id: 73 });
      if (url === '/api/database/instances/73/hosts' && options?.method === 'PUT') return response({ error: 'RELATION_WRITE_FAILED' }, false);
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._addInstance();
    page.formData = { name: 'new-db', environment: 'production', db_type: 'mysql', host: '10.0.0.73', port: 3306, username: 'dba', password: 'secret', database_name: 'prod', description: '' };
    await page._handleSubmit(false);
    await page.updateComplete;
    expect(page.pendingCreatedInstanceId).toBe(73);
    const root = page.shadowRoot as ShadowRoot;

    if (closeMethod === 'cancel') {
      Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === '取消')
        ?.click();
    } else {
      root.querySelector('app-dialog')?.dispatchEvent(new CustomEvent('app-dialog-close', { bubbles: true, composed: true }));
    }
    await settle(page);

    expect(instanceReads).toBe(2);
    expect(showToast).toHaveBeenCalledWith('实例已创建但主机关联未保存', 'warning');
    expect(page.showAddDialog).toBe(false);
  });

  it('keeps a failed edit relation unknown, blocks save, and reloads it explicitly', async () => {
    let relationReads = 0;
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/database/instances' && !options?.method) return response([]);
      if (url === '/api/servers') return response([]);
      if (url === '/api/database/instances/41/hosts' && !options?.method) {
        relationReads += 1;
        return relationReads === 1
          ? response({ error: 'RESOURCE_FORBIDDEN' }, false, 403)
          : response({ hosts: [{ serverId: 7, role: 'primary', host: 'db-host', port: 22, label: null, osType: 'RHEL 8', status: 'online', collectionEnabled: true, validFrom: '2026-08-10T00:00:00.000Z' }] });
      }
      throw new Error(`unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    const page = await mountPage();
    page._editInstance(instance);
    await settle(page);

    expect(page.instanceHosts).toBeNull();
    expect(page.hostRelationError).toBeTruthy();
    const root = page.shadowRoot as ShadowRoot;
    const field = root.querySelector('instance-host-field') as any;
    expect(field.value).toBeNull();
    const formFields = Array.from(root.querySelectorAll('app-form-field')) as Array<HTMLElement & { label: string }>;
    const renderedValue = (label: string) => formFields
      .find((formField) => formField.label === label)
      ?.querySelector<HTMLInputElement>('input')?.value;
    expect(renderedValue('实例名称')).toBe('prod-db');
    expect(renderedValue('主机地址')).toBe('10.0.0.41');
    expect(renderedValue('用户名')).toBe('dba');
    expect(renderedValue('数据库名')).toBe('prod');
    const save = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('保存修改'));
    expect(save?.disabled).toBe(true);

    await page._handleSubmit(true);
    expect(authFetch.mock.calls.some(([url, options]) => url === '/api/database/instances/41' && options?.method === 'PUT')).toBe(false);
    expect(authFetch.mock.calls.some(([url, options]) => url === '/api/database/instances/41/hosts' && options?.method === 'PUT')).toBe(false);
    expect(page.instanceHosts).toBeNull();

    (field.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('[data-action="reload"]')?.click();
    await settle(page);
    expect(relationReads).toBe(2);
    expect(page.instanceHosts).toEqual([{ serverId: 7, role: 'primary' }]);
  });
});
