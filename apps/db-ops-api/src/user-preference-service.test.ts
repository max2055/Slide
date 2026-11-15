import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), getPool: vi.fn(), getConnection: vi.fn(),
  transactionExecute: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(),
  rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
}));

vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: mocks.getPool } }));

import { DEFAULT_PREFERENCES, userPreferenceService } from './user-preference-service.js';

describe('user preference persistence (#626/#627)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getPool.mockReturnValue({ execute: mocks.execute, getConnection: mocks.getConnection });
    mocks.getConnection.mockResolvedValue({
      execute: mocks.transactionExecute, beginTransaction: mocks.beginTransaction,
      commit: mocks.commit, rollback: mocks.rollback, release: mocks.release, destroy: mocks.destroy,
    });
    mocks.transactionExecute.mockImplementation(async (sql: string) => sql.startsWith('SELECT')
      ? [[{ preferences: DEFAULT_PREFERENCES }], []] : [{ affectedRows: 1 }, []]);
  });
  afterEach(() => vi.restoreAllMocks());

  function saved() {
    const update = mocks.transactionExecute.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!;
    return JSON.parse(update[1][0]);
  }

  it('uses the approved text blue for new preference records', () => {
    expect(DEFAULT_PREFERENCES.accentColor).toBe('#265f99');
  });
  it('returns null when the user has no saved preferences', async () => {
    mocks.execute.mockResolvedValue([[], undefined]);
    await expect(userPreferenceService.getPreferences(7)).resolves.toBeNull();
  });
  it('does not synthesize defaults over a partial saved record', async () => {
    mocks.execute.mockResolvedValue([[{ preferences: '{"themeMode":"dark"}' }], undefined]);
    await expect(userPreferenceService.getPreferences(7)).resolves.toEqual({ themeMode: 'dark' });
  });
  it('persists defaults for a first partial save', async () => {
    await expect(userPreferenceService.savePreferences(7, { locale: 'zh-CN' })).resolves.toEqual({ success: true });
    expect(saved()).toEqual({ ...DEFAULT_PREFERENCES, locale: 'zh-CN' });
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('preserves saved values, explicit empty arrays and button palettes', async () => {
    mocks.transactionExecute.mockResolvedValueOnce([{}, []]).mockResolvedValueOnce([[{
      preferences: JSON.stringify({ themeMode: 'dark', visibleTabs: [], visibleTabsConfigured: true, navWidth: 300 }),
    }], []]).mockResolvedValueOnce([{}, []]);
    await expect(userPreferenceService.savePreferences(7, {
      accentColor: '#14b8a6', btnPalette: { primaryBg: '#14b8a6' },
    })).resolves.toEqual({ success: true });
    expect(saved()).toMatchObject({
      themeMode: 'dark', visibleTabs: [], visibleTabsConfigured: true, navWidth: 300,
      accentColor: '#14b8a6', btnPalette: { primaryBg: '#14b8a6' },
    });
  });
  it('#626 fails closed when reading existing preferences fails', async () => {
    mocks.transactionExecute.mockResolvedValueOnce([{}, []]).mockRejectedValueOnce(new Error('SELECT unavailable'));
    await expect(userPreferenceService.savePreferences(7, { locale: 'zh-CN' }))
      .resolves.toEqual({ success: false, error: 'SELECT unavailable' });
    expect(mocks.transactionExecute).toHaveBeenCalledTimes(2);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each(['{broken', 'null', '[]', '42', '"string"', null, []])('#626 rejects corrupt non-object data %j', async (preferences) => {
    mocks.transactionExecute.mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[{ preferences }], []]);
    await expect(userPreferenceService.savePreferences(7, { locale: 'zh-CN' }))
      .resolves.toEqual({ success: false, error: '用户偏好数据损坏：必须是 JSON 对象' });
    expect(mocks.transactionExecute).toHaveBeenCalledTimes(2);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('fails if the locked row cannot be read', async () => {
    mocks.transactionExecute.mockResolvedValueOnce([{}, []]).mockResolvedValueOnce([[], []]);
    expect((await userPreferenceService.savePreferences(7, {})).success).toBe(false);
    expect(mocks.rollback).toHaveBeenCalledOnce();
  });
  it.each(['beginTransaction', 'commit'] as const)('reports %s failure without retrying', async (stage) => {
    mocks[stage].mockRejectedValueOnce(new Error(stage));
    await expect(userPreferenceService.savePreferences(7, {})).resolves.toEqual({ success: false, error: stage });
    expect(mocks.getConnection).toHaveBeenCalledOnce();
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('rolls back a failed final update', async () => {
    mocks.transactionExecute.mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[{ preferences: {} }], []]).mockRejectedValueOnce(new Error('UPDATE failed'));
    expect((await userPreferenceService.savePreferences(7, {})).success).toBe(false);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('destroys a connection when rollback fails and retains the original error', async () => {
    mocks.transactionExecute.mockRejectedValueOnce(new Error('original failure'));
    mocks.rollback.mockRejectedValueOnce(new Error('rollback failure'));
    await expect(userPreferenceService.savePreferences(7, {}))
      .resolves.toEqual({ success: false, error: 'original failure' });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('returns failure when no pool or connection is available', async () => {
    mocks.getPool.mockReturnValueOnce(null);
    expect((await userPreferenceService.savePreferences(7, {})).success).toBe(false);
    mocks.getConnection.mockRejectedValueOnce(new Error('pool exhausted'));
    expect((await userPreferenceService.savePreferences(7, {})).success).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('#627 retries a deadlock only after rollback and releases each checked-out connection', async () => {
    mocks.transactionExecute.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }));
    expect(await userPreferenceService.savePreferences(7, { navWidth: 400 })).toEqual({ success: true });
    expect(saved().navWidth).toBe(400);
    expect(mocks.rollback).toHaveBeenCalledOnce();
    expect(mocks.getConnection).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
  it('bounds deadlock attempts to three and does not retry rollback failure', async () => {
    mocks.transactionExecute.mockRejectedValue(Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }));
    expect((await userPreferenceService.savePreferences(7, {})).success).toBe(false);
    expect(mocks.getConnection).toHaveBeenCalledTimes(3);
    expect(mocks.rollback).toHaveBeenCalledTimes(3);
    expect(mocks.release).toHaveBeenCalledTimes(3);
    mocks.getConnection.mockClear();
    mocks.rollback.mockRejectedValueOnce(new Error('rollback failed'));
    expect((await userPreferenceService.savePreferences(7, {})).success).toBe(false);
    expect(mocks.getConnection).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
