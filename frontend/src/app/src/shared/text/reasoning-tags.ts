import { findCodeRegions, isInsideCode } from "./code-regions.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

// Offsets describe each deletion in the text produced by the preceding edits.
type OnTextRemoval = (start: number, end: number) => void;

const QUICK_TAG_RE = /<\s*\/?\s*(?:(?:antml:)?(?:think(?:ing)?|thought|final)|antthinking)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*(?:antml:)?final\b[^<>]*>/gi;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") {
    return value;
  }
  if (mode === "start") {
    return value.trimStart();
  }
  return value.trim();
}

export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
    onRemove?: OnTextRemoval;
  },
): string {
  if (!text) {
    return text;
  }
  if (!QUICK_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";
  const onRemove = options?.onRemove;

  let cleaned = text;
  if (FINAL_TAG_RE.test(cleaned)) {
    FINAL_TAG_RE.lastIndex = 0;
    const finalMatches: Array<{ start: number; length: number; inCode: boolean }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of cleaned.matchAll(FINAL_TAG_RE)) {
      const start = match.index ?? 0;
      finalMatches.push({
        start,
        length: match[0].length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let i = finalMatches.length - 1; i >= 0; i--) {
      const m = finalMatches[i];
      if (!m.inCode) {
        onRemove?.(m.start, m.start + m.length);
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  } else {
    FINAL_TAG_RE.lastIndex = 0;
  }

  const codeRegions = findCodeRegions(cleaned);

  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let thinkingDepth = 0;
  let retainedEnd = 0;
  const appendVisible = (end: number) => {
    if (lastIndex > retainedEnd) {
      onRemove?.(result.length, result.length + lastIndex - retainedEnd);
    }
    result += cleaned.slice(lastIndex, end);
    retainedEnd = end;
  };

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (thinkingDepth === 0) {
      appendVisible(idx);
    }
    // An inner close must not expose the remainder of the outer block.
    thinkingDepth = isClose ? Math.max(0, thinkingDepth - 1) : thinkingDepth + 1;

    lastIndex = idx + match[0].length;
  }

  if (thinkingDepth === 0 || mode === "preserve") {
    appendVisible(cleaned.length);
  } else if (retainedEnd < cleaned.length) {
    onRemove?.(result.length, result.length + cleaned.length - retainedEnd);
  }

  return applyTrim(result, trimMode);
}

/** Prepare the assistant bubble's Markdown and optionally report deletions for source mapping. */
export function prepareAssistantMarkdown(text: string, onRemove?: OnTextRemoval): string {
  const trim = (input: string) => {
    if (!onRemove) return input.trim();
    const withoutTail = input.trimEnd();
    if (withoutTail.length < input.length) onRemove(withoutTail.length, input.length);
    const trimmed = withoutTail.trimStart();
    if (trimmed.length < withoutTail.length) onRemove(0, withoutTail.length - trimmed.length);
    return trimmed;
  };
  return trim(stripReasoningTagsFromText(trim(text), { mode: "preserve", trim: "none", onRemove }));
}
