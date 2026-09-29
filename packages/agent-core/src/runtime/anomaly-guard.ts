import { createHash } from 'node:crypto';
import { detectTextRepetition, normalizeText, repetitionRequested, structuredText } from './text-repetition.js';

/** Current-run evidence only. New tool evidence or a user injection advances the epoch. */
export class AnomalyGuard {
  private evidence = new Set<string>();
  private epoch = 0;
  progress(results: unknown[]): number {
    for (const result of results) {
      const hash = createHash("sha256").update((JSON.stringify(result) ?? '').slice(0, 100_000)).digest("hex");
      if (!this.evidence.has(hash) && this.evidence.size < 256) { this.evidence.add(hash); this.epoch++; }
    }
    return this.epoch;
  }
  private recent: Array<{ fingerprint: string; numbers: string; grams: Set<number>; epoch: number }> = [];
  inspect(content: string, request: string, epoch: number) {
    const evidence = detectTextRepetition(content, request);
    const normalized = normalizeText(content.slice(0, 100_000));
    const fingerprint = createHash('sha256').update(normalized).digest('hex');
    const grams = shingles(normalized);
    const numbers = createHash('sha256').update((normalized.match(/\d+(?:\.\d+)?/gu) ?? []).join('|')).digest('hex');
    const stalled = normalized.length >= 80 && !repetitionRequested(request) && !structuredText(content.slice(0, 100_000))
      && this.recent.some(item => (item.fingerprint === fingerprint || (item.numbers === numbers && similarity(item.grams, grams) > 0.92)) && item.epoch === epoch);
    this.recent.push({ fingerprint, numbers, grams, epoch });
    this.recent = this.recent.slice(-8);
    return { ...evidence, repeated: evidence.repeated || stalled, stalled };
  }
}

/** Bounded hashed shingles retain word/number differences without storing raw candidates. */
function shingles(text: string): Set<number> {
  const hashes = new Set<number>();
  for (let i = 0; i + 12 <= text.length; i += 4) {
    let hash = 2166136261;
    for (let j = i; j < i + 12; j++) hash = Math.imul(hash ^ text.charCodeAt(j), 16777619);
    hashes.add(hash >>> 0);
  }
  return new Set([...hashes].sort((a, b) => a - b).slice(0, 128));
}
function similarity(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const hash of a) if (b.has(hash)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
