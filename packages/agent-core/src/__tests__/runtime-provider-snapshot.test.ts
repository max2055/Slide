import { expect, it } from "vitest";
import { AgentRunner, NoopHook } from "../runner.js";
import { ToolRegistry } from "../tool-registry.js";
import type { LLMProvider, LLMResponse } from "../types.js";

const reply = (content: string): LLMResponse => ({
  content,
  finishReason: "stop",
  toolCalls: [],
  shouldExecuteTools: false,
  hasToolCalls: false,
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

it.each([
  { name: "without timeout", runTimeoutMs: undefined },
  { name: "with timeout control", runTimeoutMs: 30_000 },
])(
  "keeps one provider for an active run while new runs use the replacement ($name)",
  async ({ runTimeoutMs }) => {
    let startTool: () => void = () => {};
    let finishTool: () => void = () => {};
    const toolStarted = new Promise<void>((resolve) => {
      startTool = resolve;
    });
    const toolGate = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const firstModels: string[] = [];
    const replacementModels: string[] = [];
    const contextSources: string[] = [];

    const firstChat: LLMProvider["chat"] = async (_messages, _tools, options) => {
      firstModels.push(options?.model ?? "");
      if (firstModels.length === 1) {
        return {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [{ id: "wait-for-provider-update", name: "wait", arguments: {} }],
          shouldExecuteTools: true,
          hasToolCalls: true,
          usage: {},
        };
      }
      return reply("finished with the original provider");
    };
    const firstProvider: LLMProvider = {
      getDefaultModel: () => "model-a",
      getModelCapabilities: (model = "model-a") => {
        contextSources.push("first");
        return {
          model,
          contextWindowTokens: 32_768,
          maxOutputTokens: 4096,
          source: "configuration",
          version: "first",
        };
      },
      chat: firstChat,
      chatStream: (messages, tools, _callbacks, options) => firstChat(messages, tools, options),
    };
    const replacementChat: LLMProvider["chat"] = async (_messages, _tools, options) => {
      replacementModels.push(options?.model ?? "");
      return reply("finished with the replacement provider");
    };
    const replacementProvider: LLMProvider = {
      getDefaultModel: () => "model-b",
      getModelCapabilities: (model = "model-b") => {
        contextSources.push("replacement");
        return {
          model,
          contextWindowTokens: 16_384,
          maxOutputTokens: 2048,
          source: "configuration",
          version: "replacement",
        };
      },
      chat: replacementChat,
      chatStream: (messages, tools, _callbacks, options) =>
        replacementChat(messages, tools, options),
    };

    const tools = new ToolRegistry();
    tools.register({
      name: "wait",
      description: "Wait for the test to replace the provider",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      concurrencySafe: true,
      exclusive: false,
      execute: async () => {
        startTool();
        await toolGate;
        return "tool completed";
      },
    });
    const runner = new AgentRunner(firstProvider);
    const spec = {
      initialMessages: [{ role: "user" as const, content: "Complete the two-step run" }],
      tools,
      model: runner.getDefaultModel(),
      maxIterations: 3,
      maxToolResultChars: 1000,
      contextWindowTokens: 32_768,
      maxTokens: 1024,
      hook: new NoopHook(),
      ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
    };

    const activeRun = runner.run(spec);
    await toolStarted;
    runner.setProvider(replacementProvider);
    finishTool();
    const activeResult = await activeRun;

    expect(activeResult.stopReason).toBe("completed");
    expect(firstModels).toEqual(["model-a", "model-a"]);
    expect(replacementModels).toEqual([]);
    expect(contextSources).not.toContain("replacement");

    const nextResult = await runner.run({
      ...spec,
      model: runner.getDefaultModel(),
      tools: new ToolRegistry(),
    });
    expect(nextResult.stopReason).toBe("completed");
    expect(replacementModels).toEqual(["model-b"]);
    expect(contextSources).toContain("replacement");
  },
);
