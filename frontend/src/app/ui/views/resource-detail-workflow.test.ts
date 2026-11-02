import "./audit-center.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch, apiClient: { get: async () => ({items:[],total:0}) } }));
import "./network-device-detail.js";
import "../components/resource-collection-section.js";
import "../components/resource-event-context.js";
const response = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
async function settle(el: any) {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}
beforeEach(() => {
  history.replaceState({}, "", "/network-device-detail?networkDeviceId=4");
  localStorage.setItem("permissions", '["network_devices:view"]');
  authFetch.mockReset();
});
afterEach(() => document.body.replaceChildren());
it("retains the full network identity when a professional module fails and keeps backup writes disabled for a viewer", async () => {
  authFetch.mockImplementation(async (url: string) =>
    url === "/api/network-devices/4"
      ? response({ id: 4, name: "protected identity", host: "192.0.2.4", vendor: "huawei" })
      : url.endsWith("/relations")
        ? response({ error: "关系读取失败" }, 503)
        : url.endsWith("/config-backups")
          ? response({ backups: [] })
          : url.endsWith("/backup-schedule")
            ? response({ enabled: false, dailyTime: "01:00" })
            : response({ items: [] }),
  );
  const el = document.createElement("network-device-detail") as any;
  el.deviceId = 4;
  document.body.append(el);
  await settle(el);
  expect(el.textContent).toContain("protected identity");
  expect(el.querySelectorAll('[role="tab"]')).toHaveLength(6);
  const backup = [...el.querySelectorAll("button")].find((b: any) =>
    b.textContent.includes("立即备份"),
  ) as HTMLButtonElement;
  expect(backup.disabled).toBe(true);
  el.activeTab = "relations";
  await settle(el);
  expect(el.querySelector('[role="alert"]').textContent).toContain("关系读取失败");
  expect(el.textContent).toContain("protected identity");
  window.dispatchEvent(new Event("slide-permissions-loaded"));
  await settle(el);
  expect(el.textContent).not.toContain("protected identity");
  expect(el.querySelector('[role="tablist"]')).toBeNull();
});
it("opens the existing configuration source inside the same resource instead of navigating to the list", async () => {
  authFetch.mockResolvedValue(response({}, 503));
  const el = document.createElement("resource-collection-section") as any;
  el.resourceType = "server";
  el.resourceId = 11;
  document.body.append(el);
  await settle(el);
  const navigate = vi.fn();
  window.addEventListener("slide-navigate", navigate);
  el.openEditor();
  await settle(el);
  const editor = el.shadowRoot.querySelector("metric-configuration");
  expect(editor.resourceId).toBe(11);
  expect(editor.resourceType).toBe("server");
  expect(navigate).not.toHaveBeenCalled();
  window.removeEventListener("slide-navigate", navigate);
});
it("rejects invalid resource event scope without falling back to global or stale events", async () => {
  history.replaceState({}, "", "/events?resource=server:9&from=invalid&to=invalid");
  const el = document.createElement("resource-event-context") as any;
  document.body.append(el);
  await settle(el);
  expect(authFetch).not.toHaveBeenCalled();
  expect(el.shadowRoot.querySelector('[role="alert"]').textContent).toContain("无效");
});

it('keeps scoped audits on the filtered system view instead of widening into agent audits',async()=>{
 history.replaceState({},'','/audit-center?resource=server:25&from=2026-10-31T00:00:00.000Z&to=2026-10-31T01:00:00.000Z&view=agent');
 const el=document.createElement('audit-center-page') as any;document.body.append(el);await settle(el);
 expect(el.shadowRoot.querySelector('system-audit-page')).not.toBeNull();expect(el.shadowRoot.querySelector('agent-tool-audit-page')).toBeNull();
 expect([...el.shadowRoot.querySelectorAll('button')].find((b:any)=>b.textContent.includes('Agent')).disabled).toBe(true);
});
