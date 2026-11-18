import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #399: execute the actual CLI with every fetch replaced before loading it.
// The child retains the real process.exit so a false-green exit is observable.
const cwd = fileURLToPath(new URL("..", import.meta.url));
function run(scenario: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    let guards = 0;
    const { createHash } = await import('node:crypto');
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      const scenario = process.env.SMOKE_SCENARIO;
      if (scenario === "login-error") throw new Error("controlled offline");
      if (path === "/api/auth/login") {
        const credentials = JSON.parse(options.body);
        if (credentials.password !== process.env.SMOKE_PASS || credentials.username !== process.env.SMOKE_USER) {
          throw new Error("SMOKE_FIXTURE_CREDENTIAL_MISMATCH");
        }
        return new Response(JSON.stringify({ token: "isolated-test-token" }), { status: 200 });
      }
      if (path === "/api/users" && options.method === "POST" && options.headers.Authorization) {
        const { password } = JSON.parse(options.body);
        if (typeof password !== 'string' || password.length < 32) throw new Error('UNSAFE_CREATED_PASSWORD');
        console.log('CREATED_PASSWORD_SHA256=' + createHash('sha256').update(password).digest('hex'));
      }
      const guard = !options.headers.Authorization &&
        options.method === "POST" && ["/api/users", "/api/database/instances"].includes(path);
      let status = 200;
      if (guard) {
        guards++;
        // First two are catalog checks; last two are the separate guard phase.
        status = guards <= 2 ? 401 : Number(scenario.match(/^guard-(\\d+)$/)?.[1] || 401);
        if (guards > 2 && scenario === "guard-error") throw new Error("controlled guard offline");
      }
      if (path === "/api/health" && scenario === "business-failure") status = 503;
      if (path === "/api/health" && scenario === "request-error") throw new Error("controlled offline");
      return new Response("{}", { status });
    };
    await import("./tests/smoke-test.ts");
  `], {
    cwd, encoding: "utf8", timeout: 15000,
    // MAX-681: the real CLI requires explicit credentials even for mocked fetch.
    env: { ...process.env, SMOKE_SCENARIO: scenario, SMOKE_BASE_URL: "http://isolated.invalid",
      SMOKE_USER: "isolated-test-user", SMOKE_PASS: ["isolated", "smoke", "credential"].join("-") },
  });
}

describe("smoke CLI exit and summary (#399)", () => {
  it('MAX-681 creates a different account password in each CLI process', () => {
    const first = run('pass');
    const second = run('pass');
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const digest = (text: string) => /CREATED_PASSWORD_SHA256=([a-f0-9]{64})/.exec(text)?.[1];
    expect(digest(first.stdout)).toBeDefined();
    expect(digest(second.stdout)).toBeDefined();
    expect(digest(first.stdout)).not.toBe(digest(second.stdout));
  });
  it.each([
    ["pass", 0, 0],
    ["guard-400", 0, 0],
    ["guard-200", 1, 2],
    ["guard-403", 1, 2],
    ["guard-500", 1, 2],
    ["guard-error", 1, 2],
    ["business-failure", 1, 1],
    ["request-error", 1, 1],
  ])("%s exits %i and reports %i failures", (scenario, code, failures) => {
    const result = run(scenario);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(code);
    const routes = Number(result.stdout.match(/Routes:\s+(\d+)/)?.[1]);
    const summary = result.stdout.match(/Results: (\d+) passed, (\d+) failed \((\d+) total\)/);
    expect(summary, result.stdout).not.toBeNull();
    const total = routes + 2;
    expect(summary!.slice(1).map(Number)).toEqual([total - failures, failures, total]);
    const groups = [...result.stdout.matchAll(/\/api\/[^:]+: (\d+)\/(\d+) passed/g)];
    expect(groups.reduce((sum, group) => sum + Number(group[2]), 0)).toBe(total);
    expect(groups.reduce((sum, group) => sum + Number(group[1]), 0)).toBe(total - failures);
    if (failures) expect(result.stdout).toContain("FAILURES:");
    if (scenario === "guard-200") expect(result.stdout).toContain("UNPROTECTED");
  });

  it("exits nonzero before checking routes when login is unavailable", () => {
    const result = run("login-error");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("controlled offline");
    expect(result.stdout).not.toContain("Results:");
  });
});
