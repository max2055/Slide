import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { BindingChangeSchema, GroupChangeSchema, OverridesSchema } from './model.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { resolvePolicy } from './resolver.js';
import { at, binding, resource, capabilities, pin } from './test-support.js';

const directory = new URL('../../../../../docs/slide/metrics-v2/policy/', import.meta.url);
const documents = {
  'schemas.json': { BindingChange: z.toJSONSchema(BindingChangeSchema), GroupChange: z.toJSONSchema(GroupChangeSchema), Overrides: z.toJSONSchema(OverridesSchema) },
  'fixtures.json': { synthetic: true, at, resource: resource(), capabilities: capabilities(),
    initial_request: { expected_revision: 0, package: pin },
    result: resolvePolicy(createBuiltinRegistry(), binding(), null, resource(), capabilities(), at),
  },
};
for (const [name, document] of Object.entries(documents)) {
  const path = new URL(name, directory), expected = JSON.stringify(document, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== expected) throw new Error(`POLICY_ARTIFACT_DRIFT:${name}`);
  } else writeFileSync(path, expected);
}
