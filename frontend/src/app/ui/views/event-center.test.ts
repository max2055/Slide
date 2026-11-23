import { afterEach, describe, expect, it } from "vitest";
import "./event-center.js";
import { EventCenterPage } from './event-center.js';

describe("event center navigation", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  async function renderAt(path: string) {
    window.history.replaceState({}, "", path);
    const element = new EventCenterPage();
    element.permissions = new Set(['alert:view']);
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
  it('waits for aggregate authority and unmounts facts on revocation', async () => {
    const element = await renderAt('/events?view=aggregate');
    element.permissions = null; await element.updateComplete;
    expect(element.shadowRoot!.querySelector('[role="status"]')?.textContent).toContain('正在确认访问权限');
    expect(element.shadowRoot!.querySelector('event-management-page')).toBeNull();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', {detail:{permissions:['alert:view']}})); await element.updateComplete;
    expect(element.shadowRoot!.querySelector('event-management-page')).not.toBeNull();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', {detail:{permissions:[]}})); await element.updateComplete;
    expect(element.shadowRoot!.querySelector('event-management-page')).toBeNull();
    expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('无访问权限');
  });

  it("keeps old rules navigation on the four-tab center without a rule editor", async()=>{
    const element=await renderAt('/events?view=rules');
    expect(element.shadowRoot!.querySelector('event-management-page')).not.toBeNull();
    expect(element.shadowRoot!.querySelector('alerts-page[mode="rules"]')).toBeNull();
    expect(element.shadowRoot!.querySelector('a[href="/?tab=instances-db"]')).toBeNull();
  });
  it("writes tab changes to the URL and responds to popstate", async () => {
    const element = await renderAt("/events?view=active");
    const tabs = element.shadowRoot!.querySelectorAll<HTMLButtonElement>('[role="tab"]');

    tabs[2].click();
    await element.updateComplete;
    expect(new URL(window.location.href).searchParams.get("view")).toBe("notifications");
    expect(element.shadowRoot!.querySelector('alerts-page[mode="notifications"]')).not.toBeNull();

    window.history.replaceState({}, "", "/events");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('.tab.active')?.textContent?.trim()).toBe("活动告警");
  });
});
