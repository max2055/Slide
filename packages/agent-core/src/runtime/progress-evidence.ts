/** FIFO window of distinct hashes, shared with the checkpoint's 256-entry limit.
 * Repeats within the window do not advance progress. Evicted evidence may count
 * again; exact lifetime deduplication would require unbounded retained state.
 */
export function rememberEvidence(evidence: Set<string>, hash: string): boolean {
  if (evidence.has(hash)) return false;
  if (evidence.size >= 256) evidence.delete(evidence.values().next().value!);
  evidence.add(hash);
  return true;
}

const VOLATILE_KEY = /^(?:time(?:stamp)?|created[-_]?at|updated[-_]?at|request[-_]?id|trace[-_]?id|span[-_]?id|correlation[-_]?id)$/i;

/** Ephemeral hash input only: bounded output, traversal and depth. Never calls
 * user toJSON/getters. Unreadable values use a fixed marker, never error text.
 */
export function progressValue(value: unknown, semantic = false): string {
  const parts: string[] = [];
  let remaining = 100_000;
  let nodes = 4096;
  const seen = new WeakSet<object>();
  const emit = (part: string) => {
    const bounded = part.slice(0, remaining);
    remaining -= bounded.length;
    parts.push(bounded);
  };
  const visit = (item: unknown, depth: number): void => {
    if (!remaining) return;
    if (--nodes < 0 || depth > 12) { emit('"[limit]"'); return; }
    try {
      if (typeof item === 'string') {
        let text = item.slice(0, 100_000);
        if (semantic) {
          text = text.trim();
          if (item.length <= 100_000 && ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) {
            try { const parsed: unknown = JSON.parse(text); visit(parsed, depth + 1); return; } catch { /* retain text */ }
          }
          text = text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/giu, '[timestamp]');
        }
        emit(JSON.stringify(text));
      } else if (typeof item === 'bigint') {
        emit(`bigint:${item.toString().slice(0, 100_000)}`);
      } else if (item === null || typeof item !== 'object') {
        emit(JSON.stringify(item) ?? `[${typeof item}]`);
      } else if (seen.has(item)) {
        emit('"[circular]"');
      } else {
        seen.add(item);
        try {
          const array = Array.isArray(item);
          emit(array ? '[' : '{');
          const keys = array ? Array.from({ length: Math.min(item.length, 512) }, (_, i) => String(i))
            : Object.keys(item).filter(key => !semantic || !VOLATILE_KEY.test(key)).sort().slice(0, 512);
          for (const [index, key] of keys.entries()) {
            if (!remaining || nodes <= 0) break;
            if (index) emit(',');
            if (!array) emit(`${JSON.stringify(key.slice(0, 100_000))}:`);
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (descriptor && !('value' in descriptor)) emit('"[accessor]"');
            else visit(descriptor?.value, depth + 1);
          }
          emit(array ? ']' : '}');
        } finally { seen.delete(item); }
      }
    } catch { emit('"[unreadable]"'); }
  };
  visit(value, 0);
  return parts.join('');
}
