import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));

import './server-detail.js';

const response = (body: unknown, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => body,
});

const server = (id: number) => ({
  id,
  host: `host-${id}.internal`,
  port: 22,
  label: `Host ${id}`,
  os_type: 'RHEL 8',
  credential_type: 'key',
  status: 'online',
  last_check_at: '2026-08-10T00:00:00.000Z',
  collection_enabled: 1,
  created_at: '2026-08-10T00:00:00.000Z',
  updated_at: '2026-08-10T00:00:00.000Z',
});

const hosted = (instanceId: number) => ({
  serverId: 9,
  role: 'primary',
  instanceId,
  name: `instance-${instanceId}`,
  dbType: 'mysql',
  environment: 'production',
  status: 'active',
  healthStatus: 'healthy',
  validFrom: '2026-08-10T00:00:00.000Z',
});

async function settle(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

describe('server hosted database instances', () => {
  beforeEach(() => {
    authFetch.mockReset();
    showToast.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('loads once per server id, renders hosted instances, and navigates to instance detail', async () => {
    authFetch.mockImplementation(async (url: string) => {
      const id = Number(url.match(/\/api\/servers\/(\d+)/)?.[1] ?? 0);
      if (/\/metrics$/.test(url)) return response({ metrics: [] });
      if (/\/instances$/.test(url)) return response({ instances: [hosted(id + 100)] });
      if (/\/api\/servers\/\d+$/.test(url)) return response(server(id));
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement('server-detail') as any;
    element.serverId = 9;
    document.body.append(element);
    await settle(element);

    expect(authFetch.mock.calls.filter(([url]) => url === '/api/servers/9/instances')).toHaveLength(1);
    expect(element.shadowRoot.textContent).toContain('instance-109');

    const navigation = vi.fn();
    window.addEventListener('slide-navigate', navigation, { once: true });
    (element.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('[data-instance-id="109"]')?.click();
    expect((navigation.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'instance-detail', id: 109 });

    element.serverId = 10;
    await settle(element);
    expect(authFetch.mock.calls.filter(([url]) => url === '/api/servers/10/instances')).toHaveLength(1);
  });

  it('keeps hosted-instance errors independent and refreshes the reverse relation', async () => {
    let hostedReads = 0;
    authFetch.mockImplementation(async (url: string) => {
      if (url === '/api/servers/9') return response(server(9));
      if (url === '/api/servers/9/metrics') return response({ metrics: [] });
      if (url === '/api/servers/9/instances') {
        hostedReads += 1;
        return hostedReads === 1
          ? response({ error: 'RESOURCE_FORBIDDEN' }, false, 403)
          : response({ instances: [] });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement('server-detail') as any;
    element.serverId = 9;
    document.body.append(element);
    await settle(element);

    expect(element.error).toBeNull();
    expect(element.server).toBeTruthy();
    expect(element.shadowRoot.textContent).toContain('服务器状态');
    expect(element.shadowRoot.textContent).toContain('权限');

    await element.refreshCurrentTab();
    await element.updateComplete;
    expect(hostedReads).toBe(2);
    expect(element.shadowRoot.querySelector('app-empty-state')).toBeTruthy();
  });

  it('defines a single-column 390px layout without page overflow', () => {
    const source = fs.readFileSync(path.resolve(__dirname, './server-detail.ts'), 'utf8');
    expect(source).toContain('@media (max-width: 600px)');
    expect(source).toContain('minmax(0, 1fr)');
    expect(source).toMatch(/\.page\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(source).toMatch(/\.header[^}]*flex-wrap:\s*wrap/s);
  });
});
