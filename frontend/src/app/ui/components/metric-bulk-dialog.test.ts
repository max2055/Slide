import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../../api/index.js", () => ({ authFetch: vi.fn() }));
import { authFetch } from "../../../api/index.js";
import { MetricBulkDialog } from "./metric-bulk-dialog.js";
import { bulkSelection } from "./metric-bulk-selection.js";
const fetchMock = vi.mocked(authFetch);
const response = (data: unknown, status = 200) =>
  ({ ok: status === 200, status, json: async () => data }) as Response;
const job = (state = "draft") => ({
  id: "test-job",
  digest: "preview-digest",
  state,
  cancel_requested: false,
  items: [
    {
      resource: { type: "instance", id: 1 },
      state: state === "draft" ? "eligible" : "pending_takeover",
      code: null,
      group: "instance · mysql 9.6",
      checks: [],
      choices: [],
      before: null,
      change: {
        expected_revision: 0,
        package: { id: "mysql-basic", version: "2.0.0", digest: "sha256:fixture" },
      },
      settings: { interval_ms: 60000 },
      coverage: ["db.uptime_seconds"],
      missing: ["db.connections"],
      cost: { before: 0, after: 60 },
      retained: ["max_rows"],
      changed: ["package"],
      revision: null,
      status: null,
    },
  ],
});
const mount = async () => {
  const el = new MetricBulkDialog();
  el.resources = [{ type: "instance", id: 1, label: "mysql-3306" }];
  document.body.append(el);
  await el.updateComplete;
  return el as any;
};
afterEach(() => {
  document.body.replaceChildren();
  fetchMock.mockReset();
  bulkSelection.clear();
  vi.useRealTimers();
});
it("matching and preview do not activate; only the explicit preview confirmation queues work", async () => {
  fetchMock.mockImplementation(async (url, init) =>
    response(
      String(url).endsWith("/bulk")
        ? { jobs: [] }
        : job(String(url).endsWith("/confirm") ? "queued" : "draft"),
    ),
  );
  const el = await mount();
  await el.start();
  await el.updateComplete;
  expect(el.step).toBe(0);
  expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/confirm"))).toBe(false);
  el.step = 1;
  await el.updateComplete;
  await el.confirm();
  const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/confirm"))!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({ digest: "preview-digest" });
  expect(el.step).toBe(2);
});
it("permission events erase previews and ignore old in-flight responses", async () => {
  let release!: (r: Response) => void;
  fetchMock.mockImplementation(async (url) =>
    String(url).endsWith("/bulk") ? response({ jobs: [] }) : new Promise((r) => (release = r)),
  );
  const el = await mount();
  const pending = el.start();
  await Promise.resolve();
  window.dispatchEvent(new Event("slide-permissions-loaded"));
  release(response(job()));
  await pending;
  expect(el.job).toBeNull();
  expect(el.error).toContain("权限");
});
it("shows partial result counts and retries only through a fresh preview requiring confirmation", async () => {
  const mixed = job("completed");
  mixed.items.push({
    ...mixed.items[0],
    resource: { type: "instance", id: 2 },
    state: "failed",
    code: "CONFIGURATION_TRIAL_FAILED",
  });
  fetchMock.mockImplementation(async (url) =>
    response(
      String(url).endsWith("/bulk") ? { jobs: [] } : String(url).endsWith("/retry") ? job() : mixed,
    ),
  );
  const el = await mount();
  el.job = mixed;
  el.step = 2;
  await el.updateComplete;
  expect(el.shadowRoot.textContent).toMatch(/失败\s+1/);
  expect(el.shadowRoot.textContent).toMatch(/待正式就绪\s+1/);
  await el.retry();
  expect(el.step).toBe(1);
  expect(el.job.state).toBe("draft");
  expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/confirm"))).toHaveLength(0);
});
it("selection spans resource types and is cleared on account/permission changes", () => {
  bulkSelection.toggle({ type: "instance", id: 1, label: "db" });
  bulkSelection.toggle({ type: "server", id: 1, label: "vm" });
  expect(bulkSelection.values()).toHaveLength(2);
  window.dispatchEvent(new Event("slide-session-expired"));
  expect(bulkSelection.values()).toHaveLength(0);
});
it("shows readable persisted field differences after reopening a preview without local form state", async () => {
  const saved: any = job();
  saved.items[0].before = {
    overrides: { interval_ms: { mode: "set", value: 60000 }, max_rows: { mode: "set", value: 7 } },
  };
  saved.items[0].before.package = saved.items[0].change.package;
  saved.items[0].change.overrides = {
    interval_ms: { mode: "set", value: 5000 },
    max_rows: { mode: "set", value: 7 },
  };
  saved.items[0].changed = ["interval_ms"];
  const el = await mount();
  el.job = saved;
  el.step = 1;
  await el.updateComplete;
  const text = el.shadowRoot.textContent;
  expect(text).toContain("覆盖字段详情");
  expect(text).toMatch(/60\s*→\s*5/);
  expect(text).toMatch(/7\s*→\s*7\s*（保留）/);
  expect(text).not.toContain('"mode"');
});
