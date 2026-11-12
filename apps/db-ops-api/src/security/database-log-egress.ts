/**
 * Database logs are untrusted free text. Export a diagnostic vocabulary, never
 * arbitrary identifiers/values. A credential-key blacklist cannot define this
 * boundary: unknown keys, encodings and SQL dialects must also lose their data.
 * Keep this policy local to log analysis; stored audit logs are not rewritten.
 */
const DIAGNOSTIC_WORDS = new Set(`
  error warning critical info fatal panic note
  mysql postgresql postgres oracle innodb redis mongodb elasticsearch
  connection connections connect refused timeout timed out too many
  authentication access denied failed failure aborted terminated unavailable
  deadlock detected lock wait waiting transaction rollback rolled back commit
  out of memory oom disk full no space left device table tablespace
  replication replica master slave stopped broken server shutdown starting
  crash recovery corrupted corruption checkpoint redo undo log buffer pool
  read write io latency temp temporary file files permission does not exist
  duplicate key constraint violation syntax near at line detail hint context
  select insert into update delete from where and or set values join on
  left right inner outer group by order having limit offset returning
  begin end create alter drop table index database null is in as for
  sqlstate error_code errno code
  transaction_rollback deadlock temp_file_spike io_latency out_of_memory
  disk_full table_full connection_error too_many_connections replication_error
  lock_timeout auth_failure mysql_slow mysql_error pg_log other
  redacted
`.trim().split(/\s+/));

const MASK = '[REDACTED]';

/** Sanitize before limiting output, so a cutoff cannot expose a partial value. */
export function projectDatabaseLogForModel(value: string, maxLength = 2000): string {
  // Quotes include SQL escaped/doubled delimiters and unterminated values.
  // Dollar quotes cover PostgreSQL bodies, which can contain arbitrary quotes.
  let safe = value.replace(/\$([A-Za-z_][A-Za-z_0-9]*|)\$[\s\S]*?(?:\$\1\$|$)/g, MASK)
    .replace(/'(?:\\[\s\S]|''|[^'\\])*(?:'|$)|"(?:\\[\s\S]|""|[^"\\])*(?:"|$)|`(?:``|[^`])*(?:`|$)/g, MASK)
    .replace(/\/\*[\s\S]*?(?:\*\/|$)|--[^\r\n]*|#[^\r\n]*/g, MASK)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, MASK);

  // PostgreSQL-style severity/detail headings are diagnostic structure, not
  // arbitrary assignments. Their content still passes through every filter.
  safe = safe.replace(/^([ \t]*(?:ERROR|WARNING|DETAIL|HINT|CONTEXT|NOTE|FATAL|PANIC))[ \t]*:[ \t]*/gim, '$1 ');

  // All assignments/headers are private by default, including unknown key
  // names and spaced values. Only an exact SQLSTATE diagnostic is exempt.
  safe = safe.replace(/\b([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*([=:])[ \t]*([^\r\n]*)/g,
    (_match, key: string, separator: string, data: string) => {
      if (key.toLowerCase() === 'sqlstate' && /^[A-Z0-9]{5}$/i.test(data.trim())) {
        return `SQLSTATE ${data.trim().toUpperCase()}`;
      }
      return `${key}${separator}${MASK}`;
    });

  safe = safe.replace(/\b(?:MY-\d{6}|ORA-\d{5})\b|\bSQLSTATE[ \t]+[A-Z0-9]{5}\b|[A-Za-z_][A-Za-z0-9_.@$%+-]*|\d+(?:\.\d+)?|\s+|./gi,
    (token) => {
      if (/^(?:MY-\d{6}|ORA-\d{5}|SQLSTATE[ \t]+[A-Z0-9]{5})$/i.test(token)) return token.toUpperCase();
      if (DIAGNOSTIC_WORDS.has(token.toLowerCase())) return token;
      if (/^(?:\s+|[()[\]{},;:*<>=+./-])$/.test(token)) return token;
      return MASK;
    });
  // Adjacent masked tokens have no diagnostic value. Bound only the projection.
  return safe.replace(/(?:\[REDACTED\][ \t]*){2,}/g, MASK).slice(0, maxLength);
}
