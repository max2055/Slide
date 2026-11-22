import { afterEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
import "./template-event-evidence.js";
import "./event-investigation-record.js";

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
  e.allowClose = true;
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
  expect(root.textContent).toContain("尚无恢复记录");
  expect(root.textContent).toContain("问题条件转假且满足独立恢复条件");
  expect(root.textContent).toContain("停止评估：没有有效指标提供者");
  expect(root.textContent).toContain("资源现时健康");
  expect(root.querySelector("template-event-close")).toBeNull();
  expect([...root.querySelectorAll("button")].find((b: any) => b.textContent.includes("确认处理"))!.disabled).toBe(true);
});

it.each([false, true])('reports manual closure separately from recovery in event detail (investigation %s)', async (investigation) => {
  const at = '2026-11-01T00:00:00Z';
  const rule = { rule_id: 'rule', version: 1, item: { template_id: 'tpl', item_version: 1 },
    metric: { id: 'fixture.metric', semantic_version: '1.0.0' }, unit: 'count', quality: { min_coverage: 1 },
    parameters: [], allow_manual_close: true, recovery_mode: 'none',
    problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { value: 90 } } };
  authFetch.mockResolvedValue({ ok: true, json: async () => ({
    event_id: 7, can_manual_close: false,
    episode: { rule_id: 'rule', state: 'closed', recovery_count: 0, closed_at: '2026-11-01T00:01:00Z',
      manual_close: { actor_id: 12 }, opened: { at, value: 95 }, last: { at, value: 95, quality: 'good' },
      resource: { type: 'instance', id: '5' }, unknown_segments: [] },
    snapshot: { configuration: { rules: [rule], templates: [{ template_id: 'tpl', version: 1 }] }, opening: { sample_ids: ['sample'], attempt_ids: [] } },
    processing: { status: 'closed', acknowledged_at: null }, receipts: [], deliveries: [],
  }) });
  const element = document.createElement(investigation ? 'event-investigation-record' : 'template-event-evidence') as any;
  element.eventId = 7;
  element.allowClose = true;
  element.full = true;
  element.event = { id: 7, title: '模板事件', source_type: 'template-trigger', status: 'closed', created_at: at };
  document.body.append(element);
  await vi.waitFor(() => expect(element.shadowRoot.textContent).toContain('已手动关闭'));
  const root = element.shadowRoot;
  expect(root.textContent).not.toMatch(/本次告警已恢复|本次阈值已恢复|恢复样本/);
  expect(root.querySelector('template-event-close')).toBeNull();
  if (investigation) {
    [...root.querySelectorAll('nav button')].find((button: HTMLElement) => button.textContent === '时间线').click();
    await element.updateComplete;
  }
  expect(root.textContent).toContain('操作者 #12');
});
