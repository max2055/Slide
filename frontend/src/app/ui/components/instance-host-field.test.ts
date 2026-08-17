import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));

import './instance-host-field.js';

type HostFieldElement = HTMLElement & {
  value: Array<{ serverId: number; role: string }> | null;
  error: string | null;
  updateComplete: Promise<unknown>;
};

const response = (body: unknown, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => body,
});

async function settle(element: HostFieldElement) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

describe('instance-host-field', () => {
  beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue(response([
      { id: 7, host: 'db-a.internal', port: 22, label: 'DB A', os_type: 'RHEL 8', status: 'online', collection_enabled: true },
      { id: 8, host: 'db-b.internal', port: 22, label: null, os_type: 'Linux', status: 'offline', collection_enabled: true },
      { id: 9, host: 'win.internal', port: 5985, label: 'Windows', os_type: 'Windows Server 2022', status: 'online', collection_enabled: true },
    ]));
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('loads Linux host options without emitting a user change event', async () => {
    const element = document.createElement('instance-host-field') as HostFieldElement;
    element.value = [];
    const changes = vi.fn();
    element.addEventListener('instance-host-change', changes);
    document.body.append(element);

    await settle(element);

    expect(authFetch).toHaveBeenCalledWith('/api/servers');
    expect(element.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).toHaveLength(2);
    expect(element.shadowRoot?.textContent).not.toContain('Windows');
    expect(changes).not.toHaveBeenCalled();
  });

  it('emits mappings only when the user selects a host or edits its role', async () => {
    const element = document.createElement('instance-host-field') as HostFieldElement;
    element.value = [];
    const details: unknown[] = [];
    element.addEventListener('instance-host-change', (event) => {
      details.push((event as CustomEvent).detail);
    });
    document.body.append(element);
    await settle(element);

    element.shadowRoot?.querySelector<HTMLInputElement>('input[value="7"]')?.click();
    await element.updateComplete;
    expect(details).toEqual([{ hosts: [{ serverId: 7, role: 'standalone' }] }]);

    const role = element.shadowRoot?.querySelector<HTMLSelectElement>('select[data-server-id="7"]');
    expect(role).toBeTruthy();
    role!.value = 'primary';
    role!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(details.at(-1)).toEqual({ hosts: [{ serverId: 7, role: 'primary' }] });
  });

  it('preserves both selected hosts when their roles are edited independently', async () => {
    const element = document.createElement('instance-host-field') as HostFieldElement;
    element.value = [];
    const details: Array<{ hosts: Array<{ serverId: number; role: string }> }> = [];
    element.addEventListener('instance-host-change', (event) => {
      details.push((event as CustomEvent).detail);
    });
    document.body.append(element);
    await settle(element);

    element.shadowRoot?.querySelector<HTMLInputElement>('input[value="7"]')?.click();
    await element.updateComplete;
    element.shadowRoot?.querySelector<HTMLInputElement>('input[value="8"]')?.click();
    await element.updateComplete;

    expect(Array.from(element.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])
      .filter((checkbox) => checkbox.checked)).toHaveLength(2);
    expect(element.shadowRoot?.querySelectorAll('select[data-server-id]')).toHaveLength(2);

    const primaryRole = element.shadowRoot?.querySelector<HTMLSelectElement>('select[data-server-id="7"]');
    expect(primaryRole).toBeTruthy();
    primaryRole!.value = 'primary';
    primaryRole!.dispatchEvent(new Event('change', { bubbles: true }));
    await element.updateComplete;

    const replicaRole = element.shadowRoot?.querySelector<HTMLSelectElement>('select[data-server-id="8"]');
    expect(replicaRole).toBeTruthy();
    replicaRole!.value = 'replica';
    replicaRole!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(details.at(-1)).toEqual({
      hosts: [
        { serverId: 7, role: 'primary' },
        { serverId: 8, role: 'replica' },
      ],
    });
  });

  it('keeps an unknown relation distinct from an empty relation and exposes reload', async () => {
    const element = document.createElement('instance-host-field') as HostFieldElement;
    element.value = null;
    element.error = '关联关系加载失败';
    const changes = vi.fn();
    const reloads = vi.fn();
    element.addEventListener('instance-host-change', changes);
    element.addEventListener('instance-host-reload', reloads);
    document.body.append(element);
    await settle(element);

    expect(element.shadowRoot?.textContent).toContain('关联关系加载失败');
    expect(element.shadowRoot?.querySelector('input[type="checkbox"]')).toBeNull();
    element.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="reload"]')?.click();
    expect(reloads).toHaveBeenCalledOnce();
    expect(changes).not.toHaveBeenCalled();
  });
});
