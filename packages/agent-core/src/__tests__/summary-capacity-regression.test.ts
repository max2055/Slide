import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { it } from "vitest";
it("summary output must coexist with protected context", async () => {
  const { autoCompact } = await import(new URL("../runtime/auto-compact.js", import.meta.url).href);
  const base = new URL("../", import.meta.url).href;
  const { ContextManager } = await import(base + "runtime/context-manager.ts");
  const { RecoveryPolicy } = await import(base + "runtime/recovery-policy.ts");
  const { RapidRefill } = await import(base + "runtime/rapid-refill.ts");
  const { ToolRegistry } = await import(base + "tool-registry.ts");
  const { NoopHook } = await import(base + "runner.ts");
  const brief = {
    goal: ["inspect db-42"],
    constraints: ["read only"],
    done: [],
    pending: ["review evidence"],
    evidence: ["e-1"],
    uncertain: ["unknown metric; no replay"],
  };
  const verbose = { ...brief, evidence: ["e-1: " + "observed data ".repeat(350)] };
  const raw: any[] = [
    { id: "policy", role: "system", content: "Read only." },
    { id: "goal", role: "user", content: "inspect db-42" },
    { id: "history", role: "assistant", content: "historical fact ".repeat(500) },
    { id: "latest", role: "user", content: "report evidence " + "protected ".repeat(590) },
  ];
  const cases: any[] = [];
  for (const mode of ["respects-budget", "ignores-budget", "persistence-fails", "no-room"]) {
    let sends = 0,
      ceiling = 0;
    const receipts: any[] = [];
    const spec: any = {
      initialMessages: raw,
      tools: new ToolRegistry(),
      model: "same-model",
      maxIterations: 6,
      maxToolResultChars: 1000,
      hook: new NoopHook(),
      contextWindowTokens: 16000,
      maxTokens: 4096,
      checkpointCallback: async () => {},
      ...(mode === "no-room" ? { contextBlockLimit: 6400 } : {}),
    };
    const provider: any = {
      getDefaultModel: () => "same-model",
      chat: async () => {
        throw Error("ordinary request forbidden in this test");
      },
      chatStream: async (_m: any, _t: any, _c: any, options: any) => {
        sends++;
        ceiling = options.maxTokens;
        return {
          content: JSON.stringify(mode === "ignores-budget" || ceiling >= 1419 ? verbose : brief),
          finishReason: "stop",
          toolCalls: [],
          hasToolCalls: false,
          shouldExecuteTools: false,
          usage: { prompt_tokens: 3199, completion_tokens: Math.min(ceiling, 1419) },
        };
      },
    };
    const manager = new ContextManager(spec, provider);
    let error: any;
    const tracker = new RapidRefill();
    try {
      await autoCompact(
        manager,
        raw,
        provider,
        new RecoveryPolicy(),
        tracker,
        async (record: any, _state: any, receipt: any) => {
          if (receipt) {
            receipts.push(receipt);
            if (mode === "persistence-fails") throw Error("CHECKPOINT_FAILURE");
          }
        },
      );
    } catch (e) {
      error = e;
    }
    if (mode === "respects-budget") {
      assert(
        !error,
        "a bounded summary must fit protected suffix without increasing the context window: " +
          String(error),
      );
      assert.equal(sends, 1);
      assert(ceiling < 1419);
      assert.equal(receipts[0].status, "accepted");
      assert.deepEqual(manager.summary.summary, brief);
      manager.assertFits(manager.project(raw));
      assert.equal(manager.inputBudget, 10880);
      assert.equal(raw[3].content, "report evidence " + "protected ".repeat(590));
    } else if (mode === "ignores-budget") {
      assert(error);
      assert.equal(error.code, "CONTEXT_UNRECOVERABLE");
      assert.equal(sends, 1);
      assert.equal(receipts.length, 0);
      assert(!manager.summary);
    } else if (mode === "persistence-fails") {
      assert.equal(error?.message, "CHECKPOINT_FAILURE");
      assert.equal(receipts.length, 1);
      assert(!manager.summary);
      assert.equal(sends, 1);
    } else {
      assert(error);
      assert.equal(sends, 0, "do not pay for a summary that has no safe capacity");
      assert(!manager.summary);
    }
    cases.push({ mode, sends, outputCeiling: ceiling, ok: true });
  }
});
