import { afterEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
import "./template-trigger-editor.js";
const settle = () => new Promise((r) => setTimeout(r, 20));
afterEach(() => {
  document.body.replaceChildren();
  authFetch.mockReset();
});
it("loads fixed versions and publishes an actual structured body to the metric API", async () => {
  authFetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [] }) })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        template_id: "tpl",
        version: 2,
        content_hash: "sha256:" + "b".repeat(64),
      }),
    });
  const e = document.createElement("template-trigger-editor") as any;
  e.template = {
    template_id: "tpl",
    version: 1,
    content_hash: "sha256:" + "a".repeat(64),
    items: [{ item_id: "item", display_name: "测试指标", unit: "count" }],
  };
  document.body.append(e);
  await settle();
  expect(authFetch.mock.calls[0][0]).toBe("/api/metrics/templates/tpl/versions/1/triggers");
  const fieldsets = e.shadowRoot.querySelectorAll("fieldset");
  expect(e.shadowRoot.querySelector('input[type="checkbox"]').checked).toBe(false);
  expect([...fieldsets[0].querySelectorAll("select")].map(select => select.value)).toEqual(["compare", "last", ">"]);
  expect([...fieldsets[1].querySelectorAll("select")].map(select => select.value)).toEqual(["compare", "last", "<"]);
  const published = vi.fn();
  e.addEventListener("trigger-published", published);
  e.shadowRoot.querySelector("button.btn-primary").click();
  await settle();
  const [url, init] = authFetch.mock.calls[1];
  expect(url).toBe("/api/metrics/templates/tpl/triggers");
  const b = JSON.parse(init.body);
  expect(b).toMatchObject({
    expected_version: 1,
    item_id: "item",
    recovery_mode: "recovery_expression",
    problem: { operator: ">", threshold: { name: "problem_threshold" } },
    recovery: { operator: "<", threshold: { name: "recovery_threshold" } },
    parameters: { defaults: { problem_threshold: 90, recovery_threshold: 70 } },
  });
  expect(b.method).toBeUndefined();
  expect(b).not.toHaveProperty('allow_manual_close');
  expect(published.mock.calls[0][0].detail.pin.version).toBe(2);
});
it.each(['problem_expression', 'none'])('publishes %s with no recovery expression', async (mode) => {
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ template_id: 'tpl', version: 2 }) });
  const editor = document.createElement('template-trigger-editor') as any;
  editor.template = { template_id: 'tpl', version: 1, items: [{ item_id: 'a', display_name: '当前连接', unit: 'count' }] };
  document.body.append(editor);
  await settle();
  const root = editor.shadowRoot;
  const select = root.querySelector('select[aria-label="恢复方式"]');
  select.value = mode;
  select.dispatchEvent(new Event('change'));
  await editor.updateComplete;
  expect(root.querySelector('select[aria-label="recovery组合"]')).toBeNull();
  root.querySelector('button.btn-primary').click();
  await settle();
  const body = JSON.parse(authFetch.mock.calls[1][1].body);
  expect(body.recovery_mode).toBe(mode);
  expect(body).not.toHaveProperty('recovery');
});

it('reopens a no-OK rule and can publish an independent constant without new parameters', async () => {
  const rule = { scope: 'item:a', recovery_mode: 'none', parameters: { schema: {}, defaults: {} },
    problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { kind: 'constant', value: 50 } },
    quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
    clock: { stale_after_ms: 120000, nodata: { enabled: false } } };
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [rule] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ template_id: 'tpl', version: 2 }) });
  const editor = document.createElement('template-trigger-editor') as any;
  editor.template = { template_id: 'tpl', version: 1, items: [{ item_id: 'a', display_name: '当前连接', unit: 'count' }] };
  document.body.append(editor);
  await settle();
  const root = editor.shadowRoot;
  const select = root.querySelector('select[aria-label="恢复方式"]');
  expect(select.value).toBe('none');
  expect(root.textContent).toContain('事件仍保持打开');
  select.value = 'recovery_expression';
  select.dispatchEvent(new Event('change'));
  await editor.updateComplete;
  expect(root.querySelector('select[aria-label="recovery组合"]')).not.toBeNull();
  const allowClose = root.querySelector('input[type="checkbox"]');
  allowClose.checked = true;
  allowClose.dispatchEvent(new Event('change'));
  root.querySelector('button.btn-primary').click();
  await settle();
  expect(JSON.parse(authFetch.mock.calls[1][1].body)).toMatchObject({
    recovery_mode: 'recovery_expression', parameters: { schema: {}, defaults: {} },
    allow_manual_close: true,
    recovery: { threshold: { kind: 'constant', value: 70 } },
  });
});
it('offers the upstream filesystem defaults for the selected severity', async () => {
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ template_id: 'tpl', version: 2 }) });
  const editor = document.createElement('template-trigger-editor') as any;
  editor.template = { template_id: 'tpl', version: 1, items: [{ item_id: 'used', display_name: '使用率', unit: '%',
    canonical_metric: { id: 'linux.filesystem.discovered_used_percent' } }] };
  document.body.append(editor);
  await settle();
  const select = editor.shadowRoot.querySelector('select:has(option[value="critical"])');
  select.value = 'critical';
  select.dispatchEvent(new Event('change'));
  await settle();
  editor.shadowRoot.querySelector('button.btn-primary').click();
  await settle();
  expect(JSON.parse(authFetch.mock.calls[1][1].body)).toMatchObject({ severity: 'critical', item_id: 'used',
    parameters: { defaults: { problem_threshold: 90, recovery_threshold: 90 } },
    problem: { operator: '>', select: { aggregation: 'min', window_ms: 300000 } },
    recovery: { operator: '<=', select: { aggregation: 'min', window_ms: 300000 } },
  });
});

it('retains a secondary item when reopening a group and switching its aggregation', async () => {
  const compare = (item_id?: string) => ({
    node: 'compare', select: { aggregation: 'last', ...(item_id ? { item_id } : {}) },
    operator: '>', threshold: { kind: 'constant', value: 50 },
  });
  const rule = { scope: 'item:a', parameters: { schema: {}, defaults: {} },
    problem: { node: 'all', children: [compare(), compare('b')] }, recovery: compare('b'),
    quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
    clock: { stale_after_ms: 120000, nodata: { enabled: false } } };
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [rule] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ template_id: 'tpl', version: 2 }) });
  const editor = document.createElement('template-trigger-editor') as any;
  editor.template = { template_id: 'tpl', version: 1, items: [
    { item_id: 'a', display_name: '当前连接', unit: 'count', dimensions: {} },
    { item_id: 'b', display_name: '连接上限', unit: 'count', dimensions: {} },
  ] };
  document.body.append(editor);
  await settle();
  const leaves = [...editor.shadowRoot.querySelectorAll('label')].filter((label: any) => label.textContent.trim().startsWith('条件监控项'));
  expect(editor.shadowRoot.querySelector('select[aria-label="恢复方式"]').value).toBe('recovery_expression');
  expect(leaves.map((label: any) => label.querySelector('select').value)).toEqual(['', 'b', 'b']);
  const field = leaves[1].closest('fieldset').querySelector('select:has(option[value="avg"])');
  field.value = 'avg'; field.dispatchEvent(new Event('change'));
  await settle();
  editor.shadowRoot.querySelector('button.btn-primary').click();
  await settle();
  expect(JSON.parse(authFetch.mock.calls[1][1].body)).toMatchObject({ problem: { children: [
    { select: { aggregation: 'last' } }, { select: { aggregation: 'avg', window_ms: 60000, item_id: 'b' } },
  ] }, recovery: { select: { aggregation: 'last', item_id: 'b' } } });
});

it('assigns a separate threshold when converting a parameter-backed condition to a group', async () => {
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ template_id: 'tpl', version: 2 }) });
  const editor = document.createElement('template-trigger-editor') as any;
  editor.template = { template_id: 'tpl', version: 1, items: [
    { item_id: 'a', display_name: '当前连接', unit: 'count', dimensions: {} },
    { item_id: 'b', display_name: '连接上限', unit: 'count', dimensions: {} },
  ] };
  document.body.append(editor);
  await settle();
  const mode = editor.shadowRoot.querySelector('select[aria-label="problem组合"]');
  mode.value = 'all'; mode.dispatchEvent(new Event('change'));
  await settle();
  const problem = mode.closest('fieldset');
  const other = problem.querySelectorAll('select[aria-label="条件监控项"]')[1];
  other.value = 'b'; other.dispatchEvent(new Event('change'));
  await settle();
  const threshold = problem.querySelectorAll('input[type="number"]')[1];
  threshold.value = '45'; threshold.dispatchEvent(new Event('change'));
  await settle();
  editor.shadowRoot.querySelector('button.btn-primary').click();
  await settle();
  expect(JSON.parse(authFetch.mock.calls[1][1].body)).toMatchObject({
    parameters: { defaults: { problem_threshold: 90 } },
    problem: { node: 'all', children: [
      { threshold: { kind: 'parameter', name: 'problem_threshold' } },
      { select: { item_id: 'b' }, threshold: { kind: 'constant', value: 45 } },
    ] },
  });
});
it("keeps compound semantics when reopened and cannot silently collapse to the first child", async () => {
  const compare = (v: number) => ({
    node: "compare",
    select: { aggregation: "last" },
    operator: ">",
    threshold: { kind: "constant", value: v },
  });
  authFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      rules: [
        {
          scope: "item:item",
          parameters: { schema: {}, defaults: {} },
          problem: { node: "all", children: [compare(90), compare(95)] },
          recovery: compare(70),
          quality: { accepted_quality: ["good"], min_coverage: 1, allow_estimated: false },
          clock: { stale_after_ms: 120000, nodata: { enabled: false } },
        },
      ],
    }),
  });
  const e = document.createElement("template-trigger-editor") as any;
  e.template = {
    template_id: "tpl",
    version: 2,
    items: [{ item_id: "item", display_name: "test", unit: "count" }],
  };
  document.body.append(e);
  await settle();
  expect(
    e.shadowRoot.querySelector('select[aria-label="problem组合"] option[value="compare"]').disabled,
  ).toBe(true);
  expect(e.shadowRoot.querySelectorAll("fieldset fieldset").length).toBe(2);
});

it("changes AND/OR without dropping nested windows, parameters, recovery or nodata on publish", async () => {
  const leaf = (aggregation: string, value: number) => ({
    node: "compare", select: { aggregation, ...(aggregation === "last" ? {} : { window_ms: 30000 }) },
    operator: ">", threshold: { kind: "constant", value },
  });
  const rule = {
    scope: "item:item", parameters: { schema: {}, defaults: {} },
    problem: { node: "all", children: [leaf("min", 90), { node: "any", children: [leaf("max", 95), leaf("avg", 92)] }] },
    recovery: { ...leaf("last", 70), operator: "<" },
    quality: { accepted_quality: ["good"], min_coverage: 1, allow_estimated: false },
    clock: { stale_after_ms: 120000, nodata: { enabled: true, after_ms: 300000 } },
  };
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rules: [rule] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ template_id: "tpl", version: 3 }) });
  const e = document.createElement("template-trigger-editor") as any;
  e.template = { template_id: "tpl", version: 2, content_hash: "sha256:" + "a".repeat(64), items: [{ item_id: "item", display_name: "test", unit: "count" }] };
  document.body.append(e);
  await settle();
  const aggregations = [...e.shadowRoot.querySelectorAll('select:has(option[value="avg"])')];
  expect(aggregations.map(select => select.value)).toEqual(["min", "max", "avg", "last"]);
  const mode = e.shadowRoot.querySelector('select[aria-label="problem组合"]');
  mode.value = "any";
  mode.dispatchEvent(new Event("change"));
  await settle();
  mode.value = "all";
  mode.dispatchEvent(new Event("change"));
  await settle();
  e.shadowRoot.querySelector("button.btn-primary").click();
  await settle();
  const body = JSON.parse(authFetch.mock.calls[1][1].body);
  for (const key of ["problem", "recovery", "parameters", "quality", "clock"])
    expect(body[key]).toEqual(rule[key as keyof typeof rule]);
});
