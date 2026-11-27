import { afterEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
import "./template-event-evidence.js";
import "./event-investigation-record.js";

afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });

it('matches the exact opening trigger and withholds a snapshot linked to another alert', async () => {
  const rule = { rule_id: 'rule', version: 2, scope: 'scope', body_hash: 'opening-hash',
    item: { template_id: 'tpl', item_version: 1 }, metric: { id: 'fixture.metric' }, unit: 'count',
    problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { value: 90 } } };
  const detail = {
    event_id: 7, alert_id: 8, episode: { ...rule, last: {} },
    snapshot: { configuration: { config_revision: 3, rules: [{ ...rule, version: 1 }, rule],
      templates: [{ template_id: 'tpl', version: 4 }] } },
  };
  const evidence = document.createElement('template-event-evidence') as any;
  evidence.eventId = 7;
  evidence.alertId = 8;
  authFetch.mockResolvedValueOnce(Response.json({ ...detail, alert_id: 9 }));
  document.body.append(evidence);
  const root = evidence.shadowRoot!;
  await vi.waitFor(() => expect(root.textContent).toContain('暂不可读取告警发生时的触发器'));
  expect(root.querySelector('summary')).toBeNull();
  authFetch.mockResolvedValueOnce(Response.json(detail));
  root.querySelector('button')!.click();
  await vi.waitFor(() => expect(root.querySelector('summary')?.textContent).toBe('查看触发器'));
  expect(root.textContent).toContain('模板 tpl v4 · 触发器 rule v2');
  expect(JSON.parse(root.querySelector('pre')!.textContent!)).toEqual(rule);
  expect(root.querySelector('button')).toBeNull();
});

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

it.each([
  { source_availability: { opening: 'available', recovery: 'expired' }, opening: '原始采样来源可用', recovery: '原始采样来源已过期' },
  { source_availability: undefined, opening: '原始采样来源状态未知', recovery: '原始采样来源状态未知' },
])('shows current raw availability separately from both frozen observations %#', async ({ source_availability, opening, recovery }) => {
  const at = '2026-11-01T00:00:00Z';
  const recoveredAt = '2026-11-01T00:01:00Z';
  const rule = {
    rule_id: 'rule', version: 1, metric: { id: 'fixture.metric', semantic_version: '1.0.0' }, unit: 'count',
    problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { value: 90 } },
    recovery: { node: 'compare', select: { aggregation: 'last' }, operator: '<', threshold: { value: 70 } },
  };
  authFetch.mockResolvedValueOnce(Response.json({
    source_availability,
    episode: {
      rule_id: 'rule', state: 'closed', closed_at: recoveredAt, opened: { at, value: 95 },
      last: { at: recoveredAt, value: 60, quality: 'good' }, resource: { type: 'instance', id: '5' },
    },
    snapshot: { configuration: { rules: [rule] }, opening: { sample_ids: ['frozen-sample'], samples: [] } },
  }));
  const record = document.createElement('event-investigation-record') as any;
  record.full = true;
  record.event = { id: 7, title: '模板事件', source_type: 'template-trigger', status: 'closed', created_at: at };
  document.body.append(record);
  const root = record.shadowRoot as ShadowRoot;
  await vi.waitFor(() => expect(root.querySelectorAll('button.sample')).toHaveLength(2));
  const [trigger, recovered] = root.querySelectorAll<HTMLButtonElement>('button.sample');
  trigger.click();
  await record.updateComplete;
  const drawer = () => root.querySelector('app-dialog')!;
  expect(drawer().textContent).toContain(opening);
  expect(drawer().textContent).toContain('frozen-sample');
  recovered.click();
  await record.updateComplete;
  expect(drawer().textContent).toContain(recovery);
  expect(drawer().querySelector('.sample-value')?.textContent).toContain('60');
});

it('reports missing authorization without rendering protected frozen evidence', async () => {
  authFetch.mockResolvedValueOnce(Response.json({ error: 'TRIGGER_FORBIDDEN' }, { status: 403 }));
  const record = document.createElement('event-investigation-record') as any;
  record.event = { id: 7, title: '模板事件', source_type: 'template-trigger', status: 'closed', created_at: '2026-11-01T00:00:00Z' };
  document.body.append(record);
  const root = record.shadowRoot as ShadowRoot;
  await vi.waitFor(() => expect(root.textContent).toContain('没有此资源的查看权限'));
  [...root.querySelectorAll('nav button')].find(button => button.textContent?.startsWith('证据'))!.dispatchEvent(new MouseEvent('click'));
  await record.updateComplete;
  expect(root.querySelector('[role=status]')?.textContent).toContain('没有此资源的查看权限');
  expect(root.querySelector('button.sample')).toBeNull();
});
