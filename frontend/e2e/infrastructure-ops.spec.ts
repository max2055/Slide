import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * This spec exercises the infrastructure workflows against deterministic API
 * and DirectAdapter fixtures. It validates browser behaviour and request
 * contracts only; it is not a real Huawei VRP device UAT.
 */

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'mobile-390x844', width: 390, height: 844 },
] as const;

const IDS = {
  instance: 101,
  server: 202,
  networkDevice: 303,
  alert: 404,
  diagnosis: 505,
  backup: 8,
} as const;

const FIXTURE_SECRET = 'fixture-device-secret';
const FIXTURE_TIME = '2026-08-26T00:00:00.000Z';

type JsonObject = Record<string, unknown>;

type Call = {
  method: string;
  path: string;
  url: string;
  body: JsonObject | null;
};

type FixtureState = {
  serverCreated: boolean;
  instanceCreated: boolean;
  relationSaved: boolean;
  networkDeviceCreated: boolean;
  diagnosisId: number | null;
  diagnosisBody: JsonObject | null;
};

function newFixtureState(): FixtureState {
  return {
    serverCreated: false,
    instanceCreated: false,
    relationSaved: false,
    networkDeviceCreated: false,
    diagnosisId: null,
    diagnosisBody: null,
  };
}

const serverFixture = (state: FixtureState) => ({
  id: IDS.server,
  host: '192.0.2.20',
  port: 22,
  label: 'RHEL operations host',
  os_type: 'rhel',
  credential_type: 'password',
  status: 'online',
  last_check_at: FIXTURE_TIME,
  collection_enabled: 1,
  host_key_fingerprint: 'SHA256:fixture-host-key',
  environment: 'testing',
  related_instance_count: state.relationSaved ? 1 : 0,
});

const instanceFixture = {
  id: IDS.instance,
  name: 'e2e-mysql',
  environment: 'testing',
  db_type: 'mysql',
  db_version: '8.0',
  host: '192.0.2.10',
  port: 3306,
  username: 'readonly-e2e',
  database_name: 'orders',
  description: 'Fixture database used for infrastructure workflow coverage',
  health_status: 'warning',
  health_score: 72,
  status: 'offline',
  created_at: FIXTURE_TIME,
  updated_at: FIXTURE_TIME,
  data_size_gb: 12.4,
};

const networkDeviceFixture = {
  id: IDS.networkDevice,
  name: 'huawei-edge-e2e',
  label: 'Huawei VRP edge',
  host: '192.0.2.30',
  site: 'dc-a',
  vendor: 'huawei',
  model: 'CE6857',
  os_version: 'V300R023',
  serial_number: 'SN-E2E-303',
  snmp_port: 161,
  ssh_port: 22,
  status: 'online',
  last_check_at: FIXTURE_TIME,
  collection_enabled: true,
  hasSnmpCredential: true,
  hasSshCredential: true,
};

const backupFixture = {
  id: IDS.backup,
  deviceId: IDS.networkDevice,
  versionNo: 1,
  contentSha256: 'a'.repeat(64),
  sourceProtocol: 'ssh',
  collectedAt: FIXTURE_TIME,
  sizeBytes: 128,
  redactionStatus: 'redacted',
};

const alertFixture = {
  id: IDS.alert,
  instance_id: IDS.instance,
  instance_name: instanceFixture.name,
  alert_type: 'network_interface_down',
  severity: 'critical',
  title: 'Huawei edge interface down',
  message: 'Huawei VRP edge / GigabitEthernet0/0/1 is down',
  status: 'acknowledged',
  acknowledged: true,
  acknowledged_by: 'fixture-operator',
  created_at: FIXTURE_TIME,
  target_type: 'network_device',
  network_device_id: IDS.networkDevice,
  target_name: networkDeviceFixture.label,
};

function requestBody(route: Route): JsonObject | null {
  try {
    const value = route.request().postDataJSON();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : null;
  } catch {
    return null;
  }
}

async function fulfill(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installWebSocketStub(page: Page, respondToChat = false): Promise<void> {
  await page.route('**/src/app/ui/device-identity.ts', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: [
        "export async function loadOrCreateDeviceIdentity() { return { deviceId: 'fixture-device', publicKey: 'fixture-public-key', privateKey: 'fixture-private-key' }; }",
        "export async function signDevicePayload() { return 'fixture-signature'; }",
      ].join('\n'),
    });
  });
  await page.addInitScript(({ respondToChat }) => {
    class FixtureWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = FixtureWebSocket.CONNECTING;
      bufferedAmount = 0;
      protocol = '';
      extensions = '';
      binaryType = 'blob';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          if (this.readyState !== FixtureWebSocket.CONNECTING) return;
          this.readyState = FixtureWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        }, 0);
      }

      send(data: unknown): void {
        if (!respondToChat) return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        const emit = (message: Record<string, unknown>, delay = 0) => setTimeout(() => {
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
        }, delay);
        if (frame.type === 'auth') {
          emit({ type: 'auth_ok' });
          return;
        }
        if (frame.type === 'chat.send') {
          const sessionKey = String(frame.sessionKey || 'fixture-chat-session');
          const messageId = String(frame.messageId || 'fixture-message');
          if (!frame.sessionKey) emit({ type: 'session.created', sessionKey, messageId });
          emit({ type: 'run.started', runId: 'fixture-run', sessionKey, messageId }, 5);
          emit({ type: 'text_delta', delta: 'Fixture Agent response' }, 20);
          emit({ type: 'complete', finalContent: 'Fixture Agent response' }, 250);
        }
      }

      addEventListener(_type: string, _listener: EventListener): void {
        // Vite's development client probes the socket with this DOM API.
      }

      removeEventListener(_type: string, _listener: EventListener): void {
        // No event stream is needed for this fixture socket.
      }

      close(code = 1000, reason = ''): void {
        if (this.readyState === FixtureWebSocket.CLOSED) return;
        this.readyState = FixtureWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close', { code, reason }));
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FixtureWebSocket,
    });
  }, { respondToChat });
}

async function installAuth(page: Page, settings: JsonObject = {}): Promise<void> {
  await page.addInitScript(({ settings }) => {
    const token = 'fixture-infrastructure-jwt';
    const permissions = [
      '*',
      'ai:manage',
      'instance:view',
      'instance:manage',
      'network_devices:view',
      'network_devices:manage',
      'network_devices:backup',
      'servers:view',
      'servers:manage',
    ];
    localStorage.setItem('token', token);
    localStorage.setItem('refreshToken', 'fixture-refresh-token');
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('slide.control.username.v1', 'admin');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({
      locale: 'zh-CN',
      defaultTab: 'instances-db',
      theme: 'light',
      ...settings,
    }));
  }, { settings });
}

async function installApiFixtures(page: Page, state: FixtureState, calls: Call[]): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/api/')) return route.fallback();
    const body = requestBody(route);
    calls.push({ method, path, url: `${path}${url.search}`, body });

    if (path === '/api/auth/permissions' && method === 'GET') {
      return fulfill(route, ['*', 'ai:manage', 'instance:view', 'instance:manage', 'network_devices:view', 'network_devices:manage', 'network_devices:backup', 'servers:view', 'servers:manage']);
    }
    if (path === '/api/version' && method === 'GET') return fulfill(route, { version: 'fixture-e2e' });
    if (path === '/api/user/preferences' && method === 'GET') return fulfill(route, { preferences: { locale: 'zh-CN' } });
    if (path === '/api/user/preferences' && method === 'PUT') return fulfill(route, { success: true });
    if (path === '/api/device/register' && method === 'POST') return fulfill(route, { ok: true });
    if (path === '/api/device/challenge' && method === 'POST') return fulfill(route, { nonce: 'fixture-device-nonce' });
    if (path === '/api/agents' && method === 'GET') return fulfill(route, { agents: [{ id: 'fixture-agent', name: 'Fixture Agent' }], defaultId: 'fixture-agent' });
    if (path === '/api/sessions' && method === 'GET') return fulfill(route, { ok: true, sessions: [], defaults: {} });
    if (path === '/api/chat/history' && method === 'GET') {
      return fulfill(route, { messages: [
        { role: 'user', content: 'First fixture message', timestamp: FIXTURE_TIME },
        { role: 'assistant', content: 'Fixture Agent response', timestamp: FIXTURE_TIME },
      ] });
    }

    if (path === '/api/servers' && method === 'GET') {
      return fulfill(route, state.serverCreated ? [serverFixture(state)] : []);
    }
    if (path === '/api/servers/metrics/summary' && method === 'GET') {
      return fulfill(route, {
        servers: state.serverCreated ? {
          [IDS.server]: {
            recorded_at: FIXTURE_TIME,
            metrics: [
              { metric_name: 'cpu_usage', metric_value: 18, recorded_at: FIXTURE_TIME },
              { metric_name: 'memory_usage', metric_value: 42, recorded_at: FIXTURE_TIME },
            ],
          },
        } : {},
        recorded_at: FIXTURE_TIME,
      });
    }
    if (path === `/api/servers/${IDS.server}` && method === 'GET') return fulfill(route, serverFixture(state));
    if (path === '/api/servers' && method === 'POST') {
      state.serverCreated = true;
      return fulfill(route, { ...serverFixture(state), ...(body ?? {}) });
    }
    if (path === `/api/servers/${IDS.server}/instances` && method === 'GET') {
      return fulfill(route, { instances: state.relationSaved ? [instanceFixture] : [] });
    }

    if (path === '/api/database/instances' && method === 'GET') {
      return fulfill(route, state.instanceCreated ? [instanceFixture] : []);
    }
    if (path === '/api/database/instances' && method === 'POST') {
      state.instanceCreated = true;
      return fulfill(route, { id: IDS.instance, ...instanceFixture, ...(body ?? {}) });
    }
    if (path === `/api/database/instances/${IDS.instance}` && method === 'GET') return fulfill(route, instanceFixture);
    if (path === `/api/database/instances/${IDS.instance}` && method === 'PUT') return fulfill(route, { ...instanceFixture, ...(body ?? {}) });
    if (path === `/api/database/instances/${IDS.instance}/hosts` && method === 'GET') {
      return fulfill(route, { hosts: state.relationSaved ? [{ serverId: IDS.server, role: 'primary' }] : [] });
    }
    if (path === `/api/database/instances/${IDS.instance}/hosts` && method === 'PUT') {
      state.relationSaved = true;
      return fulfill(route, { ok: true, hosts: (body?.hosts ?? [{ serverId: IDS.server, role: 'primary' }]) });
    }
    if (path === `/api/database/instances/${IDS.instance}/metrics` && method === 'GET') {
      return fulfill(route, { connections: 4, qps: 18, cpu_usage: 22, memory_usage: 48 });
    }
    if (path === `/api/database/instances/${IDS.instance}/metrics/history` && method === 'GET') {
      return fulfill(route, { time: [FIXTURE_TIME], metrics: { connections: [4] } });
    }
    if (path === `/api/database/instances/${IDS.instance}/topsql` && method === 'GET') return fulfill(route, []);
    if (path === `/api/database/instances/${IDS.instance}/sessions` && method === 'GET') return fulfill(route, []);
    if (path === `/api/database/instances/${IDS.instance}/capacity` && method === 'GET') {
      return fulfill(route, { total_size_gb: 12.4, databases: [], tablespaces: [], top_tables: [] });
    }
    if (path === `/api/database/instances/${IDS.instance}/capacity/history` && method === 'GET') return fulfill(route, { history: [] });
    if (path === '/api/metrics/registry' && method === 'GET') return fulfill(route, []);

    if (path === '/api/network-devices' && method === 'GET') {
      return fulfill(route, state.networkDeviceCreated ? [networkDeviceFixture] : []);
    }
    if (path === '/api/network-devices' && method === 'POST') {
      state.networkDeviceCreated = true;
      return fulfill(route, { ...networkDeviceFixture, ...(body ?? {}) });
    }
    if (path === '/api/network-devices/test-connection' && method === 'POST') return fulfill(route, { success: true, message: 'SNMPv3 fixture probe succeeded' });
    if (path === `/api/network-devices/${IDS.networkDevice}` && method === 'GET') return fulfill(route, networkDeviceFixture);
    if (path === `/api/network-devices/${IDS.networkDevice}/probe` && method === 'POST') return fulfill(route, { success: true });
    if (path === `/api/network-devices/${IDS.networkDevice}/metrics` && method === 'GET') {
      return fulfill(route, { metrics: [
        { metricId: 'device_uptime_seconds', value: 86400, quality: 'good', source: 'snmpv3', observedAt: FIXTURE_TIME },
        { metricId: 'device_cpu_percent', value: 12, quality: 'good', source: 'snmpv3', observedAt: FIXTURE_TIME },
        { metricId: 'device_memory_percent', value: 34, quality: 'good', source: 'snmpv3', observedAt: FIXTURE_TIME },
        { metricId: 'device_temperature_celsius', value: 42, quality: 'good', source: 'snmpv3', observedAt: FIXTURE_TIME },
        { metricId: 'device_reachability', value: 1, quality: 'good', source: 'snmpv3', observedAt: FIXTURE_TIME },
      ] });
    }
    if (path === `/api/network-devices/${IDS.networkDevice}/interfaces` && method === 'GET') {
      return fulfill(route, { interfaces: [{ id: 1, deviceId: IDS.networkDevice, ifIndex: 1, ifName: 'GigabitEthernet0/0/1', ifAlias: 'uplink', speedBps: 1_000_000_000, adminStatus: 'up', operStatus: 'up', lastSeenAt: FIXTURE_TIME }] });
    }
    if (path === `/api/network-devices/${IDS.networkDevice}/relations` && method === 'GET') {
      return fulfill(route, { relations: [{ source: { type: 'network_device', id: IDS.networkDevice }, target: { type: 'server', id: IDS.server }, relationType: 'connected_to', provenance: 'fixture', validUntil: null }] });
    }
    if (path === `/api/network-devices/${IDS.networkDevice}/config-backups` && method === 'GET') return fulfill(route, { backups: [backupFixture] });
    if (path === `/api/network-devices/${IDS.networkDevice}/config-backups` && method === 'POST') return fulfill(route, backupFixture, 201);
    if (path === `/api/network-devices/${IDS.networkDevice}/config-backups/${IDS.backup}` && method === 'GET') {
      return fulfill(route, { ...backupFixture, preview: `sysname huawei-edge-e2e\nsnmp-agent community read <redacted>\npassword <redacted>` });
    }

    if (path === '/api/alerts' && method === 'GET') {
      return fulfill(route, { items: [alertFixture], total: 1, unread: 0, critical: 1, warning: 0, resolved: 0 });
    }
    if (path === '/api/ai/analysis' && method === 'GET') return fulfill(route, []);
    if (path === '/api/ai/analysis/history' && method === 'GET') return fulfill(route, { records: [] });
    if (path === '/api/ai/analysis' && method === 'POST') {
      state.diagnosisId = IDS.diagnosis;
      state.diagnosisBody = body;
      return fulfill(route, { id: IDS.diagnosis, status: 'running', session_key: `fixture-diagnosis-${IDS.diagnosis}` });
    }
    if ((path === `/api/ai/analysis/status/${IDS.diagnosis}` || path === `/api/ai/analysis/${IDS.diagnosis}/status`) && method === 'GET') {
      return fulfill(route, {
        ok: true,
        record: {
          id: IDS.diagnosis,
          analysis_type: 'fault_diagnosis',
          instance_id: IDS.instance,
          status: 'completed',
          created_at: FIXTURE_TIME,
          updated_at: FIXTURE_TIME,
          result: 'Fixture read-only diagnosis: evidence collected without write commands.',
          execution_trace: { mode: 'read_only', tool_events: [{ name: 'metrics.read', status: 'ok', detail: 'fixture' }] },
          error_message: null,
        },
      });
    }
    if (path === `/api/ai/analysis/${IDS.diagnosis}` && method === 'GET') {
      return fulfill(route, { id: IDS.diagnosis, status: 'completed', result: 'Fixture read-only diagnosis' });
    }

    // The app performs a few best-effort background reads while connecting.
    // Keep those harmless so this remains runnable without the backend.
    if (method === 'GET') return fulfill(route, []);
    return fulfill(route, { ok: true });
  });
}

async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth, `${label}: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.innerWidth + 1);
}

async function waitForCall(calls: Call[], predicate: (call: Call) => boolean): Promise<Call> {
  await expect.poll(() => calls.find(predicate)).toBeTruthy();
  return calls.find(predicate)!;
}

test('persisted auth, first chat send, and appearance survive a deep-route refresh', async ({ page }) => {
  const state = newFixtureState();
  const calls: Call[] = [];
  await installWebSocketStub(page, true);
  await installAuth(page, {
    defaultTab: 'chat',
    accentColor: '#14b8a6',
    btnPalette: { primaryBg: '#0f766e', primaryColor: '#ffffff' },
  });
  await installApiFixtures(page, state, calls);
  await page.addInitScript(() => {
    (window as Window & { __loginGateObserved?: boolean }).__loginGateObserved = false;
    new MutationObserver(() => {
      if (document.querySelector('.login-gate')) {
        (window as Window & { __loginGateObserved?: boolean }).__loginGateObserved = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });

  await page.goto('/chat');
  const input = page.locator('.agent-chat__input textarea');
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.fill('First fixture message');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect.poll(() => page.evaluate(() => {
    const app = document.querySelector('slide-app') as HTMLElement & { chatMessages?: Array<{ role?: string }> };
    return app?.chatMessages?.some((message) => message.role === 'user') ?? false;
  })).toBe(true);
  await expect(page.getByText('First fixture message', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture Agent response', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const app = document.querySelector('slide-app') as HTMLElement & { chatRunId?: string | null; chatSending?: boolean };
    return { runId: app?.chatRunId ?? null, sending: app?.chatSending ?? false };
  })).toEqual({ runId: null, sending: false });
  await expect(page).toHaveURL(/\/chat\?session=fixture-chat-session$/);

  await page.reload();
  await expect(page).toHaveURL(/\/chat\?session=fixture-chat-session$/);
  await expect(page.locator('.login-gate')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __loginGateObserved?: boolean }).__loginGateObserved)).toBe(false);
  expect(await page.evaluate(() => ({
    accent: document.documentElement.style.getPropertyValue('--accent'),
    primaryButton: document.documentElement.style.getPropertyValue('--btn-primary-bg'),
  }))).toEqual({ accent: '#14b8a6', primaryButton: '#0f766e' });
});

for (const viewport of VIEWPORTS) {
  test(`fixture-backed infrastructure operations render and remain usable at ${viewport.name}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const state = newFixtureState();
    const calls: Call[] = [];
    await installWebSocketStub(page);
    await installAuth(page);
    await installApiFixtures(page, state, calls);

    // Server onboarding
    await page.goto('/servers');
    const serversPage = page.locator('servers-page');
    await expect(serversPage).toBeVisible({ timeout: 15_000 });
    await serversPage.getByRole('button', { name: /添加服务器/ }).click();
    const serverDialog = page.locator('app-dialog[title="添加服务器"]');
    await expect(serverDialog.locator('[role="dialog"]')).toBeVisible();
    await serverDialog.locator('app-form-field[label="IP/主机名"] input').fill(serverFixture(state).host);
    await serverDialog.locator('app-form-field[label="标签 (可选)"] input').fill(serverFixture(state).label);
    await serverDialog.locator('app-form-field[label="操作系统"] select').selectOption('rhel');
    await serverDialog.locator('app-form-field[label="SSH用户名"] input').fill('fixture-admin');
    await serverDialog.locator('app-form-field[label="SSH主机密钥指纹"] input').fill('SHA256:fixture-host-key');
    await serverDialog.locator('app-form-field[label="密码"] input').fill('fixture-password');
    await serverDialog.getByRole('button', { name: '保存', exact: true }).click();
    const serverPost = await waitForCall(calls, (call) => call.method === 'POST' && call.path === '/api/servers');
    expect(serverPost.body).toMatchObject({ host: serverFixture(state).host, os_type: 'rhel', credential_username: 'fixture-admin' });
    await expect(page.getByText(serverFixture(state).label, { exact: true })).toBeVisible({ timeout: 10_000 });

    // Database onboarding plus the actual instance-host relation editor.
    await page.goto('/instances-db');
    const instancesPage = page.locator('instances-page');
    await expect(instancesPage).toBeVisible({ timeout: 15_000 });
    await instancesPage.getByRole('button', { name: /添加实例/ }).click();
    const instanceDialog = page.locator('app-dialog[title="添加数据库实例"]');
    await expect(instanceDialog.locator('[role="dialog"]')).toBeVisible();
    await instanceDialog.locator('app-form-field[label="实例名称"] input').fill(instanceFixture.name);
    await instanceDialog.locator('app-form-field[label="环境"] select').selectOption('testing');
    await instanceDialog.locator('app-form-field[label="主机地址"] input').fill(instanceFixture.host);
    await instanceDialog.locator('app-form-field[label="用户名"] input').fill(instanceFixture.username);
    await instanceDialog.locator('app-form-field[label="密码"] input').fill('fixture-database-password');
    await instanceDialog.locator('app-form-field[label="数据库名"] input').fill(instanceFixture.database_name);

    const hostOption = instanceDialog.locator('instance-host-field .host-option').filter({ hasText: serverFixture(state).label });
    await expect(hostOption).toBeVisible({ timeout: 10_000 });
    await hostOption.locator('input[type="checkbox"]').check();
    await hostOption.locator(`select[data-server-id="${IDS.server}"]`).selectOption('primary');
    await instanceDialog.getByRole('button', { name: '添加实例', exact: true }).click();

    const instancePost = await waitForCall(calls, (call) => call.method === 'POST' && call.path === '/api/database/instances');
    expect(instancePost.body).toMatchObject({ name: instanceFixture.name, db_type: 'mysql', host: instanceFixture.host, username: instanceFixture.username });
    const relationPut = await waitForCall(calls, (call) => call.method === 'PUT' && call.path === `/api/database/instances/${IDS.instance}/hosts`);
    expect(relationPut.body).toEqual({ hosts: [{ serverId: IDS.server, role: 'primary' }] });
    await expect(page.getByText(instanceFixture.name, { exact: true })).toBeVisible({ timeout: 10_000 });

    // The server relation is reflected in the server workbench filter.
    await page.goto('/servers');
    await expect(page.locator('servers-page')).toBeVisible({ timeout: 15_000 });
    await page.locator('servers-page select[aria-label="Database relation filter"]').selectOption('linked');
    await expect(page.getByText(serverFixture(state).label, { exact: true })).toBeVisible();

    // Huawei network-device onboarding, including an SNMPv3 probe contract.
    await page.goto('/network-devices');
    const devicesPage = page.locator('network-devices-page');
    await expect(devicesPage).toBeVisible({ timeout: 15_000 });
    await devicesPage.getByRole('button', { name: '添加设备', exact: true }).click();
    const deviceDialog = page.locator('app-dialog[title="添加网络设备"]');
    await expect(deviceDialog.locator('[role="dialog"]')).toBeVisible();
    await deviceDialog.locator('app-form-field[label="名称"] input').fill(networkDeviceFixture.name);
    await deviceDialog.locator('app-form-field[label="主机"] input').fill(networkDeviceFixture.host);
    await deviceDialog.locator('app-form-field[label="标签"] input').fill(networkDeviceFixture.label);
    await deviceDialog.locator('app-form-field[label="站点"] input').fill(networkDeviceFixture.site);
    await deviceDialog.locator('app-form-field[label="型号"] input').fill(networkDeviceFixture.model);
    await deviceDialog.locator('app-form-field[label="VRP 版本"] input').fill(networkDeviceFixture.os_version);
    await deviceDialog.locator('app-form-field[label="SNMPv3 用户名"] input').fill('fixture-snmp-reader');
    await deviceDialog.locator('app-form-field[label="认证密钥"] input').fill(FIXTURE_SECRET);
    await deviceDialog.locator('app-form-field[label="隐私密钥"] input').fill('fixture-privacy-secret');
    await deviceDialog.getByRole('button', { name: '测试 SNMPv3', exact: true }).click();
    const probeCall = await waitForCall(calls, (call) => call.method === 'POST' && call.path === '/api/network-devices/test-connection');
    expect(probeCall.body).toMatchObject({ vendor: 'huawei', version: 3, snmpv3: { username: 'fixture-snmp-reader', securityLevel: 'authPriv', authProtocol: 'SHA', privacyProtocol: 'AES' } });
    await deviceDialog.getByRole('button', { name: '保存', exact: true }).click();
    const devicePost = await waitForCall(calls, (call) => call.method === 'POST' && call.path === '/api/network-devices');
    expect(devicePost.body).toMatchObject({ name: networkDeviceFixture.name, host: networkDeviceFixture.host, vendor: 'huawei' });
    expect(JSON.stringify(devicePost.body)).toContain(FIXTURE_SECRET);
    await expect(page.getByText(networkDeviceFixture.label, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText(FIXTURE_SECRET);

    // Detail view proves relation observations and redacted, read-only backup viewing.
    await page.getByRole('button', { name: networkDeviceFixture.label, exact: true }).click();
    await expect(page.locator('network-device-detail')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Relations', exact: true }).click();
    await expect(page.getByText('Related resources (1)', { exact: true })).toBeVisible();
    // The shared table is horizontally scrollable on narrow viewports; the
    // relation cell may begin outside the current scroll position.
    await expect(page.getByText('connected_to', { exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'Backups', exact: true }).click();
    await expect(page.getByText('Encrypted configuration backups', { exact: true })).toBeVisible();
    await expect.poll(() => page.locator('network-device-detail button').allTextContents()).toContain('View summary');
    const backupAction = page.locator('network-device-detail button').filter({ hasText: 'View summary' });
    await backupAction.click();
    const backupDialog = page.locator('app-dialog[title="Configuration backup v1"]');
    await expect(backupDialog.locator('.preview')).toContainText('<redacted>');
    await expect(backupDialog).not.toContainText(FIXTURE_SECRET);
    expect(calls.some((call) => call.url.includes('raw=true'))).toBe(false);

    // Network-device alert is viewable in the alert workflow.
    await page.goto('/alerts');
    await expect(page.locator('alerts-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(alertFixture.title, { exact: true })).toBeVisible({ timeout: 10_000 });
    const alertRow = page.locator('alert-list tr').filter({ hasText: alertFixture.title });
    await alertRow.getByRole('button', { name: '详情', exact: true }).click();
    const alertDialog = page.locator('app-dialog[title="告警详情"]');
    await expect(alertDialog).toContainText(alertFixture.message);
    await expect(alertDialog).toContainText(networkDeviceFixture.label);
    await alertDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

    // Start the existing Agent diagnosis flow and prove its request is read-only.
    await page.goto(`/instance-detail?id=${IDS.instance}`);
    const instanceDetail = page.locator('instance-detail-page');
    await expect(instanceDetail).toBeVisible({ timeout: 15_000 });
    await instanceDetail.getByRole('button', { name: '一键诊断', exact: true }).click();
    const diagnosisPost = await waitForCall(calls, (call) => call.method === 'POST' && call.path === '/api/ai/analysis');
    expect(diagnosisPost.body).toEqual({ analysis_type: 'fault_diagnosis', instance_id: IDS.instance, trigger_type: 'manual' });
    expect(diagnosisPost.body).not.toHaveProperty('command');
    const diagnosisModal = page.locator('instance-diagnosis-modal');
    await expect(diagnosisModal).toContainText('Agent 正在采集数据', { timeout: 5_000 });
    await expect(diagnosisModal).toContainText('Fixture read-only diagnosis', { timeout: 10_000 });
    expect(calls.filter((call) => call.path.startsWith('/api/ai/') && call.method !== 'GET').map((call) => call.path)).toEqual(['/api/ai/analysis']);

    await expectNoOverflow(page, viewport.name);
  });
}
