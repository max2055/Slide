import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "./storage.ts";

const SETTINGS_KEY = "slide.control.settings.v1:default";

describe("loadSettings chat session migration", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size;
        },
      } satisfies Storage,
    });
  });

  it("does not restore the legacy main key as a server chat session", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ sessionKey: "main", lastActiveSessionKey: "agent:main:main" }),
    );

    const settings = loadSettings();

    expect(settings.sessionKey).toBe("");
    expect(settings.lastActiveSessionKey).toBe("");
  });
});
