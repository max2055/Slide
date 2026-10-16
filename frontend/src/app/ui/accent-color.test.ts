import { describe, expect, it } from 'vitest';
import { accentForeground } from './accent-color.ts';
import { applyAccentColor } from './app-settings.ts';
import { DEFAULT_PALETTE } from './btn-palette.ts';

describe('accent text and filled-control contrast', () => {
  it('does not darken the default twice and clears its text override for a custom color', () => {
    applyAccentColor('#265F99');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--accent-text-light')).toBe('#265f99');
    expect(style.getPropertyValue('--accent-foreground')).toBe('#ffffff');
    applyAccentColor('#409eff');
    expect(style.getPropertyValue('--accent-text-light')).toContain('60%, black');
    expect(style.getPropertyValue('--accent')).toBe('#409eff');
    expect(style.getPropertyValue('--accent-foreground')).toBe('#000000');
    applyAccentColor('#265f99');
    expect(style.getPropertyValue('--accent-text-light')).toBe('#265f99');
  });

  it('uses a white default palette foreground and adapts custom accent controls', () => {
    expect(DEFAULT_PALETTE.primaryBg).toBe('#265f99');
    expect(DEFAULT_PALETTE.primaryColor).toBe('#ffffff');
    expect(accentForeground('#14b8a6')).toBe('#000000');
    expect(accentForeground('#123456')).toBe('#ffffff');
  });
});
