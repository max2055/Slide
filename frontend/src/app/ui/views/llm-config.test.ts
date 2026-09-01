import { beforeEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../../../api/index.js", () => ({ apiClient: { post } }));

import "./llm-config.js";

describe("llm-config-page connection testing", () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ success: true, message: "连接成功" });
  });

  it("sends the current unsaved provider draft when testing", async () => {
    const element = document.createElement("llm-config-page") as any;
    element.editing = { id: 7, name: "deepseek" };
    element.form = {
      name: "deepseek",
      api_key: "new-unsaved-key",
      api_base_url: "https://example.test/v1",
      default_model: "deepseek-chat-new",
      api_format: "openai-completions",
      deployment_type: "api",
    };

    await element._test(element.editing);

    expect(post).toHaveBeenCalledWith("/llm/test", {
      providerName: "deepseek",
      apiKey: "new-unsaved-key",
      baseURL: "https://example.test/v1",
      model: "deepseek-chat-new",
      apiFormat: "openai-completions",
      deploymentType: "api",
    });
  });
});
