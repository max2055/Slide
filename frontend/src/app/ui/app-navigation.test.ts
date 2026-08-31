import { describe, expect, it } from "vitest";
import { buildNavigationUrl } from "./app-navigation.ts";

describe("navigation URL context", () => {
  it("keeps the instance id when opening an instance detail", () => {
    const url = buildNavigationUrl("http://localhost/?tab=instances-db", "instance-detail", { id: 41 });
    expect(url.searchParams.get("tab")).toBe("instance-detail");
    expect(url.searchParams.get("id")).toBe("41");
  });

  it("clears a stale instance id for unrelated views", () => {
    const url = buildNavigationUrl("http://localhost/?tab=instance-detail&id=41", "alerts");
    expect(url.searchParams.get("id")).toBeNull();
  });

  it("keeps server and network device context independent", () => {
    const serverUrl = buildNavigationUrl("http://localhost/", "server-detail", { id: 7 });
    expect(serverUrl.searchParams.get("id")).toBe("7");
    expect(serverUrl.searchParams.get("networkDeviceId")).toBeNull();

    const deviceUrl = buildNavigationUrl("http://localhost/", "network-device-detail", { id: 9 });
    expect(deviceUrl.searchParams.get("networkDeviceId")).toBe("9");
    expect(deviceUrl.searchParams.get("id")).toBeNull();
  });
});
