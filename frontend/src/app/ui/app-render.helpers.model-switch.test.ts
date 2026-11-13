import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatSessionSelect } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { createChatModelOverride } from "./chat-model-ref.ts";
import { loadSessions } from "./controllers/sessions.ts";

vi.mock("./controllers/sessions.ts", () => ({ loadSessions: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

// #641 / OCR-1629: use the real Lit selector/change handler with controlled RPC replies.
describe.each([
  { field: "model", first: "alpha", second: "beta", original: "original" },
  { field: "thinking", first: "low", second: "high", original: "off" },
] as const)("chat $field switching", ({ field, first, second, original }) => {
  function setup() {
    const pending: { params: Record<string, unknown>; resolve(): void; reject(): void }[] = [];
    const state = {
      connected: true,
      sessionKey: "agent:main:main",
      chatLoading: false,
      chatSending: false,
      chatStream: null,
      chatThinkingLevel: original,
      chatModelOverrides: {},
      chatModelCatalog: ["original", "alpha", "beta"].map((id) => ({ id, name: id })),
      sessionsResult: {
        sessions: [
          { key: "agent:main:main", model: "original", thinkingLevel: "off" },
          { key: "agent:main:other", model: "original", thinkingLevel: "off" },
        ],
        defaults: {},
      },
      client: {
        request: vi.fn((method: string, params: Record<string, unknown>) => {
          expect(method).toBe("sessions.patch");
          return new Promise<void>((resolve, reject) => {
            pending.push({ params, resolve, reject: () => reject(new Error("patch failed")) });
          });
        }),
      },
    } as unknown as AppViewState;
    vi.mocked(loadSessions).mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.append(container);
    function picker() {
      render(renderChatSessionSelect(state), container);
      return container.querySelector<HTMLSelectElement>(`[data-chat-${field}-select]`)!;
    }
    function choose(value: string) {
      const select = picker();
      expect(select.disabled).toBe(false);
      expect(select.getAttribute("aria-label")).toBeTruthy();
      select.focus();
      if (select.value !== value) select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(document.activeElement).toBe(select);
      picker(); // Reflect the optimistic state as the reactive application host does.
    }
    async function succeed(index: number) {
      pending[index].resolve();
      await vi.waitFor(() => expect(loadSessions).toHaveBeenCalled());
    }
    async function fail(index: number) {
      pending[index].reject();
      await vi.waitFor(() => expect(state.lastError).toContain("patch failed"));
    }
    return { state, pending, picker, choose, succeed, fail };
  }

  it("keeps a later successful choice when the earlier patch fails", async () => {
    const h = setup();
    h.choose(first);
    h.choose(second);
    await h.succeed(1);
    await h.fail(0);
    expect(h.picker().value).toBe(second);
    if (field === "thinking") expect(h.state.chatThinkingLevel).toBe(second);
    expect(h.pending.map(({ params }) => params)).toEqual([
      { key: h.state.sessionKey, [field === "model" ? "model" : "thinkingLevel"]: first },
      { key: h.state.sessionKey, [field === "model" ? "model" : "thinkingLevel"]: second },
    ]);
  });

  it("restores the previous choice after a single failure", async () => {
    const h = setup();
    h.choose(first);
    expect(h.picker().value).toBe(first);
    await h.fail(0);
    expect(h.picker().value).toBe(original);
    if (field === "thinking") expect(h.state.chatThinkingLevel).toBe(original);
  });

  it("refreshes session data after a successful change", async () => {
    const h = setup();
    vi.mocked(loadSessions).mockImplementation(async () => {
      h.state.sessionsResult = {
        ...h.state.sessionsResult!,
        sessions: h.state.sessionsResult!.sessions.map((row) => ({
          ...row,
          [field === "model" ? "model" : "thinkingLevel"]: first,
        })),
      };
    });
    h.choose(first);
    await h.succeed(0);
    expect(h.picker().value).toBe(first);
    expect(h.state.lastError).toBeNull();
    expect(loadSessions).toHaveBeenCalledWith(h.state, {
      activeMinutes: 0, limit: 0, includeGlobal: true, includeUnknown: true,
    });
  });

  it("keeps the newer optimistic choice while its request is pending", async () => {
    const h = setup();
    h.choose(first);
    h.choose(second);
    await h.fail(0);
    expect(h.picker().value).toBe(second);
    await h.succeed(1);
    expect(h.picker().value).toBe(second);
  });

  it("restores an inherited default after a single failure", async () => {
    const h = setup();
    if (field === "model") h.state.chatModelOverrides[h.state.sessionKey] = null;
    else {
      h.state.sessionsResult!.sessions[0].thinkingLevel = undefined;
      h.state.chatThinkingLevel = null;
    }
    h.choose(first);
    await h.fail(0);
    expect(h.picker().value).toBe("");
    if (field === "model") expect(h.state.chatModelOverrides[h.state.sessionKey]).toBeNull();
    else expect(h.state.chatThinkingLevel).toBeNull();
  });

  it("keeps request ownership separate for model and thinking changes", async () => {
    const h = setup();
    h.choose(first);
    const otherField = field === "model" ? "thinking" : "model";
    const otherValue = field === "model" ? "high" : "beta";
    const other = h.picker().parentElement!.parentElement!
      .querySelector<HTMLSelectElement>(`[data-chat-${otherField}-select]`)!;
    other.value = otherValue;
    other.dispatchEvent(new Event("change", { bubbles: true }));
    await h.succeed(1);
    await h.fail(0);
    expect(h.picker().value).toBe(original);
    const otherAfter = h.picker().parentElement!.parentElement!
      .querySelector<HTMLSelectElement>(`[data-chat-${otherField}-select]`)!;
    expect(otherAfter.value).toBe(otherValue);
  });

  it("distinguishes a newer request that returns to the same value (ABA)", async () => {
    const h = setup();
    h.choose(first);
    h.choose(second);
    h.choose(first);
    await h.succeed(2);
    await h.succeed(1);
    await h.fail(0);
    expect(h.picker().value).toBe(first);
  });

  it("does not create a new request for an unchanged selection", async () => {
    const h = setup();
    h.choose(original);
    expect(h.pending).toHaveLength(0);
    h.choose(first);
    h.choose(first);
    expect(h.pending).toHaveLength(1);
    await h.fail(0);
    expect(h.picker().value).toBe(original);
  });

  it("rolls back a single reset to the default", async () => {
    const h = setup();
    h.choose("");
    expect(h.pending[0].params[field === "model" ? "model" : "thinkingLevel"]).toBeNull();
    await h.fail(0);
    expect(h.picker().value).toBe(original);
  });

  it("keeps a later successful reset to the default", async () => {
    const h = setup();
    h.choose(first);
    h.choose("");
    await h.succeed(1);
    await h.fail(0);
    expect(h.picker().value).toBe("");
  });

  it("does not overwrite values replaced outside this request", async () => {
    const h = setup();
    h.choose(first);
    if (field === "model") {
      h.state.chatModelOverrides[h.state.sessionKey] = createChatModelOverride(second);
    } else {
      h.state.sessionsResult!.sessions[0].thinkingLevel = second;
      h.state.chatThinkingLevel = second;
    }
    await h.fail(0);
    expect(h.picker().value).toBe(second);
  });

  it("scopes rollback to the original session", async () => {
    const h = setup();
    h.choose(first);
    h.state.sessionKey = "agent:main:other";
    h.choose(second);
    await h.succeed(1);
    await h.fail(0);
    expect(h.picker().value).toBe(second);
    if (field === "thinking") expect(h.state.chatThinkingLevel).toBe(second);
    h.state.sessionKey = "agent:main:main";
    expect(h.picker().value).toBe(original);
  });
});
