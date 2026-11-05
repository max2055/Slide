import { redactSqlEvidence } from './analysis/evidence-sql-redaction.js';
import { redactSensitiveText } from './security/log-redaction.js';

export type DatabaseLogDialect = 'mysql' | 'postgresql' | 'oracle' | 'dameng';

export function databaseLogDialect(source: string): DatabaseLogDialect | undefined {
  if (source.startsWith('mysql_')) return 'mysql';
  if (source === 'pg_log') return 'postgresql';
  return undefined;
}

const SQL_START = /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|EXEC(?:UTE)?|SET|EXPLAIN|SHOW|PRAGMA|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|USE|VACUUM|ATTACH|DETACH|ANALYZE|DESCRIBE|DECLARE|DO|COPY|START|LOCK|UNLOCK)\b/ig;
const CREDENTIAL_ASSIGNMENT = /\b((?:password|passwd|pwd|secret|token|api[_-]?key|authorization|user(?:name)?|uid|user\s+id)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const CONNECTION_URI = /\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi;
const SINGLE_QUOTED_VALUE = /'(?:''|\\.|[^'\\])*'/g;
const DOUBLE_QUOTED_VALUE = /"(?:""|\\.|[^"\\])*"/g;
const SENSITIVE_FIELD_SUFFIXES = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'authorization', 'apikey',
  'credential', 'privatekey', 'connectionstring', 'connectionurl', 'connectionuri',
  'dsn', 'username', 'user', 'uid',
];
const SQL_FIELD = /^(?:raw)?(?:sql|query|statement|stmt|command)(?:text|value)?$/;
const SQL_LABEL = /\b(?:sql|query|statement|stmt|command)\s*[:=]\s*/i;
const SQL_OMITTED = '[SQL 已省略：无法安全脱敏]';

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveField(value: string): boolean {
  const normalized = normalizedFieldName(value);
  return SENSITIVE_FIELD_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function isSqlField(value: string): boolean {
  return SQL_FIELD.test(normalizedFieldName(value));
}

function redactExplicitSql(value: string, dialect?: DatabaseLogDialect): { text: string; gaps: string[] } {
  const redacted = dialect ? redactSqlEvidence(value, dialect) : null;
  return redacted === null
    ? { text: SQL_OMITTED, gaps: ['SQL_REDACTION_UNAVAILABLE'] }
    : { text: redacted, gaps: [] };
}

function hasSqlContext(value: string, start: number): boolean {
  const prefix = value.slice(0, start);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const linePrefix = prefix.slice(lineStart);
  return linePrefix.trim() === ''
    || /\b(?:sql|query|statement|stmt|command|near)\b["']?\s*[:=]?\s*["']?\s*$/i.test(prefix)
    || /;\s*$/.test(prefix);
}

function hasSqlShape(keyword: string, suffix: string): boolean {
  switch (keyword.toUpperCase()) {
    case 'SELECT':
      return /^\s+(?:\*|['"`(\d?:@$]|(?:DISTINCT|ALL)\s+|[\w.`"]+\s*(?:,|FROM\b))/i.test(suffix);
    case 'WITH':
      return /^\s+(?:RECURSIVE\s+)?[\w`"]+\s*(?:\([^)]*\)\s*)?AS\s*\(/i.test(suffix);
    case 'INSERT':
    case 'REPLACE':
      return /^\s+(?:(?:IGNORE|OR\s+REPLACE)\s+)?INTO\b/i.test(suffix);
    case 'UPDATE':
      return /^\s+[\w`".[\]]+\s+SET\b/i.test(suffix);
    case 'DELETE':
      return /^\s+FROM\b/i.test(suffix);
    case 'MERGE':
      return /^\s+INTO\b/i.test(suffix);
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'TRUNCATE':
      return /^\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|INDEX|VIEW|DATABASE|SCHEMA|USER|ROLE)\b/i.test(suffix);
    case 'CALL':
    case 'EXEC':
    case 'EXECUTE':
      return /^\s+[\w.`"]+/i.test(suffix);
    case 'SET':
      return /^\s+(?:SESSION\s+|LOCAL\s+)?[@\w`".]+\s*(?:=|TO\b)/i.test(suffix);
    case 'EXPLAIN':
      return /^\s+(?:SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(suffix);
    case 'SHOW':
      return /^\s+(?:TABLES|COLUMNS|DATABASES|SCHEMAS|STATUS|VARIABLES|PROCESSLIST)\b/i.test(suffix);
    default:
      return false;
  }
}

function findSqlDelimiter(value: string, start: number): number {
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < value.length; index++) {
    const char = value[index];
    const next = value[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index++;
      } else if (char === quote && next === quote) {
        index++;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if ((char === '-' && next === '-') || char === '#') {
      lineComment = true;
      if (char === '-') index++;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      index++;
    } else if (char === ';') {
      return index;
    }
  }
  return -1;
}

function redactCredentialAssignments(value: string): string {
  return value.replace(CREDENTIAL_ASSIGNMENT, (_match, prefix: string, credential: string) => {
    const quote = credential[0] === '"' || credential[0] === "'" ? credential[0] : '';
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
}

function redactSqlStatements(value: string, dialect?: DatabaseLogDialect, forceSql = false): { text: string; gaps: string[] } {
  if (forceSql) {
    const redacted = dialect ? redactSqlEvidence(value, dialect) : null;
    return redacted === null
      ? { text: SQL_OMITTED, gaps: ['SQL_REDACTION_UNAVAILABLE'] }
      : { text: redacted, gaps: [] };
  }
  const label = SQL_LABEL.exec(value);
  const gaps = new Set<string>();
  const output: string[] = [];
  let cursor = 0;
  SQL_START.lastIndex = 0;

  for (let match = SQL_START.exec(value); match; match = SQL_START.exec(value)) {
    if (label && label.index < match.index) break;
    const start = match.index;
    if (start < cursor) continue;

    const delimiter = findSqlDelimiter(value, start);
    const end = delimiter < 0 ? value.length : delimiter;
    const sql = value.slice(start, end).trimEnd();
    const redacted = dialect ? redactSqlEvidence(sql, dialect) : null;
    if (redacted === null && !hasSqlContext(value, start) && !hasSqlShape(match[0], value.slice(start + match[0].length))) {
      continue;
    }
    output.push(value.slice(cursor, start));
    if (redacted === null) {
      output.push(SQL_OMITTED);
      gaps.add('SQL_REDACTION_UNAVAILABLE');
      cursor = value.length;
      break;
    } else {
      output.push(redacted);
    }
    cursor = end;
    SQL_START.lastIndex = delimiter < 0 ? value.length : delimiter + 1;
  }

  if (label) {
    const start = label.index + label[0].length;
    const sql = redactExplicitSql(value.slice(start), dialect);
    const prefix = cursor === 0
      ? value.slice(0, label.index)
      : output.join('') + value.slice(cursor, Math.max(cursor, label.index));
    return { text: prefix + value.slice(label.index, start) + sql.text, gaps: [...gaps, ...sql.gaps] };
  }
  output.push(value.slice(cursor));
  return { text: output.join(''), gaps: [...gaps] };
}

function redactPlainLogText(value: string, dialect?: DatabaseLogDialect): { text: string; gaps: string[] } {
  const withCredentialsRedacted = redactSensitiveText(
    redactCredentialAssignments(value.replace(CONNECTION_URI, '$1[REDACTED]@')),
  );
  const sql = redactSqlStatements(withCredentialsRedacted, dialect);
  let text = sql.text.replace(SINGLE_QUOTED_VALUE, "'[REDACTED]'");
  if (dialect === 'mysql') text = text.replace(DOUBLE_QUOTED_VALUE, '"[REDACTED]"');
  return { text, gaps: sql.gaps };
}

function redactStructuredValue(
  value: unknown,
  dialect: DatabaseLogDialect | undefined,
  gaps: Set<string>,
  forceSql = false,
): unknown {
  if (typeof value === 'string') {
    const redacted = forceSql
      ? redactSqlStatements(value, dialect, true)
      : redactPlainLogText(value, dialect);
    redacted.gaps.forEach((gap) => gaps.add(gap));
    return redacted.text;
  }
  if (Array.isArray(value)) return value.map((entry) => redactStructuredValue(entry, dialect, gaps, forceSql));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (isSensitiveField(key)) return [key, '[REDACTED]'];
    return [key, redactStructuredValue(entry, dialect, gaps, isSqlField(key))];
  }));
}

export function redactDatabaseLogText(value: string, dialect?: DatabaseLogDialect): { text: string; gaps: string[] } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object') {
      const gaps = new Set<string>();
      const redacted = redactStructuredValue(parsed, dialect, gaps);
      return { text: JSON.stringify(redacted), gaps: [...gaps] };
    }
  } catch {
    // Non-JSON log lines are handled as plain text below.
  }
  return redactPlainLogText(value, dialect);
}
