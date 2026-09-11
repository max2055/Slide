import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));

describe('production runtime dependencies', () => {
  it('ships TypeScript for source snapshot AST parsing', () => {
    const packageJson = JSON.parse(readFileSync(`${apiRoot}/package.json`, 'utf8'));
    const source = readFileSync(`${apiRoot}/src/platform/source-snapshot-service.ts`, 'utf8');

    expect(source).toContain("from 'typescript'");
    expect(packageJson.dependencies?.typescript).toBeTruthy();
  });
});
