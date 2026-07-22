import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, '../instances-db.ts'), 'utf-8');

describe('database management empty state', () => {
  it('keeps the create action and table headers outside the empty-row condition', () => {
    expect(source).not.toContain('if (this.instances.length === 0)');
    expect(source).toContain('class="btn-primary"');
    expect(source).toContain('<thead>');
    expect(source).toContain('<app-empty-state');
    expect(source).toContain('colspan="9"');
  });
});
