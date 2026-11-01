import { afterEach, describe, expect, it } from "vitest";
import "./event-center.js";

describe("event center navigation", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  async function renderAt(path: string) {
    window.history.replaceState({}, "", path);
    const element = document.createElement("event-center-page") as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

  it("exposes lifecycle and System views and restores the requested view", async () => {
    const element = await renderAt("/events?view=aggregate");
    const root = element.shadowRoot!;

    expect([...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "活动告警", "聚合事件", "通知投递", "平台异常",
    ]);
    expect(root.querySelector("event-management-page")).not.toBeNull();
  });

  it("keeps old rules navigation on the four-tab center without a rule editor", async()=>{
    const element=await renderAt('/events?view=rules');
    expect(element.shadowRoot!.querySelector('event-management-page')).not.toBeNull();
    expect(element.shadowRoot!.querySelector('alerts-page[mode="rules"]')).toBeNull();
    expect(element.shadowRoot!.querySelector('a')?.getAttribute('href')).toBe('/?tab=instances-db');
  });
  it("writes tab changes to the URL and responds to popstate", async () => {
    const element = await renderAt("/events?view=active");
    const tabs = element.shadowRoot!.querySelectorAll<HTMLButtonElement>('[role="tab"]');

    tabs[2].click();
    await element.updateComplete;
    expect(new URL(window.location.href).searchParams.get("view")).toBe("notifications");
    expect(element.shadowRoot!.querySelector('alerts-page[mode="notifications"]')).not.toBeNull();

    window.history.replaceState({}, "", "/events?view=notifications");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('.tab.active')?.textContent?.trim()).toBe("通知投递");
  });
});
