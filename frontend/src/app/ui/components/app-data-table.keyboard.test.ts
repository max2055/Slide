import { afterEach, expect, it, vi } from 'vitest';
import { AppDataTable } from './app-data-table.ts';

afterEach(() => document.body.replaceChildren());

it('keeps sort controls separate from help and exposes only the active sort', async () => {
  const table = new AppDataTable();
  table.columns = [{ key: 'name', label: '名称', sortable: true, help: '资源名称' }, { key: 'size', label: '大小', sortable: true }, { key: 'state', label: '状态' }];
  table.rows = [{ name: 'one', size: 1, state: 'ok' }];
  document.body.append(table); await table.updateComplete;
  const sort = vi.fn(), help = vi.fn();
  table.addEventListener('app-table-sort', sort); table.addEventListener('app-table-column-help', help);
  const headers = table.querySelectorAll('th');
  expect(headers[0].getAttribute('role')).not.toBe('columnheader button');
  const buttons = table.querySelectorAll<HTMLButtonElement>('button.table-sort');
  expect(buttons).toHaveLength(2);
  expect(buttons[0].textContent?.trim()).toBe('名称');
  expect(buttons[0].type).toBe('button');
  buttons[0].click(); await table.updateComplete;
  expect(sort.mock.calls[0][0].detail).toEqual({ key: 'name', direction: 'asc' });
  expect(headers[0].getAttribute('aria-sort')).toBe('ascending');
  table.querySelector<HTMLButtonElement>('.column-help')!.click();
  expect(help).toHaveBeenCalledTimes(1); expect(sort).toHaveBeenCalledTimes(1);
  buttons[0].click(); await table.updateComplete;
  expect(headers[0].getAttribute('aria-sort')).toBe('descending');
  buttons[1].click(); await table.updateComplete;
  expect(headers[0].hasAttribute('aria-sort')).toBe(false);
  expect(headers[1].getAttribute('aria-sort')).toBe('ascending');
  headers[2].click(); expect(sort).toHaveBeenCalledTimes(3);
  table.loading = true; await table.updateComplete;
  buttons[0].click(); await table.updateComplete;
  expect(sort).toHaveBeenCalledTimes(4); // Preserve existing loading/mouse behavior.
  table.columns = [{ key: 'name', label: '名称', sortable: false }]; await table.updateComplete;
  expect(table.querySelector('button.table-sort')).toBeNull();
  expect(table.querySelector('th')!.hasAttribute('aria-sort')).toBe(false);
});
