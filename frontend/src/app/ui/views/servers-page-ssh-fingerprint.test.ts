import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
vi.mock("../components/app-toast-container.js", () => ({ showToast }));

import "./servers-page.js";

describe("servers-page optional SSH host-key fingerprint", () => {
  beforeEach(() => {
    authFetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    showToast.mockReset();
  });

  afterEach(() => document.body.replaceChildren());

  it("tests username and password credentials without sending an empty fingerprint", async () => {
    const element = document.createElement("servers-page") as any;
    element._form = {
      host: "10.0.0.8",
      port: 22,
      label: "",
      os_type: "centos",
      credential_type: "password",
      credential_username: "ops",
      credential_value: "secret",
      host_key_fingerprint: "",
    };

    await element._handleTestConnection();

    expect(authFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authFetch.mock.calls[0];
    expect(url).toBe("/api/servers/test-connection");
    expect(JSON.parse(init.body)).toEqual({
      host: "10.0.0.8",
      port: 22,
      credential_type: "password",
      credential_username: "ops",
      credential_value: "secret",
    });
    expect(showToast).toHaveBeenCalledWith("连接成功：10.0.0.8:22", "success");
  });
});
