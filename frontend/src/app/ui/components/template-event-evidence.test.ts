import { afterEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
import "./template-event-evidence.js";

afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });

it.each([
  ["instance", "/?tab=instance-detail&id=7"],
  ["server", "/?tab=server-detail&id=7"],
  ["network_device", "/?tab=network-device-detail&networkDeviceId=7"],
])("keeps %s historical rules separate from current configuration navigation", async (type, href) => {
  const rule = { rule_id: "rule", version: 1, item: { template_id: "template", item_version: 1 },
    metric: { id: "fixture.metric", semantic_version: "1.0.0" }, unit: "s", quality: { min_coverage: 1 }, parameters: [],
    problem: { node: "compare", select: { aggregation: "last" }, operator: ">", threshold: { value: 90 } },
    recovery: { node: "compare", select: { aggregation: "last" }, operator: "<", threshold: { value: 70 } } };
  authFetch.mockResolvedValue({ ok: true, json: async () => ({
    episode: { rule_id: "rule", episode_id: "episode", resource: { type, id: "7" }, state: "open", opened: { value: 95, at: "2026-11-01T00:00:00Z" }, last: { value: 85, quality: "good", reason: "problem_retained" }, unknown_segments: [], recovery_count: 0 },
    snapshot: { configuration: { config_revision: 1, rules: [rule], templates: [{ template_id: "template", version: 2 }] }, opening: { sample_ids: ["sample"], samples: [], attempt_ids: ["attempt"] } },
    evaluation: { state: "stopped", reason: "no_enabled_provider" }, current: { revision: 2 }, processing: { status: "acknowledged", acknowledged_at: "2026-11-01T00:01:00Z" }, deliveries: [], receipts: [],
  }) });
  const e = document.createElement("template-event-evidence") as any;
  e.eventId = 1;
  document.body.append(e);
  await new Promise(resolve => setTimeout(resolve, 20));
  await e.updateComplete;
  expect(authFetch.mock.calls[0][0]).toBe("/api/metrics/template-events/1");
  const root = e.shadowRoot;
  const details = root.querySelector("details") as HTMLDetailsElement;
  details.querySelector("summary")!.click();
  expect(details.open).toBe(true);
  expect(JSON.parse(details.querySelector("pre")!.textContent!)).toEqual(rule);
  expect(root.querySelector("a").getAttribute("href")).toBe(href);
  expect(root.querySelector("a").textContent).toContain("r2");
  expect(root.textContent).toContain("配置 r1");
  expect(root.textContent).toContain("问题持续");
  expect(root.textContent).toContain("停止评估：没有有效指标提供者");
  expect([...root.querySelectorAll("button")].find((b: any) => b.textContent.includes("确认处理"))!.disabled).toBe(true);
});
