import { describe, expect, it } from 'vitest';
import { projectDatabaseLogForModel as project } from './database-log-egress.js';

describe('MAX-425 diagnostic-only log projection', () => {
  it.each([
    'password=canary425', 'PWD: canary425', 'clientSecret = canary425 with spaces',
    'x-api-key: canary425', 'subscription_key=canary425', 'unknownKey=canary425',
    'Authorization: Digest username="canary425", nonce="canary425"',
    'Cookie: sid=canary425; path=/', '{"nested":{"unknown":"canary425"}}',
    'mysql://root:canary425@private.example/db?token=canary425',
    'jdbc:postgresql://private.example/db?user=canary425&password=canary425',
    'User Id=canary425;Data Source=canary425;Password=canary425',
    'SELECT * FROM users WHERE name=\'canary425\'',
    'INSERT INTO users VALUES (\'canary425\', 998877665544)',
    'SELECT $$canary425$$, $tag$canary425$tag$',
    'SELECT $tag$canary425', "SELECT E'canary425\\\'more'",
    "SELECT N'canary425', q'[canary425]'", 'SELECT "canary425", `canary425`',
    'SELECT /* canary425 */ NULL -- canary425',
    'SELECT 0x63616e617279343235, 0b11010101',
    'unrecognised bare canary425 998877665544',
    'unrecognised %63%61%6e%61%72%79%34%32%35',
    'unrecognised Y2FuYXJ5NDI1 密码样本值',
    "unterminated 'canary425\ncanary425", 'Bearer canary425',
    'password=select deadlock MY-010584 SQLSTATE 23505',
  ])('removes synthetic values in %s', (input) => {
    const output = project(input);
    for (const secret of ['canary425', '998877665544', '63616e617279343235', '11010101',
      '%63%61%6e%61%72%79%34%32%35', 'Y2FuYXJ5NDI1', '密码样本值']) {
      expect(output).not.toContain(secret);
    }
    if (input.startsWith('password=select')) {
      expect(output).not.toMatch(/select|deadlock|MY-010584|23505/i);
    }
  });

  it('retains diagnostic codes, SQL structure, line boundaries and known patterns', () => {
    expect(project('MY-010584 connection refused\nORA-00060 deadlock detected\nSQLSTATE: 23505\nSELECT * FROM private_table WHERE private_column > 998877665544\nLOCK_TIMEOUT(warning)'))
      .toBe('MY-010584 connection refused\nORA-00060 deadlock detected\nSQLSTATE 23505\nSELECT * FROM [REDACTED] WHERE [REDACTED] > [REDACTED]\nLOCK_TIMEOUT(warning)');
  });

  it('retains PostgreSQL diagnostic headings without exempting embedded credentials', () => {
    const output = project('ERROR: deadlock detected\nDETAIL: connection refused password=canary425\nHINT: SELECT * FROM private_table');
    expect(output).toContain('ERROR deadlock detected');
    expect(output).toContain('DETAIL connection refused');
    expect(output).toContain('HINT SELECT * FROM');
    expect(output).not.toContain('canary425');
    expect(output).not.toContain('private_table');
  });

  it('removes a whole value before applying the display limit, including multi-line quoted values', () => {
    const input = `deadlock password='${'canary425 '.repeat(100)}'\nORA-00060`;
    const output = project(input, 500);
    expect(output).not.toContain('canary425');
    expect(output).toContain('ORA-00060');
    expect(output.length).toBeLessThanOrEqual(500);
    expect(project('a'.repeat(2000))).toBe('[REDACTED]');
    expect(project('')).toBe('');
  });
});
