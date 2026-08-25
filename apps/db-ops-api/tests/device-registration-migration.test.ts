import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadMigrations, isMigrationChecksumAccepted } from '../src/migrations/runner.js';

const migrationUrl = new URL('../sql/migrations/067_device_registrations.sql', import.meta.url);

describe('device registration migration comments', () => {
  it('defines comments for the table and every column', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain("COMMENT='设备身份注册与配对记录'");
    for (const column of [
      'id', 'user_id', 'device_id', 'public_key', 'status', 'paired_by',
      'challenge_hash', 'challenge_expires_at', 'last_seen_at', 'created_at', 'updated_at',
    ]) {
      const definition = sql.split('\n').find((line) => new RegExp(`^\\s*${column}\\b`).test(line));
      expect(definition, `${column} definition`).toBeDefined();
      expect(definition).toContain('COMMENT');
    }
  });

  it('keeps the already-applied pre-comment 067 checksum compatible', () => {
    expect(isMigrationChecksumAccepted(
      '067_device_registrations.sql',
      '94403810bcae74f546a719b6d2f062e1699c18440e2ad76a5c787fa3f2c10ebb',
      'new-checksum',
    )).toBe(true);
    expect(isMigrationChecksumAccepted('067_device_registrations.sql', 'unexpected', 'new-checksum')).toBe(false);
  });

  it('ships a forward parity migration after 067', async () => {
    const migrations = await loadMigrations();
    const original = migrations.find((migration) => migration.id === '067_device_registrations.sql');
    const parity = migrations.find((migration) => migration.id === '069_device_registration_comment_parity.sql');
    expect(original).toBeDefined();
    expect(parity).toBeDefined();
    expect(parity!.id > original!.id).toBe(true);
    expect(parity!.sql).toContain('ALTER TABLE device_registrations');
    expect(parity!.sql).toContain('MODIFY COLUMN updated_at');
  });
});
