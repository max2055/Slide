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
  });

  afterEach(() => {
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

    await page._handleSubmit(false);

    expect(authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances' && options?.method === 'POST')).toHaveLength(1);
    const puts = authFetch.mock.calls.filter(([url, options]) => url === '/api/database/instances/73/hosts' && options?.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(mutationOrder).toEqual([
      'POST /api/database/instances',
      'PUT /api/database/instances/73/hosts',
      'PUT /api/database/instances/73/hosts',
    ]);
    expect(JSON.parse(puts[1][1].body)).toEqual({ hosts: [{ serverId: 7, role: 'primary' }] });
    expect(page.pendingCreatedInstanceId).toBeNull();
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
