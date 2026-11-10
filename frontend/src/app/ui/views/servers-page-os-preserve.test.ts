import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ authFetch }));
vi.mock("../components/app-toast-container.js", () => ({ showToast }));

import "./servers-page.js";

function server(osType: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    host: "192.0.2.80",
    port: 22,
    label: "原标签",
    os_type: osType,
    credential_type: "password",
    status: "offline",
    last_check_at: null,
    collection_enabled: false,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
    host_key_fingerprint: "",
    ...overrides,
  };
}

function osSelect(element: HTMLElement): HTMLSelectElement {
  const field = [...element.shadowRoot!.querySelectorAll("app-form-field")].find((candidate) =>
    (candidate as { label?: string }).label === "操作系统",
  );
  const select = field?.querySelector("select");
  if (!select) throw new Error("操作系统下拉框不存在");
  return select;
}

function putBodies(): Array<Record<string, unknown>> {
  return authFetch.mock.calls
    .filter((call) => call[1]?.method === "PUT")
    .map((call) => JSON.parse(call[1].body) as Record<string, unknown>);
}

async function mount(list: ReturnType<typeof server>[] = []) {
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/servers") return { ok: true, status: 200, json: async () => list };
    if (String(url).startsWith("/api/servers/")) return { ok: true, status: 200, json: async () => ({ credential_username: "ops" }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const element = document.createElement("servers-page") as any;
  document.body.append(element);
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
  return element;
}

async function openEdit(element: any, row: ReturnType<typeof server>) {
  await element._openEditDialog(row);
  await element.updateComplete;
}

async function setLabel(element: HTMLElement, value: string) {
  const input = [...element.shadowRoot!.querySelectorAll("input")].find((candidate) =>
    candidate.getAttribute("placeholder") === "例如：生产环境主服务器",
  ) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await (element as any).updateComplete;
}

async function setHost(element: HTMLElement, value: string) {
  const input = [...element.shadowRoot!.querySelectorAll("input")].find((candidate) =>
    candidate.getAttribute("placeholder") === "192.168.1.100",
  ) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await (element as any).updateComplete;
}

describe("servers-page preserves an unchanged operating system", () => {
  beforeEach(() => {
    authFetch.mockReset();
    showToast.mockReset();
    localStorage.setItem("permissions", JSON.stringify(["servers:view", "servers:manage"]));
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem("permissions");
  });

  it("shows an unknown operating system instead of CentOS", async () => {
    const element = await mount();
    await openEdit(element, server("Ubuntu 22.04"));
    const select = osSelect(element);
    expect(select.value).toBe("Ubuntu 22.04");
    expect(select.selectedOptions[0]?.textContent).toBe("Ubuntu 22.04");
    expect([...select.options].map((option) => option.value)).toEqual([
      "Ubuntu 22.04", "kylin", "rhel", "centos",
    ]);
    expect(select.labels?.[0]?.textContent).toBe("操作系统");
  });

  it("shows an empty operating system as unknown and does not select CentOS", async () => {
    const element = await mount();
    await openEdit(element, server(""));
    const select = osSelect(element);
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.textContent).toBe("未知");
    expect(select.value).not.toBe("centos");
  });

  it("keeps kylin, rhel, and centos on their existing options", async () => {
    const element = await mount();
    for (const osType of ["kylin", "rhel", "centos"] as const) {
      await openEdit(element, server(osType, { id: osType.length }));
      expect(osSelect(element).value).toBe(osType);
      expect([...osSelect(element).options].map((option) => option.value)).toEqual(["kylin", "rhel", "centos"]);
    }
  });

  it("shows a recognized non-canonical label on its family without staging centos", async () => {
    const element = await mount();
    await openEdit(element, server("CentOS Linux 7"));
    expect(osSelect(element).value).toBe("centos");
    expect(element._osTouched).toBe(false);
  });

  it("omits os_type when saving only a label or address", async () => {
    const element = await mount();
    await openEdit(element, server("debian"));
    await setLabel(element, "只改标签");
    await element._handleSubmit();
    await openEdit(element, server("debian"));
    await setHost(element, "192.0.2.81");
    await element._handleSubmit();
    const bodies = putBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ label: "只改标签", host: "192.0.2.80" });
    expect(bodies[0]).not.toHaveProperty("os_type");
    expect(bodies[1]).toMatchObject({ host: "192.0.2.81", label: "原标签" });
    expect(bodies[1]).not.toHaveProperty("os_type");
    expect(JSON.stringify(bodies)).not.toContain("centos");
  });

  it("omits the original value for kylin, rhel, centos, and versioned labels", async () => {
    const element = await mount();
    for (const osType of ["kylin", "rhel", "centos", "RHEL 8", ""]) {
      authFetch.mockClear();
      await openEdit(element, server(osType));
      await setLabel(element, `标签-${osType || "empty"}`);
      await element._handleSubmit();
      expect(putBodies()[0]).not.toHaveProperty("os_type");
    }
  });

  it("sends an explicit supported operating system and still creates with centos", async () => {
    const element = await mount();
    await openEdit(element, server("debian"));
    const select = osSelect(element);
    select.value = "kylin";
    select.dispatchEvent(new Event("change"));
    await element.updateComplete;
    await element._handleSubmit();
    expect(putBodies()[0]).toMatchObject({ os_type: "kylin" });

    authFetch.mockClear();
    await openEdit(element, server("rhel"));
    const known = osSelect(element);
    known.value = "centos";
    known.dispatchEvent(new Event("change"));
    await element.updateComplete;
    await element._handleSubmit();
    expect(putBodies()[0]).toMatchObject({ os_type: "centos" });

    authFetch.mockClear();
    element._openAddDialog();
    await element.updateComplete;
    expect(osSelect(element).value).toBe("centos");
    element._form = { ...element._form, host: "192.0.2.90", credential_username: "ops", credential_value: "secret" };
    await element._handleSubmit();
    const post = authFetch.mock.calls.find((call) => call[1]?.method === "POST");
    expect(JSON.parse(post[1].body)).toMatchObject({ os_type: "centos", host: "192.0.2.90" });
  });

  it("does not submit an unsupported value even if the control is touched and returned", async () => {
    const element = await mount();
    await openEdit(element, server("debian"));
    const select = osSelect(element);
    select.value = "rhel";
    select.dispatchEvent(new Event("change"));
    select.value = "debian";
    select.dispatchEvent(new Event("change"));
    await element.updateComplete;
    await setLabel(element, "回到原系统");
    await element._handleSubmit();
    expect(putBodies()[0]).not.toHaveProperty("os_type");
    expect(putBodies()[0]).toMatchObject({ label: "回到原系统" });
  });

  it("keeps the original request shape after a failed save is retried", async () => {
    let puts = 0;
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) return { ok: false, status: 503, json: async () => ({ error: "暂时失败" }) };
        return { ok: true, status: 200, json: async () => ({ message: "更新成功" }) };
      }
      if (url === "/api/servers/7") return { ok: true, status: 200, json: async () => ({ credential_username: "ops" }) };
      return { ok: true, status: 200, json: async () => [] };
    });
    const element = document.createElement("servers-page") as any;
    document.body.append(element);
    await element.updateComplete;
    await openEdit(element, server("alpine"));
    await setLabel(element, "失败后重试");
    await element._handleSubmit();
    expect(showToast).toHaveBeenCalledWith("保存失败: 暂时失败", "error");
    expect(element._showDialog).toBe(true);
    expect(osSelect(element).value).toBe("alpine");
    await element._handleSubmit();
    const bodies = putBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("os_type");
    expect(bodies[1]).not.toHaveProperty("os_type");
    expect(bodies[1]).toMatchObject({ label: "失败后重试" });
  });

  it("does not send an update when the editor is cancelled", async () => {
    const element = await mount([server("debian")]);
    element._servers = [server("debian")];
    element._loading = false;
    await element.requestUpdate();
    await element.updateComplete;
    await openEdit(element, server("debian"));
    const cancel = [...element.shadowRoot.querySelectorAll("button")].find((button) => button.textContent?.trim() === "取消");
    cancel.click();
    await element.updateComplete;
    expect(putBodies()).toEqual([]);
    expect(element._showDialog).toBe(false);
  });

  it("does not enable editing without the manage permission", async () => {
    localStorage.setItem("permissions", JSON.stringify(["servers:view"]));
    const element = await mount([server("debian")]);
    element._servers = [server("debian")];
    element._loading = false;
    await element.requestUpdate();
    await element.updateComplete;
    const table = element.shadowRoot.querySelector("resource-metrics-table");
    await table.updateComplete;
    const edit = table.shadowRoot.querySelector("[data-resource-edit-id]") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("需要服务器管理权限");
  });
});
