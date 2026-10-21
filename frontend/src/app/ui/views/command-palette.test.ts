import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { getPaletteItems, renderCommandPalette, type CommandPaletteProps } from './command-palette.ts';

afterEach(() => document.body.replaceChildren());
it('offers only authorized product destinations and respects configured navigation', () => {
  expect(getPaletteItems()).toEqual([]);
  const limited = getPaletteItems(new Set(['alert:view']));
  expect(limited.map(item => item.action)).toEqual(['nav:attention', 'nav:events', 'nav:settings']);
  expect(getPaletteItems(new Set(['*']), ['servers']).map(item => item.label)).toEqual(['服务器']);
  const all = getPaletteItems(new Set(['*']));
  expect(all.every(item => item.action.startsWith('nav:'))).toBe(true);
  expect(JSON.stringify(all)).not.toMatch(/discord|telegram|host.shell|\/skill|\/verbose/i);
  expect(all.find(item => item.action === 'nav:sql-console')?.description).toContain('审批');
});
it('searches Chinese labels, selects by keyboard, and cannot select a revoked destination', () => {
  const props: CommandPaletteProps = { open: true, permissions: new Set(['servers:view']), query: '服务器', activeIndex: 0,
    onToggle: vi.fn(), onQueryChange: vi.fn(), onActiveIndexChange: vi.fn(), onNavigate: vi.fn(), onSlashCommand: vi.fn() };
  render(renderCommandPalette(props), document.body);
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(props.onNavigate).toHaveBeenCalledWith('servers');
  props.permissions = new Set();
  document.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(props.onNavigate).toHaveBeenCalledTimes(1); expect(props.onSlashCommand).not.toHaveBeenCalled();
});
