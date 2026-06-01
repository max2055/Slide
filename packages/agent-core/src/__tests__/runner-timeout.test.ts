/**
 * Tests for timeout layering in AgentRunner.requestModel().
 *
 * Ported from nanobot agent/runner.py timeout pattern (lines 610-739).
 * Run: npx vitest run packages/agent-core/src/__tests__/runner-timeout.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentRunner, NoopHook } from "../runner.js";
import { ToolRegistry } from "../tool-registry.js";
import type {
  LLMProvider,
  LLMResponse,
  LLMCallOptions,
  Message,
  StreamCallbacks,
  ToolSchema,
  AgentRunSpec,
} from "../types.js";

// ── A provider that never resolves (simulates a hanging LLM) ──

class HangingProvider implements LLMProvider {
  getDefaultModel(): string {
    return "hanging-model";
  }

  async chat(
    _messages: Message[],
    _tools: ToolSchema[],
    _options?: LLMCallOptions
  ): Promise<LLMResponse> {
    // Never resolves
    return new Promise<LLMResponse>(() => {
      // Intentionally hanging - never called resolve/reject
    });
  }

  async chatStream(
    _messages: Message[],
    _tools: ToolSchema[],
    _callbacks: StreamCallbacks,
    _options?: LLMCallOptions
  ): Promise<LLMResponse> {
    // Never resolves
    return new Promise<LLMResponse>(() => {
      // Intentionally hanging
    });
  }
}

// ── A provider that records the LLMCallOptions it received ──

class RecordingProvider implements LLMProvider {
  lastOptions?: LLMCallOptions;
  response: LLMResponse;

  constructor(response?: Partial<LLMResponse>) {
    this.response = {
      content: "test response",
      finishReason: "stop",
      toolCalls: [],
      usage: {},
      shouldExecuteTools: false,
      hasToolCalls: false,
      ...response,
    };
  }

  getDefaultModel(): string {
    return "recording-model";
  }

  async chat(
    _messages: Message[],
    _tools: ToolSchema[],
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    this.lastOptions = options;
    return this.response;
  }

  async chatStream(
    _messages: Message[],
    _tools: ToolSchema[],
    _callbacks: StreamCallbacks,
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    this.lastOptions = options;
    return this.response;
  }
}

// ── A provider that resolves in a controlled duration for timeout boundary tests ──

class NormalProvider implements LLMProvider {
  getDefaultModel(): string {
    return "normal-model";
  }

  async chat(
    _messages: Message[],
    _tools: ToolSchema[],
    _options?: LLMCallOptions
  ): Promise<LLMResponse> {
    return {
      content: "fast response",
      finishReason: "stop",
      toolCalls: [],
      usage: {},
      shouldExecuteTools: false,
      hasToolCalls: false,
    };
  }

  async chatStream(
    _messages: Message[],
    _tools: ToolSchema[],
    _callbacks: StreamCallbacks,
    _options?: LLMCallOptions
  ): Promise<LLMResponse> {
    return {
      content: "fast stream response",
      finishReason: "stop",
      toolCalls: [],
      usage: {},
      shouldExecuteTools: false,
      hasToolCalls: false,
    };
  }
}

// ── Recording hook ──

class RecordingHook extends NoopHook {
  private _wantsStreaming: boolean;

  constructor(wantsStreaming: boolean = false) {
    super();
    this._wantsStreaming = wantsStreaming;
  }

  wantsStreaming(): boolean {
    return this._wantsStreaming;
  }
}

// ── Helpers ──

function makeSpec(overrides: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    initialMessages: [],
    tools: new ToolRegistry(),
    model: "test-model",
    maxIterations: 10,
    maxToolResultChars: 10000,
    hook: new RecordingHook(),
    ...overrides,
  };
}

describe("AgentRunner timeout layering", () => {
  beforeEach(() => {
    // Ensure env vars don't leak between tests
    delete process.env["NANOBOT_LLM_TIMEOUT_S"];
    delete process.env["NANOBOT_STREAM_IDLE_TIMEOUT_S"];
  });

  it("non-streaming call with short LLM timeout returns error_kind='timeout'", async () => {
    const runner = new AgentRunner(new HangingProvider());
    const spec = makeSpec({
      llmTimeoutS: 0.1, // 100ms timeout
    });

    const result = await runner.run(spec);
    expect(result.error).toMatch(/timed out/);
    expect(result.stopReason).toBe("error");
    // The finalContent should contain the timeout error
    expect(result.finalContent).toMatch(/timeout|timed out/i);
  });

  it("streaming call with short LLM timeout does NOT timeout", async () => {
    // For streaming, wall-clock timeout should be skipped
    const hook = new RecordingHook(true); // wantsStreaming = true
    const runner = new AgentRunner(new HangingProvider());
    const spec = makeSpec({
      llmTimeoutS: 0.1, // Would timeout if applied, but streaming skips it
      hook,
    });

    // This should hang indefinitely since the provider hangs and there's no streaming idle timeout
    // We use a shorter overall timeout via Promise.race to avoid test hanging
    const result = await Promise.race([
      runner.run(spec),
      new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), 500)),
    ]);

    // The streaming call should hang (not return timeout), so our race should win with TIMEOUT
    expect(result).toBe("TIMEOUT");
  });

  it("NANOBOT_LLM_TIMEOUT_S env var is used as default when spec.llmTimeoutS is undefined", async () => {
    process.env["NANOBOT_LLM_TIMEOUT_S"] = "0.1";
    const runner = new AgentRunner(new HangingProvider());
    const spec = makeSpec({
      // No llmTimeoutS — should fall back to env
    });

    const result = await runner.run(spec);
    expect(result.error).toMatch(/timed out/);
    expect(result.stopReason).toBe("error");
  });

  it("error kind is 'timeout', not an exception", async () => {
    const runner = new AgentRunner(new HangingProvider());
    const spec = makeSpec({
      llmTimeoutS: 0.1,
    });

    // Should not throw
    let result;
    try {
      result = await runner.run(spec);
    } catch (e) {
      expect.unreachable("Should not throw an exception");
    }
    expect(result!.error).toMatch(/timed out/);
    expect(result!.stopReason).toBe("error");
  });

  it("non-streaming fast provider does NOT trigger timeout", async () => {
    const runner = new AgentRunner(new NormalProvider());
    const spec = makeSpec({
      llmTimeoutS: 5, // Reasonable timeout
    });

    const result = await runner.run(spec);
    expect(result.stopReason).toBe("completed");
    expect(result.error).toBeNull();
  });
});
