import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock('./db-connection.js', () => ({
  dbConnection: { getPool: mocks.getPool },
}));

import { DEFAULT_PREFERENCES, userPreferenceService } from './user-preference-service.js';

describe('user preference persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPool.mockReturnValue({ execute: mocks.execute });
  });

  it('uses the approved text blue for new preference records', () => {
    expect(DEFAULT_PREFERENCES.accentColor).toBe('#265f99');
  });

  it('returns null when the user has no saved preferences', async () => {
    mocks.execute.mockResolvedValue([[], undefined]);

    await expect(userPreferenceService.getPreferences(7)).resolves.toBeNull();
  });

  it('does not synthesize default blue over a partial saved record', async () => {
    mocks.execute.mockResolvedValue([[{ preferences: JSON.stringify({ themeMode: 'dark' }) }], undefined]);

    await expect(userPreferenceService.getPreferences(7)).resolves.toEqual({ themeMode: 'dark' });
  });

  it('persists the new default for a first partial save', async () => {
    mocks.execute.mockResolvedValueOnce([[], undefined]).mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);
    await expect(userPreferenceService.savePreferences(7, { locale: 'zh-CN' })).resolves.toEqual({ success: true });
    expect(JSON.parse(mocks.execute.mock.calls[1][1][1]).accentColor).toBe('#265f99');
  });

  it('stores accent and button palette preferences', async () => {
    mocks.execute
      .mockResolvedValueOnce([[], undefined])
      .mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);

    await expect(userPreferenceService.savePreferences(7, {
      accentColor: '#14b8a6',
      btnPalette: { primaryBg: '#14b8a6' },
    })).resolves.toEqual({ success: true });

    const persisted = JSON.parse(mocks.execute.mock.calls[1][1][1]);
    expect(persisted).toMatchObject({
      accentColor: '#14b8a6',
      btnPalette: { primaryBg: '#14b8a6' },
    });
  });
});
