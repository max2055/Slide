import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
vi.mock("../components/app-toast-container.js", () => ({ showToast }));

import "./network-device-detail.js";

const device = { id: 4, name: "edge-4", label: "Edge 4", host: "10.0.0.4", site: "dc-a", vendor: "huawei", model: "CE", os_version: "V300R", serial_number: "SN-4", snmp_port: 161, ssh_port: 22, status: "online", last_check_at: "2026-08-26T00:00:00.000Z", collection_enabled: true, created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-26T00:00:00.000Z", hasSnmpCredential: true, hasSshCredential: false };
const response = (body: unknown, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => body });

async function settle(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

describe("network-device-detail", () => {
  it('loads metric views only through the semantic Metrics V2 component', async () => {
    const element = document.createElement('network-device-detail') as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    expect(element.querySelector('semantic-metrics[resourceType="network_device"]')).toBeTruthy();
    expect(authFetch.mock.calls.some(([url]) => String(url).endsWith('/metrics'))).toBe(false);
    expect(authFetch.mock.calls.some(([url]) => String(url).endsWith('/interfaces'))).toBe(false);
    expect(element.textContent).not.toContain('兼容采集');
  });
  it('saves a changed daily time and disabled switch, then renders the persisted values on reload', async () => {
    const original = authFetch.getMockImplementation()!;
    let schedule = { enabled: true, dailyTime: '00:00', timeZone: 'Asia/Shanghai', lastRun: null };
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/backup-schedule')) {
        if (init?.method === 'PUT') schedule = { ...schedule, ...JSON.parse(String(init.body)) };
        return response(schedule);
      }
      return original(url, init);
    });
    const element = document.createElement('network-device-detail') as any;
    element.deviceId = 4; document.body.append(element); await settle(element);
    const tab = () => Array.from(element.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(b => b.textContent?.trim() === '配置备份')!;
    tab().click(); await settle(element);
    const time = element.querySelector('input[type="time"]') as HTMLInputElement;
    expect(time.value).toBe('00:00');
    time.value = '03:45'; time.dispatchEvent(new Event('input', { bubbles: true })); await settle(element);
    const enabled = element.querySelector('input[type="checkbox"]') as HTMLInputElement;
    enabled.checked = false; enabled.dispatchEvent(new Event('change', { bubbles: true })); await settle(element);
    element.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(element);
    expect(schedule).toMatchObject({ enabled: false, dailyTime: '03:45' });
    expect(showToast).toHaveBeenCalledWith('定时备份设置已保存', 'success');
    await element.loadContext(); await settle(element);
    expect(element.querySelector('input[type="time"]').value).toBe('03:45');
    expect(element.querySelector('input[type="checkbox"]').checked).toBe(false);
  });

  it('keeps unsaved schedule edits and shows a Chinese error when saving is forbidden', async () => {
    const original = authFetch.getMockImplementation()!;
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'PUT'
      ? response({ error: '权限不足' }, false, 403) : original(url, init));
    const element = document.createElement('network-device-detail') as any;
    element.deviceId = 4; document.body.append(element); await settle(element);
    element.activeTab = 'backups'; await settle(element);
    element.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(element);
    expect(element.querySelector('[role="alert"]').textContent).toContain('权限不足');
    expect(showToast).not.toHaveBeenCalledWith('定时备份设置已保存', 'success');
    expect(element.querySelector('button[type="submit"]').disabled).toBe(false);
  });
  beforeEach(() => {
    authFetch.mockReset();
    showToast.mockReset();
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/network-devices/4") return response(device);
      if (url.endsWith("/metrics")) return response({ deviceId: 4, metrics: [
        { metricId: "device_cpu_percent", value: 12, quality: "good", source: "snmpv3", observedAt: "2026-08-26T00:00:00.000Z" },
        { metricId: "interface_in_bps", value: 1000000, quality: "good", source: "snmpv3", dimensions: { if_index: "1", direction: "in" }, observedAt: "2026-08-26T00:00:00.000Z" },
        { metricId: "interface_out_bps", value: 2000000, quality: "good", source: "snmpv3", dimensions: { if_index: "1", direction: "out" }, observedAt: "2026-08-26T00:00:00.000Z" },
        { metricId: "interface_error_rate", value: 3, quality: "good", source: "snmpv3", dimensions: { if_index: "1", direction: "in" }, observedAt: "2026-08-26T00:00:00.000Z" },
        { metricId: "interface_error_rate", value: 6, quality: "good", source: "snmpv3", dimensions: { if_index: "1", direction: "out" }, observedAt: "2026-08-26T00:00:00.000Z" },
        { metricId: "interface_drop_rate", value: 4, quality: "good", source: "snmpv3", dimensions: { if_index: "1", direction: "in" }, observedAt: "2026-08-26T00:00:00.000Z" },
        { metricId: "interface_drop_rate", value: 8, quality: "good", source: "snmpv3", dimensions: { if_index: "1", direction: "out" }, observedAt: "2026-08-26T00:00:00.000Z" },
      ] });
      if (url.endsWith("/interfaces")) return response({ interfaces: [{ id: 1, deviceId: 4, ifIndex: 1, ifName: "GigabitEthernet0/0/1", ifAlias: "uplink", speedBps: 1000000000, adminStatus: "up", operStatus: "up", lastSeenAt: "2026-08-26T00:00:00.000Z" }] });
      if (url.endsWith("/capabilities")) return response({ capabilities: [{ key: "metrics", state: "verified", evidence: null, reason: null, checkedAt: null, validUntil: null }] });
      if (url.endsWith("/backup-schedule")) return response({ enabled: true, dailyTime: "00:00", timeZone: "Asia/Shanghai", lastRun: null });
      if (url.endsWith("/relations")) return response({ relations: [] });
      if (url.endsWith("/config-backups")) return response({ backups: [{ id: 8, deviceId: 4, versionNo: 1, contentSha256: "a".repeat(64), sourceProtocol: "ssh", collectedAt: "2026-08-26T00:00:00.000Z", sizeBytes: 20, redactionStatus: "redacted" }] });
      if (url.endsWith("/config-backups/8")) return response({ id: 8, deviceId: 4, versionNo: 1, contentSha256: "a".repeat(64), sourceProtocol: "ssh", collectedAt: "2026-08-26T00:00:00.000Z", sizeBytes: 20, redactionStatus: "redacted", preview: "username <redacted>" });
      throw new Error(`unexpected request: ${url}`);
    });
  });
  afterEach(() => document.body.replaceChildren());

  it("loads the device overview and exposes semantic interface metrics and backup tabs", async () => {
    const element = document.createElement("network-device-detail") as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    expect(element.textContent).toContain("Edge 4");

    const buttons = () => Array.from(element.querySelectorAll("button") as NodeListOf<HTMLButtonElement>);
    const tab = (label: string) => buttons().find((button) => button.textContent?.trim() === label);
    tab("接口")?.click();
    await settle(element);
    expect(element.querySelector('semantic-metrics[resourceType="network_device"]')).toBeTruthy();
    expect(authFetch.mock.calls.some(([url]) => String(url).endsWith('/interfaces'))).toBe(false);

    tab("配置备份")?.click();
    await settle(element);
    expect(element.textContent).toContain("加密配置备份");
    expect(element.textContent).toContain("已脱敏");
  });

  it("requests ordinary backup detail without raw=true and renders preview as text", async () => {
    const element = document.createElement("network-device-detail") as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    const buttons = () => Array.from(element.querySelectorAll("button") as NodeListOf<HTMLButtonElement>);
    const backupsTab = buttons().find((button) => button.textContent?.trim() === "配置备份");
    backupsTab?.click();
    await settle(element);
    const viewButton = buttons().find((button) => button.textContent?.includes("查看摘要"));
    expect(viewButton).toBeTruthy();
    viewButton?.click();
    await settle(element);

    expect(authFetch.mock.calls.some(([url]) => String(url).includes("raw=true"))).toBe(false);
    expect(element.textContent).toContain("username <redacted>");
  });

  it("explains how to configure SSH credentials when backup capture is unavailable", async () => {
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/network-devices/4") return response(device);
      if (url.endsWith("/metrics")) return response({ deviceId: 4, metrics: [] });
      if (url.endsWith("/interfaces")) return response({ interfaces: [] });
      if (url.endsWith("/capabilities")) return response({ capabilities: [] });
      if (url.endsWith("/backup-schedule")) return response({ enabled: true, dailyTime: "00:00", timeZone: "Asia/Shanghai", lastRun: null });
      if (url.endsWith("/relations")) return response({ relations: [] });
      if (url.endsWith("/config-backups") && init?.method === "POST") {
        return response({ error: "SSH_CREDENTIAL_REQUIRED" }, false, 400);
      }
      if (url.endsWith("/config-backups")) return response({ backups: [] });
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement("network-device-detail") as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    const button = Array.from(element.querySelectorAll("button") as NodeListOf<HTMLButtonElement>)
      .find((item) => item.textContent?.trim() === "立即备份");
    button?.click();
    await settle(element);

    expect(showToast).toHaveBeenCalledWith("请先编辑网络设备并配置 SSH 用户名和密码或私钥", "error");
  });

  it("binds the interface metric view to the selected network device", async () => {
    const element = document.createElement("network-device-detail") as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    const buttons = () => Array.from(element.querySelectorAll("button") as NodeListOf<HTMLButtonElement>);
    buttons().find((button) => button.textContent?.trim() === "接口")?.click();
    await settle(element);

    const metrics = element.querySelector('semantic-metrics[resourceType="network_device"]') as any;
    expect(metrics).toBeTruthy();
    expect(metrics.resourceId).toBe(4);
    expect(authFetch.mock.calls.some(([url]) => String(url).endsWith('/metrics'))).toBe(false);
    expect(authFetch.mock.calls.some(([url]) => String(url).endsWith('/interfaces'))).toBe(false);
  });
});
