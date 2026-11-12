import { parseFenceSpans } from "../../markdown/fences.js";

export interface CodeRegion {
  start: number;
  end: number;
}

export function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  for (const span of parseFenceSpans(text)) {
    regions.push({ start: span.start, end: span.end });
  }

  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}
