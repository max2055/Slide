import type { Locale, TranslationMap } from "./types.ts";
import { en } from "../locales/en.ts";
import { zh_CN } from "../locales/zh-CN.ts";

export const DEFAULT_LOCALE: Locale = "en";

// Both supported languages must be available before the first render.
export const BUNDLED_TRANSLATIONS: Partial<Record<Locale, TranslationMap>> = {
  en,
  "zh-CN": zh_CN,
};

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = [DEFAULT_LOCALE, "zh-CN"];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

export function resolveNavigatorLocale(navLang: string): Locale {
  if (navLang.startsWith("zh")) {
    return "zh-CN";
  }
  return DEFAULT_LOCALE;
}
