import { createHash } from 'node:crypto';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { seriesIdentity } from '../../contracts/metrics/validation.js';
import { PolicyError } from '../policy/model.js';
import type { Series } from '../storage.js';

/** Same bounded page shape the aggregate query already enforces. */
export const OBSERVATION_PAGE_DEFAULT_LIMIT = 100;
export const OBSERVATION_PAGE_MAX_LIMIT = 1000;
export const OBSERVATION_PAGE_ORDER = 'observed_at,observation_id' as const;

/** Keyset position only: the last row's time and publication id, never an offset. */
export interface ObservationKey { at: string; id: string }

export interface ObservationPageResult {
  observations: NormalizedObservation[];
  /** Formal rows in the half-open window, counted in the same snapshot as the page. */
  total: number;
  has_more: boolean;
  /** Last row of this page when another page follows; null on the final page. */
  next: ObservationKey | null;
}

export interface ObservationPageOptions { limit: number; after: ObservationKey | null }

const digest = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 32);

/** The cursor cannot be replayed against another resource, metric, version, dimensions or window. */
export const observationCursorBinding = (series: Series, from: string, to: string): string =>
  digest([seriesIdentity(series), from, to].join('\u0000'));

export function encodeObservationCursor(key: ObservationKey, binding: string): string {
  return Buffer.from(JSON.stringify({ a: key.at, i: key.id, b: binding }), 'utf8').toString('base64url');
}

export function decodeObservationCursor(cursor: string, binding: string): ObservationKey {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new PolicyError('QUERY_INPUT_INVALID', 400); }
  const value = parsed as { a?: unknown; i?: unknown; b?: unknown };
  // UTC SQL datetime text, the exact form the store compares against.
  if (typeof value?.a !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(value.a)
    || typeof value.i !== 'string' || typeof value.b !== 'string') throw new PolicyError('QUERY_INPUT_INVALID', 400);
  if (value.b !== binding) throw new PolicyError('QUERY_INPUT_INVALID', 400);
  return { at: value.a, id: value.i };
}
