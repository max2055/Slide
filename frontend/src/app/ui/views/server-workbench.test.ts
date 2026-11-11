import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../api/index.js", () => ({
  authFetch: vi.fn(async (url: string) => ({
    ok: true, json: async () => url === "/api/servers" ? [] : { credential_username: "ops" },
  })),
}));
import "./servers-page.js";
import "./server-detail.js";

describe("server workbench Phase 142 contract", () => {
  // MAX-380: legacy/empty values are preservation choices on edit, never new OS types.
  it("offers only canonical Kylin, RHEL and CentOS OS choices on create", async () => {
    const page = document.createElement("servers-page") as any;
    document.body.append(page);
    try {
      page._openAddDialog();
      await page.updateComplete;
      const field = [...page.shadowRoot.querySelectorAll("app-form-field")].find(
        (field: any) => field.label === "操作系统",
      ) as HTMLElement;
      const select = field.querySelector("select")!;
      expect([...select.options].map((option) => option.value)).toEqual(["kylin", "rhel", "centos"]);
      expect(select.value).toBe("centos");
    } finally {
      page.remove();
    }
  });

  it.each(["debian", ""])("retains original OS %j only while editing and permits supported choices", async (original) => {
    const page = document.createElement("servers-page") as any;
    document.body.append(page);
    try {
      await page._openEditDialog({
        id: 7, host: "192.0.2.80", port: 22, label: "原标签",
        os_type: original, credential_type: "password",
      });
      await page.updateComplete;
      const select = () => ([...page.shadowRoot.querySelectorAll("app-form-field")].find(
        (field: any) => field.label === "操作系统",
      ) as HTMLElement).querySelector("select")!;
      expect([...select().options].map((option) => option.value)).toEqual([original, "kylin", "rhel", "centos"]);
      expect(select().value).toBe(original);
      for (const supported of ["kylin", "rhel", "centos"]) {
        select().value = supported;
        select().dispatchEvent(new Event("change"));
        await page.updateComplete;
        expect(select().value).toBe(supported);
        expect([...select().options].map((option) => option.value)).toEqual([original, "kylin", "rhel", "centos"]);
      }
      select().value = original;
      select().dispatchEvent(new Event("change"));
      await page.updateComplete;
      expect(select().value).toBe(original);
      page._openAddDialog();
      await page.updateComplete;
      expect([...select().options].map((option) => option.value)).toEqual(["kylin", "rhel", "centos"]);
    } finally {
      page.remove();
    }
  });

  it("keeps identity, address, OS version and observation health independent in the inventory", () => {
    const page = document.createElement("servers-page") as any;
    const columns = page._getColumns();
    expect(columns.map((column: { key: string }) => column.key)).toEqual(
      expect.arrayContaining(["host", "address", "version", "health"]),
    );

    const source = fs.readFileSync(path.resolve(__dirname, "./servers-page.ts"), "utf8");
    expect(source).toContain('aria-label="Environment filter"');
    expect(source).toContain('aria-label="Database relation filter"');
  });

  it("keeps explicit diagnostic collection and expanded server tabs without implicit GET collection", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "./server-detail.ts"), "utf8");
    expect(source).not.toContain("/diagnostics`");
    expect(source).toContain("/collect-diagnostics");
    for (const label of ["网络", "进程", "服务", "日志", "关联资源"]) {
      expect(source).toContain(label);
    }
  });

  it("keeps alert navigation in the event center instead of the server detail view", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "./server-detail.ts"), "utf8");
    expect(source).not.toContain("_viewAlerts");
    expect(source).not.toMatch(/\{ key: ["']alerts["'], label: ["']告警["'] \}/);
    expect(source).not.toContain("查看告警");
  });

  it("exposes the same four row actions as database and network inventories", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "./servers-page.ts"), "utf8");
    expect(source).toContain("_testServer");
    expect(source).toMatch(/_navigateToDetail\(srv\.id\)[\s\S]*>详情/);
    expect(source).toMatch(/_openEditDialog\(srv\)[\s\S]*>编辑/);
    expect(source).toMatch(/_testServer\(srv\)[\s\S]*>\$\{this\._testingServerId/);
    expect(source).toMatch(/_confirmDelete\(srv\)[\s\S]*>删除/);
  });
});
