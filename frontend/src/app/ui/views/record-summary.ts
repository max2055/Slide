import { metricDisplayName } from '../components/metric-display.js';

export function investigationSubject(title: string, entry?: { sourceEventIds?: number[]; metric?: { id: string } }) {
  const events = [...new Set(entry?.sourceEventIds ?? [])].filter(id => Number.isSafeInteger(id) && id > 0);
  return events.length === 1 && entry?.metric?.id ? `事件 #${events[0]} · ${metricDisplayName(entry.metric.id)}` : title;
}

/** Keep long evidence and qualification in the original record. The preview
 * reproduces its leading words without inferring a result or recovery state. */
export function recordExcerpt(value: string, limit = 120): string {
  const text = value.trim().replace(/\s+/g, ' ');
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const head = characters.slice(0, limit).join('');
  const boundary = /[。！？](?!$)/.exec(head.slice(48));
  return (boundary ? head.slice(0, 49 + boundary.index) : head) + '…';
}
