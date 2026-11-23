import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderMessageGroup, renderStreamingGroup } from "./grouped-render.ts";
import { normalizeMessage } from "./message-normalizer.ts";


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

describe("assistant reply directives in rendered Markdown", () => {
  const example = "[[reply_to:example]]";

  function renderAssistant(content: unknown) {
    const message = { role: "assistant", content };
    const host = document.createElement("div");
    render(renderMessageGroup({
      kind: "group",
      key: "assistant",
      role: "assistant",
      timestamp: 1,
      isStreaming: false,
      messages: [{ key: "message", message }],
    }, { showReasoning: false }), host);
    return { normalized: normalizeMessage(message), text: host.querySelector(".chat-text") };
  }

  it("extracts a padded first-line directive and preserves rendered indented code", () => {
    const body = `正文\n\n    ${example}\t  \n\n结尾`;
    const { normalized, text } = renderAssistant(`    [[reply_to:wanted]]\n${body}`);
    expect(normalized.replyTarget).toEqual({ kind: "id", id: "wanted" });
    expect(normalized.content).toEqual([{ type: "text", text: body }]);
    expect(text?.querySelector("pre code")?.textContent).toBe(`${example}\t  \n`);
    expect(text?.textContent).not.toContain("[[reply_to:wanted]]");
  });

  it("recognizes one code span across legacy text items without moving attachments", () => {
    const parts = [
      { type: "text", text: "说明 `上行" },
      { type: "attachment", attachment: { kind: "document", url: "https://example.com/report.pdf", label: "报告" } },
      { type: "text", text: `  ${example}\` 尾` },
    ];
    const legacy = renderAssistant(parts);
    const single = renderAssistant(`${parts[0].text}\n${parts[2].text}`);
    expect(legacy.text?.querySelector("code")?.textContent).toBe(`上行   ${example}`);
    expect(legacy.text?.querySelector("code")?.textContent).toBe(single.text?.querySelector("code")?.textContent);
    expect(legacy.normalized.replyTarget).toBeUndefined();
    expect(legacy.normalized.content).toEqual(parts);
  });

  it("protects quoted fences inside final wrappers and maps later directives to source", () => {
    const source = `<final>\n> ~~~text\n>   ${example}\t  \n> ~~~\n</final>`;
    const onlyCode = renderAssistant(source);
    expect(onlyCode.normalized.replyTarget).toBeUndefined();
    expect(onlyCode.normalized.content).toEqual([{ type: "text", text: source }]);
    expect(onlyCode.text?.querySelector("blockquote pre code")?.textContent).toBe(`  ${example}\t  \n`);

    const mixed = renderAssistant(`${source}\n\n<think>[[reply_to:hidden]]</think>\n[[reply_to:wanted]]\n正文`);
    expect(mixed.normalized.replyTarget).toEqual({ kind: "id", id: "wanted" });
    expect(mixed.text?.querySelector("blockquote pre code")?.textContent).toBe(`  ${example}\t  \n`);
    expect(mixed.text?.textContent).not.toContain("[[reply_to:wanted]]");
    expect(mixed.text?.textContent).not.toContain("[[reply_to:hidden]]");
    expect(mixed.text?.textContent).toContain("正文");
  });
});
