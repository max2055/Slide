import { afterEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
import "./platform-observations.js";
const snapshot = {
  schemaVersion: 1,
  generatedAt: "2026-10-15T10:00:00Z",
  releaseId: "release-MAX180",
  commitSha: "a".repeat(40),
  uptimeSeconds: 42,
  components: [
    {
      component: "api",
      quality: "good",
      gaps: [],
      groups: [{ count: 3, failures: 0, lastObservedAt: "2026-10-15T09:59:00Z" }],
    },
  ],
  logs: {
    quality: "degraded",
    groups: [],
    gaps: ["LOG_WINDOW_PRECEDES_PROCESS"],
    persistence: "process-local",
  },
};
const ok = (data: unknown = snapshot) => ({ ok: true, json: async () => data });
async function settle(view: any) {
  await new Promise((r) => setTimeout(r, 0));
  await view.updateComplete;
}
async function mount() {
  const view = document.createElement("platform-observations-page") as any;
  document.body.append(view);
  await settle(view);
  return view;
}
afterEach(() => {
  document.body.replaceChildren();
  authFetch.mockReset();
});
it("derives summary and selected evidence from the same snapshot; preserves raw version and gaps in details", async () => {
  authFetch.mockResolvedValue(ok());
  const view = await mount();
  const root = view.shadowRoot;
  expect(root.textContent).toContain("已取得信号");
  expect(root.textContent).toContain("部署一致性");
  expect(root.textContent).not.toContain("release-MAX180");
  const version = [...root.querySelectorAll("button")].find(
    (b: any) => b.textContent?.trim() === "查看缺口",
  ) as HTMLButtonElement;
  version.click();
  await settle(view);
  expect(root.querySelector("pre").textContent).toContain("release-MAX180");
  expect(root.querySelector("pre").textContent).toContain("a".repeat(40));
  expect(authFetch).toHaveBeenCalledTimes(1);
});
it("does not fill absent uptime or timestamps with zero or now", async () => {
  authFetch.mockResolvedValue(ok({ schemaVersion: 1 }));
  const view = await mount();
  const text = view.shadowRoot.textContent;
  expect(text).toContain("时长未知");
  expect(text).toContain("接口未提供组件覆盖数据");
  expect(text).not.toContain("运行 0 秒");
  expect(view.shadowRoot.querySelector("tbody").textContent).not.toContain("无异常");
});
it.each([
  { quality: "unknown", gaps: ["LOG_EVIDENCE_MISSING"], groups: [], label: "无信号" },
  { quality: "unknown", gaps: ["LOG_EVIDENCE_STALE"], groups: [{ count: 1 }], label: "已过期" },
  { quality: "degraded", gaps: ["LOG_STATUS_UNKNOWN"], groups: [{ count: 1 }], label: "部分证据" },
  { quality: "good", gaps: [], groups: [{ failures: 2 }], label: "有失败信号" },
])("keeps evidence state $label explicit", async (state) => {
  authFetch.mockResolvedValue(ok({ ...snapshot, components: [{ component: "api", ...state }] }));
  const view = await mount();
  expect(view.shadowRoot.querySelector("tbody").textContent).toContain(state.label);
});
it("refresh failure clears a prior healthy-looking snapshot and open details", async () => {
  authFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce({ ok: false, status: 503 });
  const view = await mount();
  view.shadowRoot.querySelector("button").click();
  await settle(view);
  expect(view.shadowRoot.textContent).toContain("HTTP 503");
  expect(view.shadowRoot.querySelector("tbody")).toBeNull();
  expect(view.shadowRoot.querySelector("app-dialog")).toBeNull();
});
it.each(["slide-permissions-loaded", "slide-session-expired"])(
  "clears evidence and ignores in-flight responses on %s",
  async (event) => {
    let resolve!: (v: unknown) => void;
    authFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = await mount();
    window.dispatchEvent(new CustomEvent(event, { detail: { permissions: [] } }));
    resolve(ok());
    await settle(view);
    expect(view.shadowRoot.querySelector("tbody")).toBeNull();
    expect(view.shadowRoot.textContent).toContain("证据已清理");
  },
);
it.each([401, 403])("does not display error JSON as evidence (%s)", async (status) => {
  authFetch.mockResolvedValue({ ok: false, status, json: async () => snapshot });
  const view = await mount();
  expect(view.shadowRoot.textContent).toContain("无权读取");
  expect(view.shadowRoot.querySelector("tbody")).toBeNull();
});
it("rejects malformed responses", async () => {
  authFetch.mockResolvedValue(ok([]));
  const view = await mount();
  expect(view.shadowRoot.textContent).toContain("响应不完整");
});
