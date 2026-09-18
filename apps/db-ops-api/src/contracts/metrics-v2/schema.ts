import { z } from 'zod';
import * as definitions from './definitions.js';
import * as observations from './observations.js';
import * as configuration from './configuration.js';

/** Structural schemas; callers MUST also use validation.ts for cross-record invariants. */
export function exportSchemas(): Record<string, unknown> {
  return Object.fromEntries(Object.entries({ ...definitions, ...observations, ...configuration })
    .filter(([name]) => name.endsWith('Schema'))
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, schema]) => [name, z.toJSONSchema(schema as z.ZodType, { target: 'draft-2020-12' })]));
}
