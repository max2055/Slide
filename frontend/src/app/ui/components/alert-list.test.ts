import { afterEach, describe, expect, it } from "vitest";

import type { AlertList } from "./alert-list.js";
import "./alert-list.js";

async function settle(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

describe("alert-list network-device targets", () => {
  afterEach(() => document.body.replaceChildren());

  it("emits a device navigation event for a network-device alert target", async () => {
    const element = document.createElement("alert-list") as any;
    element.alerts = [{
      id: 1,
      instance_id: null,
      alert_type: "network_interface_down",
      severity: "critical",
      title: "Interface down",
      message: "GigabitEthernet0/0/1 is down",
      status: "acknowledged",
      acknowledged: true,
      created_at: "2026-08-26T00:00:00.000Z",
      target_type: "network_device",
      network_device_id: 9,
      network_device_name: "Huawei edge",
    }];
    element.loading = false;
    element.total = 1;
    element.stats = { total: 1, resolved: 0, unread: 0, critical: 1, warning: 0 };
    let detail: unknown;
    element.addEventListener("alert-navigate-network-device", (event: CustomEvent) => { detail = event.detail; });
    document.body.append(element);
    await settle(element);

    const target = element.shadowRoot?.querySelector(".instance-badge") as HTMLElement | null;
    expect(target).toBeTruthy();
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(detail).toEqual({ id: 9 });
  });

  it("keeps pagination and the selected resource on a page with no local matches", async () => {
    const element = document.createElement("alert-list") as AlertList;
    element.total = 54;
    element.filterTargetType = "server";
    element.filterServerId = 7;
    element.servers = [{ id: 7, host: "fixture.invalid" }];
    let newPage: number | undefined;
    element.addEventListener("alert-page-change", (event) => { newPage = (event as CustomEvent<{ page: number }>).detail.page; });
    document.body.append(element);
    await settle(element);

    expect(element.shadowRoot?.querySelector('[aria-label="告警列表范围"]')?.textContent).toContain("本页匹配 0 条");
    expect(element.shadowRoot?.querySelector<HTMLSelectElement>('[aria-label="服务器"]')?.value).toBe("7");
    const next = [...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>(".pagination button") ?? [])]
      .find((button) => button.textContent?.includes("下一页"));
    expect(next?.disabled).toBe(false);
    next?.click();
    expect(newPage).toBe(1);
  });
});
