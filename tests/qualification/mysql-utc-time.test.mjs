import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { mysqlUtcMilliseconds } from '../../scripts/qualification/mysql-utc-time.mjs';

const moduleUrl = new URL('../../scripts/qualification/mysql-utc-time.mjs', import.meta.url).href;
test('a UTC SQL recovery timestamp has the same instant in UTC and Asia/Shanghai processes', () => {
  const expected = Date.parse('2026-10-20T06:45:27.123Z');
  const code = `import { mysqlUtcMilliseconds } from ${JSON.stringify(moduleUrl)};
    console.log(mysqlUtcMilliseconds('2026-10-20 06:45:27.123'));`;
  for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], {encoding:'utf8',env:{...process.env,TZ}});
    assert.equal(Number(result.trim()), expected, TZ);
  }
});
test('preserves MySQL fractional seconds up to microsecond precision within the millisecond audit clock', () => {
  assert.equal(mysqlUtcMilliseconds('2026-10-20 06:45:27.123456'), Date.parse('2026-10-20T06:45:27.123Z'));
  assert.equal(mysqlUtcMilliseconds('2026-10-20 06:45:27'), Date.parse('2026-10-20T06:45:27Z'));
});
for (const value of [null, 0, '', '2026-10-20T06:45:27Z', '2026-10-20 06:45:27+08:00', '2026-02-30 06:45:27', '2026-10-20 25:45:27', '0000-00-00 00:00:00']) {
  test(`rejects malformed or non-MySQL UTC timestamp ${JSON.stringify(value)}`, () => {
    assert.throws(() => mysqlUtcMilliseconds(value), /MYSQL_UTC_TIMESTAMP_INVALID/);
  });
}
