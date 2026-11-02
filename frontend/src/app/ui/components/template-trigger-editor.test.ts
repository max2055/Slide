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
    problem: { operator: ">", threshold: { name: "problem_threshold" } },
    recovery: { operator: "<", threshold: { name: "recovery_threshold" } },
    parameters: { defaults: { problem_threshold: 90, recovery_threshold: 70 } },
  });
  expect(b.method).toBeUndefined();
  expect(published.mock.calls[0][0].detail.pin.version).toBe(2);
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
