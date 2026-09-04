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

  it("exposes the four lifecycle views and restores the requested view", async () => {
    const element = await renderAt("/events?view=aggregate");
    const root = element.shadowRoot!;

    expect([...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "活动告警", "聚合事件", "规则与策略", "通知投递",
    ]);
    expect(root.querySelector("event-management-page")).not.toBeNull();
  });

  it("writes tab changes to the URL and responds to popstate", async () => {
    const element = await renderAt("/events?view=active");
    const tabs = element.shadowRoot!.querySelectorAll<HTMLButtonElement>('[role="tab"]');

    tabs[2].click();
    await element.updateComplete;
    expect(new URL(window.location.href).searchParams.get("view")).toBe("rules");
    expect(element.shadowRoot!.querySelector('alerts-page[mode="rules"]')).not.toBeNull();

    window.history.replaceState({}, "", "/events?view=notifications");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('.tab.active')?.textContent?.trim()).toBe("通知投递");
  });
});
