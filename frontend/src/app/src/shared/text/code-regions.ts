import { parseFenceSpans } from "../../markdown/fences.js";

export interface CodeRegion {
  start: number;
  end: number;
}

function appendInlineCodeRegions(text: string, start: number, end: number, regions: CodeRegion[]): void {
  const runs = [...text.slice(start, end).matchAll(/(\\*)(`+)|\\+|(\n[ \t]*\r?\n)/g)];
  const closingEnds = new Map<number, number>();
  const candidates: CodeRegion[] = [];

  // Index the nearest closing run of each length in the same paragraph.
  for (const run of runs.reverse()) {
    const [, backslashes, ticks, paragraphBreak] = run;
    if (paragraphBreak) {
      closingEnds.clear();
    }
    if (!ticks) {
      continue;
    }
    const tickStart = start + run.index + backslashes.length;
    const escaped = backslashes.length % 2;
    const closeEnd = closingEnds.get(ticks.length - escaped);
    if (closeEnd !== undefined) {
      candidates.push({ start: tickStart + escaped, end: closeEnd });
    }
    closingEnds.set(ticks.length, tickStart + ticks.length);
  }

  let cursor = start;
  for (const candidate of candidates.reverse()) {
    if (candidate.start >= cursor) {
      regions.push(candidate);
      cursor = candidate.end;
    }
  }
}

export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let cursor = 0;

  for (const span of parseFenceSpans(text)) {
    appendInlineCodeRegions(text, cursor, span.start, regions);
    regions.push({ start: span.start, end: span.end });
    cursor = span.end;
  }
  appendInlineCodeRegions(text, cursor, text.length, regions);
  return regions;
}

export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}
