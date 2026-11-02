import { beforeEach, expect, it } from "vitest";
import {
  detailWindow,
  resourceContextUrl,
  detailTabKeydown,
  saveListReturn,
  restoredListState,
} from "./resource-detail-context.js";
beforeEach(() => {
  sessionStorage.clear();
  history.replaceState({}, "", "/?tab=servers");
});
it("uses exact existing window and resource while removing stale other-resource context", () => {
  history.replaceState(
    {},
    "",
    "/?tab=server-detail&id=9&metricResource=server:9&metricFrom=2026-10-31T00:00:00.000Z&metricTo=2026-10-31T01:00:00.000Z",
  );
  const range = detailWindow("server", 9);
  const url = new URL(resourceContextUrl("server", 9, "events", range), location.origin);
  expect(url.searchParams.get("resource")).toBe("server:9");
  expect(url.searchParams.get("from")).toBe(range.from);
  expect(url.searchParams.get("to")).toBe(range.to);
  expect(url.searchParams.has("id")).toBe(false);
});
it("restores only the matching list token and rejects external return paths", () => {
  const token = saveListReturn(
    "server",
    9,
    { search: "long host", os: "linux" },
    { page: 3, left: 180, top: 25 },
  );
  history.replaceState({}, "", "/?tab=servers&restoreList=" + token);
  expect(restoredListState("server")?.state).toEqual({ search: "long host", os: "linux" });
  expect(restoredListState("instance")).toBeNull();
  history.replaceState({}, "", "/?tab=servers&restoreList=https://evil.test");
  expect(restoredListState("server")).toBeNull();
});
it("roves tab focus and invokes the real click handler", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<button role="tab" aria-selected="true">概览</button><button role="tab">监控配置</button>';
  document.body.append(root);
  let selected = false;
  root.children[1].addEventListener("click", () => (selected = true));
  const e = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  root.addEventListener("keydown", detailTabKeydown);
  root.children[0].dispatchEvent(e);
  expect(selected).toBe(true);
  expect(document.activeElement).toBe(root.children[1]);
  root.remove();
});
