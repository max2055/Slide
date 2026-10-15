import type { BadgeVariant } from './components/app-badge.js';

// Persisted alerts and escalation rules share this order. P0 is above critical,
// not an alias; preserve unknown raw values for display, filtering and counts.
export const ALERT_LEVELS = ['p0', 'critical', 'error', 'warning', 'info'] as const;
const labels: Record<string, string> = { p0: '紧急（P0）', critical: '严重', error: '错误', warning: '警告', info: '提示' };
const variants: Record<string, BadgeVariant> = { p0: 'danger', critical: 'danger', error: 'danger', warning: 'warn', info: 'info' };

export function alertLevelLabel(level: string): string {
  return Object.hasOwn(labels, level) ? labels[level] : `未知等级（${level || '空值'}）`;
}

export function alertLevelVariant(level: string): BadgeVariant {
  return Object.hasOwn(variants, level) ? variants[level] : 'muted';
}

export function alertLevelOptions(values: readonly string[] = []): string[] {
  return [...ALERT_LEVELS, ...Array.from(new Set(values)).filter(level => !Object.hasOwn(labels, level)).sort()];
}
