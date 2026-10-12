import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSends, reserveSend, stopSends } from "./real-provider-budget.js";

const directories: string[] = [];
const journal = () => {
  const directory = mkdtempSync(join(tmpdir(), "t04-send-budget-"));
  directories.push(directory);
  const path = join(directory, "sends.jsonl");
  writeFileSync(path, "", { flag: "wx" });
  return path;
};
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true });
});
describe("finite real-provider qualification budget", () => {
  it("provider failure blocks later processes without resetting the consumed request", () => {
    const path = journal();
    reserveSend(path, "normal", 3);
    stopSends(path, "PROVIDER_HTTP_402");
    expect(() => reserveSend(path, "normal", 3)).toThrow("T04_PROVIDER_DIAGNOSIS_REQUIRED");
    expect(readSends(path)).toHaveLength(1);
  });
  it("racing processes never exceed six durable attempts, including exit before I/O", async () => {
    const path = journal();
    const run = () =>
      new Promise<number | null>((resolve, reject) => {
        const worker = fork(new URL("./real-provider-budget.ts", import.meta.url), [], {
          execArgv: [
            "--import",
            import.meta.resolve("tsx"),
            "--eval",
            `import { reserveSend } from ${JSON.stringify(new URL("./real-provider-budget.ts", import.meta.url).href)}; try { reserveSend(process.env.TEST_SEND_JOURNAL, 'race', 6); process.exit(0); } catch { process.exit(1); }`,
          ],
          env: { ...process.env, TEST_SEND_JOURNAL: path },
          silent: true,
        });
        worker.once("error", reject);
        worker.once("exit", resolve);
      });
    // Both parallel races and fresh processes after successful reservations.
    const outcomes = await Promise.all(Array.from({ length: 12 }, run));
    const reserved = outcomes.filter((code) => code === 0).length;
    expect(reserved).toBeGreaterThan(0);
    expect(reserved).toBeLessThanOrEqual(6);
    expect(readSends(path)).toHaveLength(reserved);
    while (readSends(path).length < 6) reserveSend(path, "race", 6);
    expect(await run()).toBe(1);
    expect(readSends(path)).toHaveLength(6);
  }, 30000);
  it("missing/corrupt history and abandoned lock fail closed without replenishing quota", () => {
    const path = journal();
    reserveSend(path, "normal", 1);
    expect(() => reserveSend(path, "normal", 1)).toThrow("T04_REAL_REQUEST_LIMIT");
    const before = readFileSync(path, "utf8");
    writeFileSync(`${path}.lock`, "abandoned");
    expect(() => reserveSend(path, "cancel", 1)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => readSends(`${path}.missing`)).toThrow();
    writeFileSync(path, before.replace('"sequence":1', '"sequence":0'));
    expect(() => readSends(path)).toThrow("T04_SEND_JOURNAL_INVALID");
  });
});
