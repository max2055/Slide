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
      if (url.endsWith("/relations")) return response({ relations: [] });
      if (url.endsWith("/config-backups")) return response({ backups: [{ id: 8, deviceId: 4, versionNo: 1, contentSha256: "a".repeat(64), sourceProtocol: "ssh", collectedAt: "2026-08-26T00:00:00.000Z", sizeBytes: 20, redactionStatus: "redacted" }] });
      if (url.endsWith("/config-backups/8")) return response({ id: 8, deviceId: 4, versionNo: 1, contentSha256: "a".repeat(64), sourceProtocol: "ssh", collectedAt: "2026-08-26T00:00:00.000Z", sizeBytes: 20, redactionStatus: "redacted", preview: "username <redacted>" });
      throw new Error(`unexpected request: ${url}`);
    });
  });
  afterEach(() => document.body.replaceChildren());

  it("loads the device overview and exposes interface and backup tabs", async () => {
    const element = document.createElement("network-device-detail") as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    expect(element.textContent).toContain("Edge 4");

    const buttons = () => Array.from(element.querySelectorAll("button") as NodeListOf<HTMLButtonElement>);
    const tab = (label: string) => buttons().find((button) => button.textContent?.trim() === label);
    tab("Interfaces")?.click();
    await settle(element);
    expect(element.textContent).toContain("GigabitEthernet0/0/1");

    tab("Backups")?.click();
    await settle(element);
    expect(element.textContent).toContain("Encrypted configuration backups");
    expect(element.textContent).toContain("redacted");
  });

  it("requests ordinary backup detail without raw=true and renders preview as text", async () => {
    const element = document.createElement("network-device-detail") as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    const buttons = () => Array.from(element.querySelectorAll("button") as NodeListOf<HTMLButtonElement>);
    const backupsTab = buttons().find((button) => button.textContent?.trim() === "Backups");
    backupsTab?.click();
    await settle(element);
    const viewButton = buttons().find((button) => button.textContent?.includes("View summary"));
    expect(viewButton).toBeTruthy();
    viewButton?.click();
    await settle(element);

    expect(authFetch.mock.calls.some(([url]) => String(url).includes("raw=true"))).toBe(false);
    expect(element.textContent).toContain("username <redacted>");
  });

  it("shows per-interface traffic, errors, and drops from dimensioned observations", async () => {
    const element = document.createElement("network-device-detail") as any;
    element.deviceId = 4;
    document.body.append(element);
    await settle(element);

    const buttons = () => Array.from(element.querySelectorAll("button") as NodeListOf<HTMLButtonElement>);
    buttons().find((button) => button.textContent?.trim() === "Interfaces")?.click();
    await settle(element);

    expect(element.textContent).toContain("In traffic");
    expect(element.textContent).toContain("Out traffic");
    expect(element.textContent).toContain("Errors");
    expect(element.textContent).toContain("Drops");
    expect(element.textContent).toContain("1.0 Mbps");
    expect(element.textContent).toContain("2.0 Mbps");
    expect(element.textContent).toContain("3.0/s");
    expect(element.textContent).toContain("4.0/s");
    expect(element.textContent).toContain("6.0/s");
    expect(element.textContent).toContain("8.0/s");
  });
});
