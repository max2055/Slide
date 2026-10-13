import { expect, it } from 'vitest';
import { sortAttentionItems } from './investigations.ts';
it('orders a bounded attention set by severity, newest time, then stable ID without mutation', () => {
  const items = [{ id: 'z', title: '', severity: 'warning', status: 'open', updated_at: '2026-10-13' },
    { id: 'b', title: '', severity: 'critical', status: 'open', updated_at: '2026-10-12' },
    { id: 'a', title: '', severity: 'critical', status: 'open', updated_at: '2026-10-12' }];
  expect(sortAttentionItems(items).map(i => i.id)).toEqual(['a', 'b', 'z']);
  expect(items[0].id).toBe('z');
});
