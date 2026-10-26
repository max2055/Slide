import { redactSqlEvidence } from './analysis/evidence-sql-redaction.js';
import { redactSensitiveText } from './security/log-redaction.js';

export type DatabaseLogDialect = 'mysql' | 'postgresql' | 'oracle' | 'dameng';

export function databaseLogDialect(source: string): DatabaseLogDialect | undefined {
  if (source.startsWith('mysql_')) return 'mysql';
  if (source === 'pg_log') return 'postgresql';
  return undefined;
}

const SQL_START = /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|EXEC(?:UTE)?)\b/ig;
const CREDENTIAL_ASSIGNMENT = /\b((?:password|passwd|pwd|secret|token|api[_-]?key|authorization|user(?:name)?|uid|user\s+id)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const CONNECTION_URI = /\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi;
const SINGLE_QUOTED_VALUE = /'(?:''|\\.|[^'\\])*'/g;
const DOUBLE_QUOTED_VALUE = /"(?:""|\\.|[^"\\])*"/g;
const SENSITIVE_FIELD = /(?:^|[_-])(?:password|passwd|pwd|secret|token|authorization|api[_-]?key|credential|private[_-]?key|connection[_-]?(?:string|url|uri)|dsn|username|user|uid)(?:$|[_-])/i;

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
      return /^\s+(?:\*|['"`(\d?:@$])/i.test(suffix)
        || /\b(?:FROM|WHERE|UNION|JOIN|INTO|VALUES)\b/i.test(suffix);
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
    case 'EXPLAIN':
      return /^\s+(?:SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(suffix);
    case 'SHOW':
      return /^\s+(?:TABLES|COLUMNS|DATABASES|SCHEMAS|STATUS|VARIABLES|PROCESSLIST)\b/i.test(suffix);
    default:
      return false;
  }
}

function redactCredentialAssignments(value: string): string {
  return value.replace(CREDENTIAL_ASSIGNMENT, (_match, prefix: string, credential: string) => {
    const quote = credential[0] === '"' || credential[0] === "'" ? credential[0] : '';
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
}

function redactSqlStatements(value: string, dialect?: DatabaseLogDialect): { text: string; gaps: string[] } {
  const gaps = new Set<string>();
  const output: string[] = [];
  let cursor = 0;
  SQL_START.lastIndex = 0;

  for (let match = SQL_START.exec(value); match; match = SQL_START.exec(value)) {
    const start = match.index;
    if (start < cursor) continue;

    const delimiter = value.indexOf(';', start);
    const end = delimiter < 0 ? value.length : delimiter;
    const sql = value.slice(start, end).trimEnd();
    const redacted = dialect ? redactSqlEvidence(sql, dialect) : null;
    if (redacted === null && !hasSqlContext(value, start) && !hasSqlShape(match[0], value.slice(start + match[0].length))) {
      continue;
    }
    output.push(value.slice(cursor, start));
    if (redacted === null) {
      output.push('[SQL 已省略：无法安全脱敏]');
      gaps.add('SQL_REDACTION_UNAVAILABLE');
      cursor = value.length;
      break;
    } else {
      output.push(redacted);
    }
    cursor = end;
    SQL_START.lastIndex = delimiter < 0 ? value.length : delimiter + 1;
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

function redactStructuredValue(value: unknown, dialect: DatabaseLogDialect | undefined, gaps: Set<string>): unknown {
  if (typeof value === 'string') {
    const redacted = redactPlainLogText(value, dialect);
    redacted.gaps.forEach((gap) => gaps.add(gap));
    return redacted.text;
  }
  if (Array.isArray(value)) return value.map((entry) => redactStructuredValue(entry, dialect, gaps));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactStructuredValue(entry, dialect, gaps),
  ]));
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
