import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const roots = [path.join(root, 'apps/db-ops-api/src'), path.join(root, 'apps/db-ops-api/server.ts'), path.join(root, 'frontend/src')];
const violations: string[] = [];
const patterns = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT literal', pattern: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{16,}/ },
  { name: 'Bearer literal', pattern: /Bearer\s+[a-zA-Z0-9._~+/=-]{24,}/ },
  { name: 'API key literal', pattern: /\bsk-(?:ant-|proj-)?[a-zA-Z0-9_-]{20,}/ },
];

async function scan(target: string): Promise<void> {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      if (entry.includes('.test.') || entry === '__tests__' || entry === 'generated') continue;
      await scan(path.join(target, entry));
    }
    return;
  }
  if (!/\.(?:ts|js|html)$/.test(target)) return;
  const content = await fs.readFile(target, 'utf8');
  for (const check of patterns) {
    if (check.pattern.test(content)) violations.push(`${path.relative(root, target)}: ${check.name}`);
  }
}

for (const target of roots) await scan(target);
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('security secret scan passed');
