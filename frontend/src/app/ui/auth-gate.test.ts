import { describe, expect, it } from 'vitest';
import { shouldRenderLoginGate } from './auth-gate.ts';

describe('authentication gate', () => {
  it('keeps the application mounted while a persisted JWT reconnects', () => {
    expect(shouldRenderLoginGate(false, 'stored-jwt')).toBe(false);
  });

  it('shows login only when disconnected without an authenticated session', () => {
    expect(shouldRenderLoginGate(false, null)).toBe(true);
    expect(shouldRenderLoginGate(false, '   ')).toBe(true);
    expect(shouldRenderLoginGate(true, null)).toBe(false);
  });
});
