import { afterEach, expect, it, vi } from "vitest";
import { authFetch } from "../../../api/index.ts";
import { LegacyAnalysisLink } from "./legacy-analysis-link.ts";
vi.mock("../../../api/index.ts", () => ({ authFetch: vi.fn() }));
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
async function mount(status = "completed") {
  const element = new LegacyAnalysisLink();
  element.analysisId = 7;
  element.status = status;
  document.body.append(element);
  await element.updateComplete;
  return element;
}
it("viewing the control does not request a link; active results cannot link", async () => {
  const element = await mount("running");
  expect(element.shadowRoot?.querySelector("button")).toBeNull();
  expect(authFetch).not.toHaveBeenCalled();
});
it("explicit historical link navigates to the accepted canonical id", async () => {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ id: "accepted-id" })));
  const navigate = vi.fn();
  window.addEventListener("slide-navigate", navigate, { once: true });
  const element = await mount();
  element.shadowRoot!.querySelector("button")!.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(authFetch).toHaveBeenCalledWith("/api/ai/analysis/7/investigation", { method: "POST" });
  expect(navigate.mock.calls[0][0].detail).toEqual({
    tab: "investigations",
    investigationId: "accepted-id",
  });
});
it.each(["removed", "revoked"])("late link cannot navigate after %s", async (mode) => {
  let resolve!: (value: Response) => void;
  vi.mocked(authFetch).mockReturnValue(new Promise((r) => (resolve = r)));
  const navigate = vi.fn();
  window.addEventListener("slide-navigate", navigate);
  const element = await mount();
  element.shadowRoot!.querySelector("button")!.click();
  if (mode === "removed") element.remove();
  else
    window.dispatchEvent(
      new CustomEvent("slide-permissions-loaded", { detail: { permissions: [] } }),
    );
  resolve(new Response(JSON.stringify({ id: "late-id" })));
  await new Promise((r) => setTimeout(r, 0));
  expect(navigate).not.toHaveBeenCalled();
  window.removeEventListener("slide-navigate", navigate);
});
