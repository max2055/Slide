import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
vi.mock("../components/app-toast-container.js", () => ({ showToast }));

import "./network-devices-page.js";

const response = (body: unknown, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => body });

async function settle(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

describe("network-devices-page", () => {
  beforeEach(() => { authFetch.mockReset(); showToast.mockReset(); });
  afterEach(() => document.body.replaceChildren());

  it("renders a stable empty state after loading an empty inventory", async () => {
    authFetch.mockResolvedValue(response([]));
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    expect(element.textContent).toContain("暂无网络设备");
    expect(authFetch).toHaveBeenCalledWith("/api/network-devices");
  });

  it("renders API errors with retry instead of throwing", async () => {
    authFetch.mockResolvedValue(response({ error: "NETWORK_DEVICE_OPERATION_FAILED" }, false, 503));
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    expect(element.textContent).toContain("NETWORK_DEVICE_OPERATION_FAILED");
    expect(element.querySelector('[role="alert"]')).toBeTruthy();
  });

  it("uses the shared four-action order and explains scheduled collection", async () => {
    authFetch.mockResolvedValue(response([{
      id: 7,
      name: "switch-01",
      label: "核心交换机",
      host: "10.0.0.7",
      site: "机房",
      model: "S5735",
      status: "online",
      collection_enabled: true,
      last_check_at: null,
    }]));
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    expect([...element.querySelectorAll("app-data-table .btn-sm")].map((button: HTMLButtonElement) => button.textContent?.trim())).toEqual(["详情", "编辑", "测试", "删除"]);
    expect(element.textContent).toContain("指标由后台按计划自动采集");
  });

  it("confirms and deletes a managed device through the existing API", async () => {
    const device = {
      id: 7, name: "switch-01", label: "核心交换机", host: "10.0.0.7", site: "机房",
      model: "S5735", status: "online", collection_enabled: true, last_check_at: null,
    };
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/network-devices" && !init) return response([device]);
      if (url === "/api/network-devices/7" && init?.method === "DELETE") return response({ ok: true });
      if (url === "/api/network-devices" && init === undefined) return response([]);
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    element.confirmDelete(device);
    await element.updateComplete;
    expect(element.querySelector('app-dialog[title="确认删除网络设备"]')).toBeTruthy();
    await element.deleteDevice();
    expect(authFetch).toHaveBeenCalledWith("/api/network-devices/7", { method: "DELETE" });
    expect(showToast).toHaveBeenCalledWith("网络设备已删除", "success");
  });

  it("uses POST for a read-only SNMPv3 probe and never exposes a write command", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/network-devices") return response([]);
      if (url === "/api/network-devices/test-connection") return response({ success: true });
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    element.openCreate();
    element.form = { ...element.form, host: "10.0.0.8", snmpVersion: 3, username: "readonly", authSecret: "secret123", privacySecret: "private123" };
    await element.testConnection();
    const call = authFetch.mock.calls.find(([url]) => url === "/api/network-devices/test-connection");
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(call?.[1]?.body).version).toBe(3);
    expect(element.textContent).not.toMatch(/restore|config push|SNMP SET|任意命令/i);
  });

  it("tests SSH independently without requiring SNMP or a host-key fingerprint", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/network-devices") return response([]);
      if (url === "/api/network-devices/test-connection") return response({ success: true });
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    element.openCreate();
    element.form = {
      ...element.form,
      host: "10.0.0.8", sshUsername: "ops", sshCredentialValue: "secret",
    };

    await element.testSshConnection();

    const call = authFetch.mock.calls.find(([url]) => url === "/api/network-devices/test-connection");
    expect(JSON.parse(call?.[1]?.body)).toEqual({
      mode: "ssh",
      host: "10.0.0.8",
      sshPort: 22,
      ssh: { protocol: "ssh", credentialType: "password", username: "ops", credentialValue: "secret" },
    });
    expect(showToast).toHaveBeenCalledWith("SSH 连接成功", "success");
    expect(element.formError).toBeNull();
  });

  it("defaults new devices to SNMPv2c and omits nonessential and host-key fields", async () => {
    authFetch.mockResolvedValue(response([]));
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    element.openCreate();
    await settle(element);
    expect(element.querySelector('app-form-field[label="SSH 用户名"]')).toBeTruthy();
    expect(element.querySelector('app-ssh-auth-selector')).toBeTruthy();
    expect(element.querySelector('app-form-field[label="Community"]')).toBeTruthy();
    const snmpVersion = element.querySelector('app-form-field[label="SNMP 版本"] select') as HTMLSelectElement | null;
    expect(snmpVersion?.value).toBe("2");
    expect(element.querySelector('app-form-field[label="标签"]')).toBeNull();
    expect(element.querySelector('app-form-field[label="站点"]')).toBeNull();
    expect(element.textContent).not.toContain("主机密钥指纹");
    expect(element.querySelector('app-form-field[label="型号（可选）"]')).toBeTruthy();
    expect(element.querySelector('app-form-field[label="OS 版本（可选）"]')).toBeTruthy();
    expect(element.querySelector('.credential-section')).toBeTruthy();
  });

  it("renders add-device fields as inline label-control rows", async () => {
    authFetch.mockResolvedValue(response([]));
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    element.openCreate();
    await settle(element);
    const fields = [...element.querySelectorAll('app-dialog[title="添加网络设备"] app-form-field')] as any[];
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.inline)).toBe(true);
    expect(element.querySelectorAll(".device-form-section")).toHaveLength(3);
  });

  it("submits SSH credentials without requiring a host-key fingerprint", async () => {
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/network-devices" && init?.method === "POST") return response({ id: 7 }, true, 201);
      if (url === "/api/network-devices") return response([]);
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    element.openCreate();
    element.form = {
      ...element.form,
      name: "edge-1", host: "10.0.0.8", snmpVersion: 3, username: "monitor",
      securityLevel: "noAuthNoPriv", sshUsername: "ops", sshCredentialValue: "secret",
    };

    await element.saveDevice();

    const call = authFetch.mock.calls.find(([url, init]) => url === "/api/network-devices" && init?.method === "POST");
    expect(call).toBeTruthy();
    expect(JSON.parse(call?.[1]?.body).ssh).toEqual({
      protocol: "ssh", credentialType: "password", username: "ops", credentialValue: "secret",
    });
  });

  it("submits Cisco SNMPv2c enrollment without v3 fields", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/network-devices") return response([]);
      if (url === "/api/network-devices/test-connection") return response({ success: true });
      throw new Error(`unexpected request: ${url}`);
    });
    const element = document.createElement("network-devices-page") as any;
    document.body.append(element);
    await settle(element);
    element.openCreate();
    element.form = { ...element.form, host: "10.0.0.9", vendor: "cisco", snmpVersion: 2, community: "readonly" };
    await element.testConnection();
    const call = authFetch.mock.calls.find(([url]) => url === "/api/network-devices/test-connection");
    const body = JSON.parse(call?.[1]?.body);
    expect(body).toMatchObject({ vendor: "cisco", version: 2, snmpv2c: { version: 2, community: "readonly" } });
    expect(body.snmpv3).toBeUndefined();
  });
});
