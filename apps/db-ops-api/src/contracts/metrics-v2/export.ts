import { writeFileSync } from 'node:fs';
import { exportSchemas } from './schema.js';
import { definitions, resources, observations, rawObservation, profile, collectorPackage, collection, policy, metricBinding, capability, timeoutAttempt, derived, invalidExamples } from './fixtures.js';

const directory = new URL('../../../../../docs/slide/metrics-v2/contracts/', import.meta.url);
writeFileSync(new URL('schemas.json', directory), JSON.stringify(exportSchemas(), null, 2) + '\n');
writeFileSync(new URL('fixtures.json', directory), JSON.stringify({ contract_version: '1.0.0', synthetic: true, definitions, resources, observations, rawObservation, profile, collectorPackage, collection, policy, metricBinding, capability, timeoutAttempt, derived, invalidExamples }, null, 2) + '\n');
