import { afterEach, expect, it, vi } from "vitest";
vi.mock("./app-lifecycle.ts", () => ({
  handleConnected: vi.fn(),
  handleDisconnected: vi.fn(),
  handleFirstUpdated: vi.fn(),
}));
vi.mock("./app-settings.ts", async (original) => ({ ...(await original<any>()), setTab: vi.fn() }));
import { SlideApp } from "./app.ts";
afterEach(() => history.replaceState({}, "", "/"));
it("keeps exact resource/time/list origin on contextual navigation while sidebar navigation clears it", () => {
  const app = new SlideApp();
  history.replaceState(
    {},
    "",
    "/?tab=server-detail&id=9&listReturn=token&metricResource=server:9&metricFrom=2026-10-31T00:00:00.000Z&metricTo=2026-10-31T01:00:00.000Z",
  );
  app.setTab("server-detail", true);
  expect(new URL(location.href).searchParams.get("listReturn")).toBe("token");
  expect(new URL(location.href).searchParams.get("metricFrom")).toBe("2026-10-31T00:00:00.000Z");
  app.setTab("servers");
  expect(new URL(location.href).searchParams.get("listReturn")).toBeNull();
});
