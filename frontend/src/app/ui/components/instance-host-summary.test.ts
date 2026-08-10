import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstanceHost,
  InstanceHostEvidenceResponse,
  LinuxHostEvidence,
} from '../../../api/generated/public-api.js';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('./metric-chart.js', () => {
  if (!customElements.get('metric-chart')) customElements.define('metric-chart', class extends HTMLElement {});
  return {};
});

import './instance-host-summary.js';
import './instance-overview-tab.js';

const response = (body: unknown, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => body,
});

const host = (serverId: number): InstanceHost => ({
  serverId,
  role: 'primary',
  host: `db-${serverId}.internal`,
  port: 22,
  label: `DB ${serverId}`,
  osType: 'RHEL 8',
  status: 'online',
  collectionEnabled: true,
  validFrom: '2026-08-10T00:00:00.000Z',
});

const evidence = (serverId: number, expiresAt: string): LinuxHostEvidence => ({
  schemaVersion: 1,
  serverId,
  collectedAt: '2026-08-10T00:00:00.000Z',
  expiresAt,
  quality: 'good',
  truncated: false,
  metrics: {
    source: ['procfs'], collectedAt: '2026-08-10T00:00:00.000Z', quality: 'good',
    values: { cpu_usage: 12.34, memory_usage: 45.55, load_1min: 0.42 },
  },
  filesystems: {
    source: ['df'], collectedAt: '2026-08-10T00:00:00.000Z', quality: 'good',
    items: [{ mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fsType: 'xfs', sizeBytes: 100, usedBytes: 60, availableBytes: 40, usagePercent: 60, inodeTotal: 10, inodeUsed: 2, inodeAvailable: 8, inodeUsagePercent: 20 }],
  },
  systemLogs: {
    source: ['journalctl'], collectedAt: '2026-08-10T00:00:00.000Z', quality: 'good',
    entries: [{ timestamp: '2026-08-10T00:00:00.000Z', severity: 'warning', unit: 'mysqld', identifier: 'mysqld', pid: '1', message: 'database log summary' }],
  },
  physicalFiles: {
    source: ['stat'], collectedAt: '2026-08-10T00:00:00.000Z', quality: 'partial',
    items: [{ path: '/var/lib/mysql/a/very/long/path/ibdata1', quality: 'good', type: 'file', sizeBytes: 100 }],
  },
  gaps: [{ section: 'physicalFiles', reason: 'permission denied' }],
});

const payload = (hosts: Array<{ server: InstanceHost; evidence: LinuxHostEvidence | null }>): InstanceHostEvidenceResponse => ({
  schemaVersion: 1,
  subject: { type: 'instance', id: 11 },
  collectedAt: '2026-08-10T00:00:00.000Z',
  database: { instance: null, realtimeMetrics: null, metricHistory: [], alerts: [], logs: [], slowQueries: [] },
  storage: [{ path: '/var/lib/mysql/a/very/long/path/ibdata1', kind: 'datafile', source: 'mysql', hostInspectable: true }],
  hosts,
  gaps: [{ scope: 'host', section: 'hostEvidence', code: 'PARTIAL_HOST_EVIDENCE' }],
});

async function settle(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

async function flushMicrotasks(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await element.updateComplete;
  }
}

describe('instance-host-summary', () => {
  beforeEach(() => authFetch.mockReset());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('loads host relations before evidence and renders operational evidence', async () => {
    authFetch
      .mockResolvedValueOnce(response({ hosts: [host(7)] }))
      .mockResolvedValueOnce(response(payload([{ server: host(7), evidence: evidence(7, '2026-08-10T01:00:00.000Z') }])));
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-10T00:30:00.000Z'));

    const element = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    element.instanceId = 11;
    document.body.append(element);
    await settle(element);

    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/database/instances/11/hosts',
      '/api/database/instances/11/host-evidence',
    ]);
    expect(element.shadowRoot?.textContent).toContain('db-7.internal');
    expect(element.shadowRoot?.textContent).toContain('database log summary');
    expect(element.shadowRoot?.textContent).toContain('/var/lib/mysql');
    expect(element.shadowRoot?.textContent).toContain('ibdata1');
    expect(element.shadowRoot?.textContent).toContain('PARTIAL_HOST_EVIDENCE');
    expect(element.shadowRoot?.textContent).toContain('主机指标');
    expect(element.shadowRoot?.textContent).toContain('12.3%');
    expect(element.shadowRoot?.textContent).toContain('45.6%');
    expect(element.shadowRoot?.textContent).toContain('0.42');
  });

  it('renders an empty relation immediately without requesting evidence', async () => {
    authFetch.mockResolvedValue(response({ hosts: [] }));
    const element = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    element.instanceId = 11;
    document.body.append(element);
    await settle(element);

    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith('/api/database/instances/11/hosts');
    expect(element.shadowRoot?.querySelector('app-empty-state')).toBeTruthy();
    expect(element.shadowRoot?.textContent).toContain('未关联');
  });

  it('treats only a parseable future expiry as fresh', async () => {
    const now = Date.parse('2026-08-10T00:30:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const hosts = [host(1), host(2), host(3), host(4), host(5)];
    authFetch
      .mockResolvedValueOnce(response({ hosts }))
      .mockResolvedValueOnce(response(payload([
        { server: hosts[0], evidence: evidence(1, '2026-08-10T00:30:00.001Z') },
        { server: hosts[1], evidence: evidence(2, '2026-08-10T00:30:00.000Z') },
        { server: hosts[2], evidence: evidence(3, '2026-08-10T00:29:59.999Z') },
        { server: hosts[3], evidence: evidence(4, 'not-a-date') },
        { server: hosts[4], evidence: null },
      ])));

    const element = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    element.instanceId = 11;
    document.body.append(element);
    await settle(element);

    expect(Array.from(element.shadowRoot?.querySelectorAll('[data-freshness]') ?? []).map((node) => node.getAttribute('data-freshness')))
      .toEqual(['fresh', 'expired', 'expired', 'expired', 'missing']);
  });

  it('rerenders at the nearest evidence expiry and rearms for later evidence', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-10T00:30:00.000Z');
    vi.setSystemTime(now);
    const hosts = [host(1), host(2)];
    authFetch
      .mockResolvedValueOnce(response({ hosts }))
      .mockResolvedValueOnce(response(payload([
        { server: hosts[0], evidence: evidence(1, '2026-08-10T00:30:01.000Z') },
        { server: hosts[1], evidence: evidence(2, '2026-08-10T00:30:05.000Z') },
      ])));

    const element = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    element.instanceId = 11;
    document.body.append(element);
    await flushMicrotasks(element);
    expect(Array.from(element.shadowRoot?.querySelectorAll('[data-freshness]') ?? []).map((node) => node.getAttribute('data-freshness')))
      .toEqual(['fresh', 'fresh']);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks(element);

    expect(Array.from(element.shadowRoot?.querySelectorAll('[data-freshness]') ?? []).map((node) => node.getAttribute('data-freshness')))
      .toEqual(['expired', 'fresh']);

    await vi.advanceTimersByTimeAsync(4000);
    await flushMicrotasks(element);

    expect(Array.from(element.shadowRoot?.querySelectorAll('[data-freshness]') ?? []).map((node) => node.getAttribute('data-freshness')))
      .toEqual(['expired', 'expired']);
  });

  it('clears the evidence expiry timer when disconnected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-10T00:30:00.000Z'));
    authFetch
      .mockResolvedValueOnce(response({ hosts: [host(1)] }))
      .mockResolvedValueOnce(response(payload([
        { server: host(1), evidence: evidence(1, '2026-08-10T00:30:05.000Z') },
      ])));

    const element = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    element.instanceId = 11;
    document.body.append(element);
    await flushMicrotasks(element);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    element.remove();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rerenders expired evidence when the same element reconnects after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-10T00:30:00.000Z'));
    authFetch
      .mockResolvedValueOnce(response({ hosts: [host(1)] }))
      .mockResolvedValueOnce(response(payload([
        { server: host(1), evidence: evidence(1, '2026-08-10T00:30:05.000Z') },
      ])));

    const element = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    element.instanceId = 11;
    document.body.append(element);
    await flushMicrotasks(element);
    expect(element.shadowRoot?.querySelector('[data-freshness]')?.getAttribute('data-freshness')).toBe('fresh');

    element.remove();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_001);
    document.body.append(element);
    await flushMicrotasks(element);

    expect(element.shadowRoot?.querySelector('[data-freshness]')?.getAttribute('data-freshness')).toBe('expired');
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a permission failure from a request failure', async () => {
    authFetch.mockResolvedValue(response({ error: 'RESOURCE_FORBIDDEN' }, false, 403));
    const forbidden = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    forbidden.instanceId = 11;
    document.body.append(forbidden);
    await settle(forbidden);
    expect(forbidden.shadowRoot?.textContent).toContain('权限');

    document.body.replaceChildren();
    authFetch.mockReset();
    authFetch.mockRejectedValue(new Error('network down'));
    const failed = document.createElement('instance-host-summary') as HTMLElement & { instanceId: number; updateComplete: Promise<unknown> };
    failed.instanceId = 12;
    document.body.append(failed);
    await settle(failed);
    expect(failed.shadowRoot?.textContent).toContain('network down');
  });

  it('places the host summary after instance information and before trend charts', async () => {
    authFetch.mockResolvedValue(response({ hosts: [] }));
    const overview = document.createElement('instance-overview-tab') as any;
    overview.instance = {
      id: 11, name: 'prod', db_type: 'mysql', host: 'db', port: 3306, database_name: 'prod', username: 'dba',
      environment: 'production', description: '', health_status: 'healthy', health_score: 99, status: 'active', created_at: '2026-08-10T00:00:00.000Z',
    };
    overview.overviewHistory = { time: ['00:00'], metrics: { qps: [1] } };
    overview.metricRegistry = [{ id: 'qps', name: 'QPS', description: '', unit: '', is_collected: true }];
    document.body.append(overview);
    await settle(overview);

    const children = Array.from(overview.children) as Element[];
    const infoIndex = children.findIndex((node) => node.tagName === 'APP-CARD');
    const summaryIndex = children.findIndex((node) => node.tagName === 'INSTANCE-HOST-SUMMARY');
    const trendsIndex = children.findIndex((node) => node.classList.contains('mini-charts'));
    expect(infoIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(infoIndex);
    expect(trendsIndex).toBeGreaterThan(summaryIndex);
    expect(children[summaryIndex].closest('app-card')).toBeNull();
  });
});
