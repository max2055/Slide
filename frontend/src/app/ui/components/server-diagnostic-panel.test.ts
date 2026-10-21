import { afterEach, describe, expect, it } from "vitest";
import type { ServerDiagnosticEvidence } from "./server-diagnostic-panel.js";
import "./server-diagnostic-panel.js";

const evidence: ServerDiagnosticEvidence = {
  serverId: 7,
  collectedAt: "2026-08-26T08:00:00.000Z",
  expiresAt: "2026-08-26T08:05:00.000Z",
  quality: "partial",
  truncated: true,
  sections: {
    network: {
      source: ["/proc/net/dev"],
      collectedAt: "2026-08-26T08:00:00.000Z",
      quality: "good",
      truncated: false,
      items: [{ interface: "eth0", rxErrors: 2, txErrors: 0 }],
    },
    processes: {
      source: ["/proc"],
      collectedAt: "2026-08-26T08:00:00.000Z",
      quality: "partial",
      truncated: true,
      items: [{ pid: 12, command: "sshd", cpuPercent: 1.2 }],
    },
    services: {
      source: ["systemctl"],
      collectedAt: "2026-08-26T08:00:00.000Z",
      quality: "unknown",
      truncated: false,
      items: [],
      reason: "SERVICE_QUERY_UNAVAILABLE",
    },
    logs: {
      source: ["journalctl"],
      collectedAt: "2026-08-26T08:00:00.000Z",
      quality: "good",
      truncated: false,
      items: [{ timestamp: "2026-08-26T07:59:00.000Z", severity: "warning", message: "disk pressure" }],
    },
  },
  gaps: [{ section: "services", code: "SERVICE_QUERY_UNAVAILABLE", reason: "systemctl unavailable" }],
};

async function settle(element: HTMLElement & { updateComplete?: Promise<unknown> }) {
  await element.updateComplete;
}

describe("server-diagnostic-panel", () => {
  afterEach(() => document.body.replaceChildren());

  it("renders evidence quality, source, freshness, truncation and gap reasons", async () => {
    const element = document.createElement("server-diagnostic-panel") as any;
    element.evidence = evidence;
    document.body.append(element);
    await settle(element);

    const text = element.shadowRoot?.textContent ?? element.textContent ?? "";
    expect(text).toContain("partial");
    expect(text).toContain("/proc/net/dev");
    expect(text).toContain("2026-08-26");
    expect(text).toContain("truncated");
    expect(text).toContain("SERVICE_QUERY_UNAVAILABLE");
    expect(text).toContain("systemctl unavailable");
  });

  it("keeps untrusted log/config text as text nodes", async () => {
    const payload = structuredClone(evidence);
    payload.sections.logs.items[0].message = '<img src=x onerror="alert(1)">';
    const element = document.createElement("server-diagnostic-panel") as any;
    element.evidence = payload;
    document.body.append(element);
    await settle(element);

    expect(element.shadowRoot?.querySelector("img")).toBeNull();
    expect(element.shadowRoot?.textContent).toContain("<img src=x onerror=\"alert(1)\">");
  });

  it("renders a stable empty state when no evidence is available", async () => {
    const element = document.createElement("server-diagnostic-panel") as any;
    document.body.append(element);
    await settle(element);
    expect(element.shadowRoot?.textContent).toContain("尚无诊断证据");
  });
});

it('renders each API section once, explains empty logs in Chinese, and hides raw fields in details', async () => {
  const section = (items: any[], reason?: string) => ({ items, reason, source: ['SSH'], collectedAt: '2026-10-21T00:00:00Z', quality: 'partial' });
  const services = section([{ name: 'sshd.service', activeState: 'active', loadState: 'loaded', subState: 'running', description: 'SSH server' }]);
  const logs = section([], 'SYSTEM_LOGS_EMPTY');
  const element = document.createElement('server-diagnostic-panel') as any;
  element.evidence = { sections: { services, topProcesses: section([{ pid: 1, cpuPercent: 0 }]), systemLogs: logs, listeningPorts: section([{ port: 22 }]), interfaceErrors: section([{ rxErrors: 0 }]) }, serviceStatus: services, recentSystemLogs: logs, gaps: [{ section: 'systemLogs', reason: 'SYSTEM_LOGS_EMPTY' }] };
  document.body.append(element); await settle(element);
  expect(element.shadowRoot.querySelectorAll('.evidence-section')).toHaveLength(5);
  expect(element.shadowRoot.textContent).toContain('最近五分钟未取得警告及以上系统日志');
  expect(element.shadowRoot.textContent).toContain('没有日志不代表服务器正常');
  expect(element.shadowRoot.querySelector('details pre')?.textContent).toBeTruthy();
  element.sectionFilter = 'logs'; await settle(element);
  expect(element.shadowRoot.querySelectorAll('.evidence-section')).toHaveLength(1);
  expect(element.shadowRoot.querySelectorAll('.gap')).toHaveLength(1);
});
