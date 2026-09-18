import { readFileSync, writeFileSync } from 'node:fs';
import { createDatabaseRegistry, databaseReleases } from './catalog.js';
const path = new URL('../../../../../docs/slide/metrics-v2/database/releases.json', import.meta.url);
createDatabaseRegistry();
const content = `${JSON.stringify(databaseReleases(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== content) throw new Error('DATABASE_RELEASE_DRIFT');
} else writeFileSync(path, content);
console.log('Database package contracts validated');
