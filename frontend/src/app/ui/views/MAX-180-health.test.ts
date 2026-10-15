import { afterEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
import "./health-center.js";
const sample = {
  timestamp: "2026-10-15T00:00:00Z",
  summary: { pass: 1, warn: 0, fail: 0, deferred: 0, total: 1 },
  checks: [],
  readiness: { db_connected: true },
};
async function settle(view: any) {
  await new Promise((r) => setTimeout(r, 0));
  await view.updateComplete;
}
async function mount() {
  const view = document.createElement("health-center-page") as any;
  document.body.append(view);
  await settle(view);
  return view;
}
afterEach(() => {
  document.body.replaceChildren();
  authFetch.mockReset();
});
it.each([
  { pass: 0, warn: 0, fail: 0, deferred: 0, total: 0 },
  { pass: 0, warn: 0, fail: 0, deferred: 3, total: 3 },
])("does not show 100 percent when no actionable checks exist", async (summary) => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ ...sample, summary }) });
  const view = await mount();
  expect(view.shadowRoot.textContent).toContain("尚无有效检查");
  expect(view.shadowRoot.querySelector(".hs-pct").textContent).not.toContain("100%");
});
it("clears old summary and exposes refresh failure", async () => {
  authFetch
    .mockResolvedValueOnce({ ok: true, json: async () => sample })
    .mockResolvedValueOnce({ ok: false, status: 503 });
  const view = await mount();
  view.shadowRoot.querySelector(".refresh-btn").click();
  await settle(view);
  expect(view.shadowRoot.textContent).toContain("503");
  expect(view.shadowRoot.querySelector(".health-bar")).toBeNull();
});
it("does not treat missing readiness as false or missing truth as healthy", async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ checks: [] }) });
  const view = await mount();
  expect(view.shadowRoot.textContent).toContain("未知");
  expect(view.shadowRoot.querySelectorAll(".ri-item .dot.fail")).toHaveLength(0);
});
it.each(["slide-permissions-loaded", "slide-session-expired"])(
  "does not restore in-flight health evidence after %s",
  async (event) => {
    let resolve!: (v: unknown) => void;
    authFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = await mount();
    window.dispatchEvent(new CustomEvent(event, { detail: { permissions: [] } }));
    resolve({ ok: true, json: async () => sample });
    await settle(view);
    expect(view.shadowRoot.querySelector(".health-bar")).toBeNull();
    expect(view.shadowRoot.textContent).toContain("已清理");
  },
);
