/** MySQL dateStrings timestamps captured after SET time_zone='+00:00'.
 * Keep the SQL/native value intact; only interpret its instant for audit bounds.
 */
export function mysqlUtcMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)) {
    throw new Error('MYSQL_UTC_TIMESTAMP_INVALID');
  }
  const canonical = value.replace(' ', 'T');
  const milliseconds = Date.parse(canonical + 'Z');
  // Date.parse normalizes some invalid calendar dates; reject those as evidence.
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== canonical.slice(0, 19)) {
    throw new Error('MYSQL_UTC_TIMESTAMP_INVALID');
  }
  return milliseconds;
}
