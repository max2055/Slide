/** Deterministic, bounded body-only analysis. Never normalize away numeric differences. */
export interface RepetitionEvidence { repeated: boolean; category: 'none' | 'blocks' | 'periodic'; analyzedChars: number; }
export const MAX_ANALYZED_CHARS = 100_000;

export function repetitionRequested(request: string): boolean {
  return /(?:重复|复述|照抄|原样输出|逐字|repeat|verbatim|duplicate)[\s\S]{0,80}(?:次|遍|以下|这段|原文|times|following|exact|text)|(?:请|please)\s*(?:重复|复述|repeat)/iu.test(request);
}

export function structuredText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('```') && !trimmed.replace(/```[^]*?```/gu, '').trim()) return true;
  if (/^(?:SELECT\b|WITH\b|INSERT\b|CREATE\b|UPDATE\b|DELETE\b)/iu.test(trimmed)) return true;
  try { if (/^[{[]/u.test(trimmed)) { JSON.parse(trimmed); return true; } } catch { /* prose may begin with a bracket */ }
  const lines = trimmed.split('\n').filter(line => line.trim());
  return lines.length > 1 && lines.every(line => /^\s*(?:\||\d{4}-\d\d-\d\d|\[?(?:INFO|WARN|ERROR|DEBUG)\b)/iu.test(line));
}

export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function detectTextRepetition(text: string, request = ''): RepetitionEvidence {
  // Keep evenly spaced windows: bounded work even for unusually large provider output.
  const windows = text.length <= MAX_ANALYZED_CHARS ? [text] : [
    text.slice(0, 33_333), text.slice(Math.floor(text.length / 2) - 16_666, Math.floor(text.length / 2) + 16_667), text.slice(-33_334),
  ];
  const analyzedChars = windows.reduce((n, w) => n + w.length, 0);
  const none: RepetitionEvidence = { repeated: false, category: 'none', analyzedChars };
  if (repetitionRequested(request) || structuredText(windows.join("\n"))) return none;
  for (const window of windows) {
    // Exclude fenced code; structured output has legitimate repeated keys/operators/rows.
    const prose = window.replace(/```[^]*?```/gu, '').split('\n').filter(line =>
      !/^\s*(?:[|{}[\]]|(?:SELECT|INSERT|UPDATE|DELETE|WITH|UNION|FROM|WHERE|CREATE|ALTER|DROP)\b|\d{4}-\d\d-\d\d|\[?(?:INFO|WARN|ERROR|DEBUG)\b)/iu.test(line),
    ).join('\n');
    const normalized = normalizeText(prose);
    if (normalized.length < 80) continue;
    const blocks = prose.split(/\n+|(?<=[。！？.!?])\s*/u).map(normalizeText).filter(Boolean);
    const counts = new Map<string, number>();
    for (const block of blocks) if (block.length >= 8) counts.set(block, (counts.get(block) ?? 0) + 1);
    let covered = 0;
    for (const [block, count] of counts) if (count >= 3) covered += block.length * count;
    if (covered / normalized.length > 0.55) return { repeated: true, category: 'blocks', analyzedChars };
    // Repeated local 16-grams vote for a period; verify adjacent blocks, not mere vocabulary.
    const last = new Map<string, number>();
    const periods = new Map<number, number>();
    for (let i = 0; i + 16 <= normalized.length; i += 4) {
      const gram = normalized.slice(i, i + 16);
      const previous = last.get(gram);
      if (previous !== undefined) {
        const period = i - previous;
        if (period >= 4 && period <= 2048) periods.set(period, (periods.get(period) ?? 0) + 1);
      }
      last.set(gram, i);
    }
    const candidates = [...periods].sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [period] of candidates) {
      let matches = 0;
      for (let i = period; i < normalized.length; i++) if (normalized[i] === normalized[i - period]) matches++;
      if (normalized.length >= period * 3 && matches / normalized.length > 0.55) {
        return { repeated: true, category: 'periodic', analyzedChars };
      }
    }
  }
  return none;
}
