import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./servers-page.js";
import "./server-detail.js";

describe("server workbench Phase 142 contract", () => {
  it("offers only canonical Kylin, RHEL and CentOS OS choices", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "./servers-page.ts"), "utf8");
    expect(source).toContain('value="kylin"');
    expect(source).toContain('value="rhel"');
    expect(source).toContain('value="centos"');
    expect(source).not.toMatch(/value=["']Other["']/i);
  });

  it("exposes quality, freshness and evidence columns in the inventory", () => {
    const page = document.createElement("servers-page") as any;
    const columns = page._getColumns();
    expect(columns.map((column: { key: string }) => column.key)).toEqual(
      expect.arrayContaining(["quality", "freshness"]),
    );

    const source = fs.readFileSync(path.resolve(__dirname, "./servers-page.ts"), "utf8");
    expect(source).toContain('aria-label="Environment filter"');
    expect(source).toContain('aria-label="Database relation filter"');
  });

  it("has the diagnostic evidence endpoint and expanded server tabs", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "./server-detail.ts"), "utf8");
    expect(source).toContain("/diagnostics");
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
