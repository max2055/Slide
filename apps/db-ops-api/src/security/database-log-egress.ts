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
// Only the literal scanner can produce a quoted mask from a complete value.
const QUOTED_MASK = '"[REDACTED]"';
const NATIVE_ERROR_HEADER = /^[ \t]*(?:(?:ORA-\d{5}|MY-\d{6})|ERROR[ \t]+[1-9]\d{3,4}[ \t]+\([A-Z0-9]{5}\))[ \t]*:/i;
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*([=:])[ \t]*([^\r\n]*)/;

// Scan contexts together: a quote/dollar marker inside an Oracle literal (or
// vice versa) must never terminate another context and expose its payload.
function maskLogLiterals(value: string): string {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < value.length) {
    let end: number | undefined;
    let replacement = MASK;
    const oracle = (index === 0 || !/[A-Za-z0-9_$]/.test(value[index - 1]))
      ? /^(?:nq|q)'/i.exec(value.slice(index, index + 3)) : null;
    const dollar = value[index] === '$' ? /^(?:\$\$|\$[A-Za-z_][A-Za-z_0-9]*\$)/.exec(value.slice(index)) : null;
    const quote = value[index];
    if (value.startsWith('/*', index)) {
      const close = value.indexOf('*/', index + 2);
      end = close < 0 ? value.length : close + 2;
    } else if (value.startsWith('--', index) || quote === '#') {
      const lineEnd = value.slice(index).search(/[\r\n]/);
      end = lineEnd < 0 ? value.length : index + lineEnd;
    } else if (oracle) {
      const point = value.codePointAt(index + oracle[0].length);
      const open = point === undefined ? '' : String.fromCodePoint(point);
      const close = ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
      const terminator = open && !/\s/.test(open)
        ? value.indexOf(`${close}'`, index + oracle[0].length + open.length) : -1;
      // Missing/invalid delimiters fail closed through the end of the input.
      end = terminator < 0 ? value.length : terminator + close.length + 1;
    } else if (dollar) {
      const close = value.indexOf(dollar[0], index + dollar[0].length);
      end = close < 0 ? value.length : close + dollar[0].length;
    } else if (quote === "'" || quote === '"' || quote === '`') {
      end = index + 1;
      while (end < value.length) {
        if (value[end] === '\\') end += 2;
        else if (value[end] !== quote) end++;
        else if (value[end + 1] === quote) end += 2;
        else {
          if (quote !== '`') replacement = QUOTED_MASK;
          end++;
          break;
        }
      }
      end = Math.min(end, value.length);
    }
    if (end === undefined) { index++; continue; }
    parts.push(value.slice(start, index), replacement);
    start = index = end;
  }
  parts.push(value.slice(start));
  return parts.join('');
}

function projectVocabulary(text: string): string {
  return text.replaceAll(QUOTED_MASK, MASK)
    .replace(/\b(?:MY-\d{6}|ORA-\d{5})\b|\bSQLSTATE[ \t]+[A-Z0-9]{5}\b|[A-Za-z_][A-Za-z0-9_.@$%+-]*|\d+(?:\.\d+)?|\s+|./gi,
      (token) => {
        if (/^(?:MY-\d{6}|ORA-\d{5}|SQLSTATE[ \t]+[A-Z0-9]{5})$/i.test(token)) return token.toUpperCase();
        if (DIAGNOSTIC_WORDS.has(token.toLowerCase())) return token;
        if (/^(?:\s+|[()[\]{},;:*<>=+./-])$/.test(token)) return token;
        return MASK;
      });
}

function projectLogLine(line: string, splitQuotedField = true): string {
  const header = NATIVE_ERROR_HEADER.exec(line)?.[0] ?? '';
  const text = header ? line.slice(header.length)
    : line.replace(/^([ \t]*(?:ERROR|WARNING|DETAIL|HINT|CONTEXT|NOTE|FATAL|PANIC))[ \t]*:[ \t]*/i, '$1 ');
  const assignment = ASSIGNMENT.exec(text);
  if (!assignment) return header.toUpperCase() + projectVocabulary(text);

  const [, key, separator, value] = assignment;
  const prefix = header.toUpperCase() + projectVocabulary(text.slice(0, assignment.index));
  if (key.toLowerCase() === 'sqlstate' && /^[A-Z0-9]{5}$/i.test(value.trim())) {
    return prefix + 'SQLSTATE ' + value.trim().toUpperCase();
  }

  const masked = prefix + projectVocabulary(key + separator + MASK);
  // Each assignment must have a complete quoted value and explicit separator.
  // Semicolons alone can also separate DSN attributes.
  const boundary = splitQuotedField && separator === '=' && /^"\[REDACTED\]"[ \t]*([;|])[ \t]+/.exec(value);
  if (!boundary) return masked;

  const parts = [masked];
  let delimiter = boundary[1];
  let offset = boundary[0].length;
  const nextField = /([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*"\[REDACTED\]"[ \t]*([;|])[ \t]+/y;
  nextField.lastIndex = offset;
  for (let field = nextField.exec(value); field; field = nextField.exec(value)) {
    parts.push(delimiter === ';' ? '; ' : ' | ', projectVocabulary(field[1] + '=' + MASK));
    delimiter = field[2];
    offset = nextField.lastIndex;
  }

  const diagnostic = value.slice(offset);
  const standaloneCode = /^(?:ORA-\d{5}|MY-\d{6})[ \t]*$/i.test(diagnostic);
  const standaloneState = delimiter === '|' && /^SQLSTATE(?:[ \t]+|[ \t]*[=:][ \t]*)[A-Z0-9]{5}[ \t]*$/i.test(diagnostic);
  if (standaloneCode || standaloneState || NATIVE_ERROR_HEADER.test(diagnostic)) {
    parts.push(delimiter === ';' ? '; ' : ' | ', projectLogLine(diagnostic, false));
    return parts.join('');
  }
  return masked;
}

/** Sanitize before limiting output, so a cutoff cannot expose a partial value. */
export function projectDatabaseLogForModel(value: string, maxLength = 2000): string {
  const safe = maskLogLiterals(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, MASK)
    // Bearer credentials can match diagnostic words. Consume the entire line
    // before inspecting diagnostic fields, including whitespace variants.
    .replace(/\bBearer\s+[^\r\n]*/gi, MASK)
    .replace(/[^\r\n]+/g, (line) => projectLogLine(line));
  // Adjacent masked tokens have no diagnostic value. Bound only the projection.
  return safe.replace(/(?:\[REDACTED\][ \t]*){2,}/g, MASK).slice(0, maxLength);
}
