import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderMessageGroup, renderStreamingGroup } from "./grouped-render.ts";

describe("assistant streaming presentation", () => {
  it("keeps thinking and answer in one stable assistant response", async () => {
    const host = document.createElement("div");
    render(
      renderStreamingGroup(
        "最终答案",
        Date.now(),
        undefined,
        { name: "Assistant", avatar: null },
        undefined,
        "先检查数据，再给出结论。",
        false,
      ),
      host,
    );
    await Promise.resolve();

    expect(host.querySelector(".chat-group.assistant")).toBeTruthy();
    expect(host.querySelector(".chat-bubble .chat-thinking-disclosure")).toBeTruthy();
    expect(host.querySelectorAll(".chat-bubble")).toHaveLength(1);
    expect(host.querySelector(".chat-text")?.textContent).toContain("最终答案");
    expect(host.textContent).toContain("先检查数据，再给出结论。");
  });

  it("renders the same response container before answer text starts", async () => {
    const host = document.createElement("div");
    render(
      renderStreamingGroup(
        "",
        Date.now(),
        undefined,
        { name: "Assistant", avatar: null },
        undefined,
        "正在分析请求。",
        false,
      ),
      host,
    );
    await Promise.resolve();

    expect(host.querySelector(".chat-group.assistant")).toBeTruthy();
    expect(host.querySelector(".chat-bubble .chat-thinking-disclosure")).toBeTruthy();
    expect(host.querySelectorAll(".chat-bubble")).toHaveLength(1);
    expect(host.querySelector(".chat-reading-indicator")).toBeNull();
  });

  it("uses the same thinking disclosure for completed history messages", async () => {
    const host = document.createElement("div");
    render(
      renderMessageGroup(
        {
          kind: "group",
          key: "assistant-1",
          role: "assistant",
          timestamp: Date.now(),
          isStreaming: false,
          messages: [{
            key: "message-1",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "已完成分析。" },
                { type: "text", text: "最终结果。" },
              ],
            },
          }],
        },
        { showReasoning: true },
      ),
      host,
    );
    await Promise.resolve();

    expect(host.querySelector(".chat-thinking-disclosure")).toBeTruthy();
    expect(host.querySelector(".chat-thinking")).toBeNull();
    expect(host.querySelector(".chat-text")?.textContent).toContain("最终结果");
  });
});
