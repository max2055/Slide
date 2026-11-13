import { describe, expect, it, vi } from 'vitest';

vi.mock('../db-connection.js', () => ({
  dbConnection: { getPool: () => null },
  encryptData: (value: string) => `cipher:${value}`,
  decryptData: (value: string) => value.replace(/^cipher:/, ''),
}));

import { CONFIG_BACKUP_DIFF_MAX_BYTES, ConfigBackupService, type ConfigBackupStore } from './config-backup-service.js';

function fixture(left: string, right: string, legacy = false) {
  const find = vi.fn(async (deviceId: number, id: number) => deviceId !== 7 || ![9, 10].includes(id) ? null : ({
    id, deviceId, versionNo: id - 8, contentEncrypted: `cipher:${id === 9 ? left : right}`,
    contentSha256: 'a'.repeat(64), sourceProtocol: 'ssh' as const,
    collectedAt: '2026-11-13T00:00:00Z', sizeBytes: Buffer.byteLength(id === 9 ? left : right),
    redactionStatus: 'unredacted' as const,
  }));
  const store: ConfigBackupStore = { find };
  const service = legacy
    ? new ConfigBackupService(store, { collect: vi.fn() })
    : new ConfigBackupService({ deviceService: { getDeviceById: vi.fn(), getCredentials: vi.fn() }, store, audit: vi.fn() });
  return { service, find };
}

describe('MAX-605 / #537 ordered configuration diff', () => {
  it.each([
    ['duplicate deletion', 'a\na\nb', 'a\nb', '-a'],
    ['duplicate insertion', 'a\nb', 'a\na\nb', '+a'],
    ['reordering', 'a\nb', 'b\na', '-a\n+a'],
    ['duplicate reordering', 'a\nb\na', 'a\na\nb', '-b\n+b'],
    ['ordinary replacement', 'header\nold\ntail', 'header\nnew\ntail', '-old\n+new'],
    ['interleaved edits', 'a\nx\nb\ny\nc', 'a\nu\nb\nv\nc', '-x\n+u\n-y\n+v'],
    ['identical', 'a\na\nb', 'a\na\nb', ''],
    ['empty', '', '', ''],
    ['blank line', 'a\n\nb', 'a\nb', '-'],
    ['trailing newline', 'a\n', 'a', '-'],
    ['CRLF normalization', 'a\r\nb\r\n', 'a\nb\n', ''],
    ['indentation', ' description uplink', '  description uplink', '- description uplink\n+  description uplink'],
    ['Unicode', '接口一\n接口一', '接口一', '-接口一'],
  ])('%s', async (_name, left, right, expected) => {
    const { service, find } = fixture(left, right);
    expect(await service.diff(7, 9, 10)).toEqual({ fromId: 9, toId: 10, diff: expected });
    expect(find.mock.calls).toEqual([[7, 9], [7, 10]]);
  });

  it('retains legacy success, missing-backup and single-id response shapes', async () => {
    const { service } = fixture('a\na\nb', 'a\nb', true);
    expect(await service.diff(7, 9, 10)).toEqual({ success: true, fromId: 9, toId: 10, diff: '-a' });
    expect(await service.diff(7, 9)).toEqual({ success: true, fromId: 9, toId: 9, diff: '' });
    expect(await service.diff(7, 9, 11)).toEqual({ success: false, error: 'CONFIG_BACKUP_NOT_FOUND' });
    await expect(fixture('', '').service.diff(8, 9, 10)).rejects.toMatchObject({ code: 'CONFIG_BACKUP_NOT_FOUND' });
  });

  it('diffs redacted previews without returning raw content, ciphertext or secrets', async () => {
    const { service } = fixture('a\npassword OldSecret\npassword OldSecret\nb', 'a\npassword NewSecret\nb');
    const get = vi.spyOn(service, 'get');
    const result = await service.diff(7, 9, 10);
    expect(result.diff).toBe('-password <redacted>');
    expect(get.mock.calls).toEqual([[7, 9, false], [7, 10, false]]);
    expect(JSON.stringify(result)).not.toMatch(/OldSecret|NewSecret|cipher:|contentEncrypted/);
    expect((await fixture('password OldSecret', 'password NewSecret').service.diff(7, 9, 10)).diff).toBe('');
  });

  it('retains the 64 Ki character preview boundary', async () => {
    const prefix = 'x'.repeat(64 * 1024);
    expect((await fixture(`${prefix}old`, `${prefix}new`).service.diff(7, 9, 10)).diff).toBe('');
    expect((await fixture(`${prefix.slice(1)}a`, `${prefix.slice(1)}b`).service.diff(7, 9, 10)).diff).not.toBe('');
  });

  it.each([false, true])('preserves the UTF-8 input limit in legacy=%s mode', async legacy => {
    const { service } = fixture('', '', legacy);
    const preview = '界'.repeat(Math.floor(CONFIG_BACKUP_DIFF_MAX_BYTES / 3)) + 'xx';
    expect(Buffer.byteLength(preview)).toBe(CONFIG_BACKUP_DIFF_MAX_BYTES);
    const get = vi.spyOn(service, 'get').mockResolvedValue({ preview } as any);
    expect((await service.diff(7, 9, 10)).diff).toBe('');
    for (const side of [0, 1]) {
      get.mockReset().mockResolvedValueOnce({ preview: preview + (side === 0 ? 'x' : '') } as any)
        .mockResolvedValueOnce({ preview: preview + (side === 1 ? 'x' : '') } as any);
      if (legacy) expect(await service.diff(7, 9, 10)).toEqual({ success: false, error: 'CONFIG_BACKUP_DIFF_LIMIT' });
      else await expect(service.diff(7, 9, 10)).rejects.toMatchObject({ code: 'CONFIG_BACKUP_DIFF_LIMIT' });
    }
  });

  it('handles many identical short lines and a single deletion without a quadratic table', async () => {
    const left = 'a\n'.repeat(32_000);
    expect((await fixture(left, left).service.diff(7, 9, 10)).diff).toBe('');
    expect((await fixture(left, left.slice(2)).service.diff(7, 9, 10)).diff).toBe('-a');
  });

  it('shows a bounded complete replacement for a large changed region', async () => {
    const left = Array(16_000).fill('a').join('\n');
    const right = Array(16_000).fill('b').join('\n');
    const result = await fixture(`same\n${left}\ntail`, `same\n${right}\ntail`).service.diff(7, 9, 10);
    expect(result.diff.split('\n')).toEqual([...Array(16_000).fill('-a'), ...Array(16_000).fill('+b')]);
    expect(result.diff).not.toContain('same');
    expect(result.diff).not.toContain('tail');
  });

  it('matches an independent edit-distance oracle for all short binary sequences', async () => {
    const sequences: string[][] = [];
    for (let length = 1; length <= 4; length++) {
      for (let mask = 0; mask < 2 ** length; mask++) sequences.push(Array.from({ length }, (_, i) => (mask >> i) & 1 ? 'a' : 'b'));
    }
    for (const before of sequences) for (const after of sequences) {
      // Insert/delete edit distance; substitution costs two operations.
      let previous = Array.from({ length: after.length + 1 }, (_, i) => i);
      for (let i = 1; i <= before.length; i++) {
        const current = [i];
        for (let j = 1; j <= after.length; j++) current[j] = before[i - 1] === after[j - 1]
          ? previous[j - 1] : Math.min(previous[j] + 1, current[j - 1] + 1);
        previous = current;
      }
      const result = await fixture(before.join('\n'), after.join('\n')).service.diff(7, 9, 10);
      expect(result.diff === '' ? 0 : result.diff.split('\n').length).toBe(previous[after.length]);
    }
  });
});
