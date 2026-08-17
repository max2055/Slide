/**
 * SQL 白名单验证器 - 使用 node-sql-parser AST 检查仅允许 SELECT 查询
 *
 * Phase 106: 指标采集可配置化 — 确保自定义采集 SQL 安全
 */
import pkg from 'node-sql-parser';
const { Parser } = pkg;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export type SqlCommandType = 'read' | 'write' | 'ddl' | 'transaction' | 'session' | 'procedure' | 'unknown';
export type SqlReasonCode = 'READ_ONLY' | 'MULTI_STATEMENT' | 'LOCKING_READ' | 'SELECT_INTO' | 'DANGEROUS_FUNCTION' | 'SQL_TOO_LARGE' | 'UNSUPPORTED_DIALECT' | 'UNCLASSIFIED';

export interface SqlClassification {
  commandType: SqlCommandType;
  reasonCode: SqlReasonCode;
  dialect: string;
  ast?: unknown;
}

const DIALECTS = new Set<SqlClassification['dialect']>(['mysql', 'postgresql', 'oracle', 'dameng']);
const TYPE_MAP: Record<string, SqlCommandType> = {
  select: 'read', show: 'read', describe: 'read', desc: 'read', explain: 'read',
  insert: 'write', update: 'write', delete: 'write', replace: 'write', merge: 'write',
  create: 'ddl', alter: 'ddl', drop: 'ddl', truncate: 'ddl', rename: 'ddl', grant: 'ddl', revoke: 'ddl',
  begin: 'transaction', start: 'transaction', commit: 'transaction', rollback: 'transaction', savepoint: 'transaction',
  set: 'session', use: 'session', pragma: 'session',
  call: 'procedure', execute: 'procedure',
};

function hasDangerousSelectShape(node: any, sql: string): SqlReasonCode | null {
  const normalized = sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, ' ').toLowerCase();
  if (/\bfor\s+(update|share)\b/.test(normalized)) return 'LOCKING_READ';
  if (/\bselect\b[\s\S]*\binto\b/.test(normalized)) return 'SELECT_INTO';
  if (/(?:^|[^a-z0-9_])(load_file|benchmark|get_lock|release_lock|sleep)\s*\(/.test(normalized)) return 'DANGEROUS_FUNCTION';
  const functionViolation = checkUnsafeFunctions(node);
  return functionViolation ? 'DANGEROUS_FUNCTION' : null;
}

/** AST-first classifier. Parser failure is deliberately unknown rather than a heuristic allow. */
export function classifySql(sql: string, dialect: string = 'mysql'): SqlClassification {
  if (!DIALECTS.has(dialect) || !sql.trim()) return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect };
  if (Buffer.byteLength(sql, 'utf8') > 64 * 1024) return { commandType: 'unknown', reasonCode: 'SQL_TOO_LARGE', dialect };
  const parser = new Parser();
  let ast: any;
  try {
    // node-sql-parser does not fully model Dameng, so try its Oracle grammar
    // first and fall back to the shared MySQL subset below when unavailable.
    const parserDialect = dialect === 'dameng' ? 'oracle' : dialect;
    ast = parser.astify(sql, { database: parserDialect });
  } catch {
    if (dialect !== 'oracle' && dialect !== 'dameng') {
      return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect };
    }
    try {
      ast = parser.astify(sql, { database: 'mysql' });
    } catch {
      return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect };
    }
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) return { commandType: 'unknown', reasonCode: 'MULTI_STATEMENT', dialect, ast };
  const rawType = String(statements[0]?.type ?? '').toLowerCase();
  const firstKeyword = sql.trim().replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '').split(/\s+/)[0]?.toLowerCase();
  const type = TYPE_MAP[rawType] ?? TYPE_MAP[firstKeyword] ?? 'unknown';
  // User-submitted read paths deliberately accept SELECT only. SHOW,
  // DESCRIBE and EXPLAIN have separate application-owned implementations.
  if (type === 'read' && rawType !== 'select') {
    return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect, ast };
  }
  if (type === 'read') {
    const dangerous = hasDangerousSelectShape(statements[0], sql);
    if (dangerous) return { commandType: 'unknown', reasonCode: dangerous, dialect, ast };
  }
  return { commandType: type, reasonCode: type === 'read' ? 'READ_ONLY' : 'UNCLASSIFIED', dialect, ast };
}

export function isSingleReadOnlySql(sql: string, dialect?: string): SqlClassification {
  return classifySql(sql, dialect);
}

/**
 * 验证 SQL 是否为纯 SELECT 查询
 * @param sql 用户输入的 SQL 语句
 * @returns { valid: true } 或 { valid: false, error: string }
 */
export function validateSqlIsSelectOnly(sql: string): ValidationResult {
  const classification = classifySql(sql);
  return classification.commandType === 'read'
    ? { valid: true }
    : { valid: false, error: `仅允许单条只读 SQL（${classification.reasonCode}）` };
}

// SQL functions can perform writes, alter server state, open network
// connections, acquire locks or deliberately consume resources while still
// appearing inside a SELECT. Keep this list intentionally conservative:
// extension and user-defined functions are denied until reviewed explicitly.
const SAFE_READ_FUNCTIONS = new Set([
  // Aggregates and window functions
  'avg', 'bit_and', 'bit_or', 'bool_and', 'bool_or', 'count', 'cume_dist',
  'dense_rank', 'first_value', 'group_concat', 'json_agg', 'json_arrayagg',
  'json_objectagg', 'lag', 'last_value', 'lead', 'max', 'min', 'nth_value',
  'ntile', 'percent_rank', 'rank', 'row_number', 'stddev', 'stddev_pop',
  'stddev_samp', 'string_agg', 'sum', 'variance', 'var_pop', 'var_samp',
  // Null, comparison and conditional helpers
  'coalesce', 'decode', 'greatest', 'if', 'ifnull', 'least', 'nullif', 'nvl',
  'nvl2',
  // String helpers
  'ascii', 'btrim', 'char', 'char_length', 'character_length', 'concat',
  'concat_ws', 'format', 'initcap', 'instr', 'left', 'length', 'lower',
  'lpad', 'ltrim', 'octet_length', 'position', 'regexp_instr', 'regexp_like',
  'regexp_replace', 'regexp_substr', 'repeat', 'replace', 'reverse', 'right',
  'rpad', 'rtrim', 'split_part', 'strpos', 'substr', 'substring', 'to_char',
  'translate', 'trim', 'upper',
  // Numeric helpers
  'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'ceiling', 'cos', 'cot',
  'degrees', 'exp', 'floor', 'ln', 'log', 'log10', 'mod', 'pi', 'power',
  'radians', 'round', 'sign', 'sin', 'sqrt', 'tan', 'trunc', 'truncate',
  // Date/time conversion and extraction
  'add_months', 'age', 'convert_tz', 'date', 'date_add', 'date_format',
  'date_part', 'date_sub', 'datediff', 'day', 'dayofmonth', 'dayofweek',
  'dayofyear', 'extract', 'from_unixtime', 'hour', 'last_day', 'make_date',
  'minute', 'month', 'months_between', 'next_day', 'now', 'second',
  'str_to_date', 'sysdate', 'timestampdiff', 'to_date', 'to_timestamp',
  'unix_timestamp', 'week', 'year',
  // Read-only JSON and type conversion helpers
  'cast', 'convert', 'json_array', 'json_array_length', 'json_extract',
  'json_object', 'json_query', 'json_type', 'json_unquote', 'json_value',
  'to_number',
  // Constants represented as functions by node-sql-parser
  'current_date', 'current_time', 'current_timestamp', 'localtime',
  'localtimestamp',
]);

function getFunctionName(node: any): string | null {
  if (typeof node?.name === 'string') return node.name.toLowerCase();
  const parts = node?.name?.name;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const value = parts[parts.length - 1]?.value;
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function checkUnsafeFunctions(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'function' || node.type === 'aggr_func') {
    const functionName = getFunctionName(node);
    if (!functionName || !SAFE_READ_FUNCTIONS.has(functionName)) {
      return `未批准的 SQL 函数: ${functionName || 'unknown'}`;
    }
  }
  for (const key of Object.keys(node)) {
    const result = checkUnsafeFunctions(node[key]);
    if (result) return result;
  }
  return null;
}
