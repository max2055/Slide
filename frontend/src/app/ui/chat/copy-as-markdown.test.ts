import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./copy-as-markdown.ts";

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  });

  it("uses the modern clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await expect(copyTextToClipboard("answer")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("answer");
  });

  it("falls back to execCommand when the modern API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    const execCommand = vi.mocked(document.execCommand);

    await expect(copyTextToClipboard("answer")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when clipboard permissions reject", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    const execCommand = vi.mocked(document.execCommand);

    await expect(copyTextToClipboard("answer")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});
