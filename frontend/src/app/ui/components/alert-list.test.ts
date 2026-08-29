import { afterEach, describe, expect, it } from "vitest";

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
});
