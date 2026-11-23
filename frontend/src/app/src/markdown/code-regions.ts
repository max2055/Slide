import parseBackticks from "markdown-it/lib/rules_inline/backticks.mjs";
import type { CodeRegion } from "../shared/text/code-regions.js";
import { createChatMarkdownParser } from "./parser.js";

const markdown = createChatMarkdownParser();
markdown.inline.ruler.at("backticks", (state, silent) => {
  const start = state.pos;
  const tokenCount = state.tokens.length;
  const matched = parseBackticks(state, silent);
  const token = state.tokens.at(-1);
  if (matched && !silent && state.tokens.length > tokenCount && token?.type === "code_inline") {
    token.meta = { start, end: state.pos } satisfies CodeRegion;
  }
  return matched;
});

export function findMarkdownCodeRegions(text: string): CodeRegion[] {
  if (!/`|~~~| {4}|\t/.test(text)) return [];

  const lineOffsets = [0];
  for (const newline of text.matchAll(/\r\n?|\n/g)) {
    lineOffsets.push(newline.index + newline[0].length);
  }

  const regions: CodeRegion[] = [];
  let tableRow: [number, number] | null = null;
  let nextTableTick = 0;
  for (const token of markdown.parse(text, {})) {
    if (token.type === "fence" || token.type === "code_block") {
      const [startLine, endLine] = token.map;
      regions.push({ start: lineOffsets[startLine], end: lineOffsets[endLine] ?? text.length });
      continue;
    }
    if (token.type === "tr_open") {
      tableRow = token.map;
      nextTableTick = tableRow ? lineOffsets[tableRow[0]] : 0;
      continue;
    }
    if (token.type === "tr_close") {
      tableRow = null;
      continue;
    }
    if (token.type !== "inline" || !token.content.includes("`")) continue;

    // Inline tokens keep the backticks in source order even when Markdown removes
    // container prefixes or normalizes newlines. Table cells share a row range.
    const lines = token.map ?? tableRow;
    if (!lines) continue;
    const lineEnd = lineOffsets[lines[1]] ?? text.length;
    let sourceOffset = token.map ? lineOffsets[lines[0]] : nextTableTick;
    const tickOffsets = new Map<number, number>();
    for (const tick of token.content.matchAll(/`/g)) {
      const offset = text.indexOf("`", sourceOffset);
      if (offset < 0 || offset >= lineEnd) break;
      tickOffsets.set(tick.index, offset);
      sourceOffset = offset + 1;
    }
    if (!token.map) nextTableTick = sourceOffset;

    for (const child of token.children ?? []) {
      if (child.type !== "code_inline" || !child.meta) continue;
      const offsets: CodeRegion = child.meta;
      const start = tickOffsets.get(offsets.start);
      const lastTick = tickOffsets.get(offsets.end - 1);
      if (start !== undefined && lastTick !== undefined) {
        regions.push({ start, end: lastTick + 1 });
      }
    }
  }
  return regions;
}
