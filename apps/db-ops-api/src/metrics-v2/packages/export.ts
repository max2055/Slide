import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { PackageReleaseSchema, SelectionSchema } from './model.js';
import { builtinReleases, createBuiltinRegistry } from './builtins.js';

const directory = new URL('../../../../../docs/slide/metrics-v2/packages/', import.meta.url);
const files = {
  'schemas.json': { PackageRelease: z.toJSONSchema(PackageReleaseSchema), Selection: z.toJSONSchema(SelectionSchema) },
  'builtins.json': builtinReleases(),
};
createBuiltinRegistry();
for (const [name, value] of Object.entries(files)) {
  const content = `${JSON.stringify(value, null, 2)}\n`, path = new URL(name, directory);
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`PACKAGE_EXPORT_DRIFT:${name}`);
  } else writeFileSync(path, content);
}
console.log(process.argv.includes('--check') ? 'Package schemas/releases verified' : 'Package schemas/releases exported');
