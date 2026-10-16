import { expect, it } from 'vitest';
import { primaryFill } from './btn-palette.ts';

it.each(['#409eff', '#14b8a6', '#ffffff', '#ffff00', '#6366f1', '#000000'])('keeps white labels readable for accent %s', accent => {
  const fill = primaryFill(accent);
  const channels = [1, 3, 5].map(start => parseInt(fill.slice(start, start + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
});
