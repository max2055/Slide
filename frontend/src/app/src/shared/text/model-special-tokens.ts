/**
 * Strip model control tokens leaked into assistant text output.
 *
 * Models like GLM-5 and DeepSeek sometimes emit internal delimiter tokens
 * (e.g. `<|assistant|>`, `<|tool_call_result_begin|>`, `<｜begin▁of▁sentence｜>`)
 * in their responses. These use the universal `<|...|>` convention (ASCII or
 * full-width pipe variants) and should never reach end users.
 *
 * Matches inside fenced code blocks or inline code spans are preserved so
 * that documentation / examples that reference these tokens are not corrupted.
 *
 * This is a provider bug — no upstream fix tracked yet.
 * Remove this function when upstream providers stop leaking tokens.
 */
import { findCodeRegions, isInsideCode } from "./code-regions.js";

// Only recognized delimiter names, with matching ASCII or full-width pipes.
// Unknown examples and incomplete / multiline text are user-visible content.
const MODEL_SPECIAL_TOKEN_RE =
  /<([|｜])(?:assistant|user|system|tool|im_start|im_end|im_sep|endoftext|begin_of_text|end_of_text|eot_id|start_header_id|end_header_id|tool_call_begin|tool_call_end|tool_call_result_begin|tool_call_result_end|begin▁of▁sentence|end▁of▁sentence|User|Assistant|tool▁calls▁begin|tool▁calls▁end|tool▁call▁begin|tool▁call▁end|tool▁sep|tool▁outputs▁begin|tool▁outputs▁end|tool▁output▁begin|tool▁output▁end)\1>/g;

function overlapsCodeRegion(
  start: number,
  end: number,
  codeRegions: { start: number; end: number }[],
): boolean {
  return codeRegions.some((region) => start < region.end && end > region.start);
}

function shouldInsertSeparator(before: string | undefined, after: string | undefined): boolean {
  return Boolean(before && after && !/\s/.test(before) && !/\s/.test(after));
}

export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(MODEL_SPECIAL_TOKEN_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    out += text.slice(cursor, start);
    if (isInsideCode(start, codeRegions) || overlapsCodeRegion(start, end, codeRegions)) {
      out += matched;
    } else if (shouldInsertSeparator(text[start - 1], text[end])) {
      out += " ";
    }
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}
