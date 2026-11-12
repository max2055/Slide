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

function isSqlWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\v';
}

interface ScannedSql {
  expanded: string;
  skeleton: string;
  /** Parser input whose literals cannot be re-tokenized by default escapes. */
  canonical: string;
}

/**
 * Separate executable MySQL comments from text that cannot change statement
 * shape. Versioned comments are always inlined: the classifier does not know
 * the server version, and dropping a future-version body would hide the
 * statement a newer server would run. `backslashEscapes` follows one sql_mode
 * interpretation; callers scan each closed interpretation. Returns null when a
 * comment or literal is unclosed in that interpretation.
 *
 * `canonical` keeps keywords, operators and quoted identifiers, replaces
 * string bodies with `''`, and drops ordinary comments. The parser always
 * uses its own default escape rules, so it must not see the original literal
 * text or it will reassemble a different statement than this mode executes.
 */
function scanSqlTokens(sql: string, dialect: string, backslashEscapes = true): ScannedSql | null {
  const mysql = dialect === 'mysql';
  const expanded: string[] = [];
  const skeleton: string[] = [];
  const canonical: string[] = [];
  let index = 0;
  let inliningExecutable = false;

  const pushCode = (text: string) => {
    expanded.push(text);
    skeleton.push(text);
    canonical.push(text);
  };
  const pushMasked = (original: string, skeletonMask: string, canonicalMask: string) => {
    expanded.push(original);
    skeleton.push(skeletonMask);
    canonical.push(canonicalMask);
  };

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (current === '\'' || current === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < sql.length) {
        if (backslashEscapes && sql[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === current) {
          if (sql[cursor + 1] === current) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) return null;
      pushMasked(sql.slice(index, cursor), current === '\'' ? "''" : '""', "''");
      index = cursor;
      continue;
    }

    if (current === '`') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < sql.length) {
        if (sql[cursor] === '`' && sql[cursor + 1] === '`') {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === '`') {
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) return null;
      // Keep the identifier in the parser input. Masking it in the skeleton
      // avoids keyword false positives; the function whitelist reads the AST.
      pushMasked(sql.slice(index, cursor), '``', sql.slice(index, cursor));
      index = cursor;
      continue;
    }

    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
    if (dollar) {
      const closer = sql.indexOf(dollar[0], index + dollar[0].length);
      if (closer < 0) return null;
      const end = closer + dollar[0].length;
      // MySQL has no dollar literals. Keep the original text in the parser
      // input so SELECT $$sleep(0)$$ still fails closed, and mask the skeleton
      // so the keyword scan does not reclassify that parser failure.
      pushMasked(sql.slice(index, end), "''", mysql ? sql.slice(index, end) : "''");
      index = end;
      continue;
    }

    if (inliningExecutable && current === '*' && next === '/') {
      inliningExecutable = false;
      pushCode(' ');
      index += 2;
      continue;
    }

    const afterDash = sql[index + 2];
    const lineComment = (sql.startsWith('--', index) && (!mysql || afterDash === undefined || isSqlWhitespace(afterDash)))
      || (mysql && current === '#');
    if (lineComment) {
      let cursor = index;
      while (cursor < sql.length && sql[cursor] !== '\n') cursor += 1;
      if (sql[cursor] === '\n') cursor += 1;
      pushMasked(sql.slice(index, cursor), ' ', ' ');
      index = cursor;
      continue;
    }

    if (current === '/' && next === '*') {
      const executable = mysql && sql[index + 2] === '!' && !inliningExecutable;
      if (executable) {
        let cursor = index + 3;
        if (/^\d{5}/.test(sql.slice(cursor))) {
          const sixth = sql[cursor + 5];
          const seventh = sql[cursor + 6];
          cursor += sixth !== undefined && sixth >= '0' && sixth <= '9' && isSqlWhitespace(seventh) ? 6 : 5;
        }
        inliningExecutable = true;
        pushCode(' ');
        index = cursor;
        continue;
      }
      let cursor = index + 2;
      let closed = false;
      while (cursor < sql.length) {
        if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          cursor += 2;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) return null;
      pushMasked(sql.slice(index, cursor), ' ', ' ');
      index = cursor;
      continue;
    }

    pushCode(current);
    index += 1;
  }

  if (inliningExecutable) return null;
  return {
    expanded: expanded.join(''),
    skeleton: skeleton.join(''),
    canonical: canonical.join(''),
  };
}

function dangerousSelectText(skeleton: string): SqlReasonCode | null {
  const normalized = skeleton.toLowerCase();
  if (/\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/.test(normalized)) return 'LOCKING_READ';
  if (/\block\s+in\s+share\s+mode\b/.test(normalized)) return 'LOCKING_READ';
  if (/\binto\s+(?:outfile|dumpfile)\b/.test(normalized) || /\bselect\b[\s\S]*\binto\b/.test(normalized)) return 'SELECT_INTO';
  if (/(?:^|[^a-z0-9_])(?:load_file|benchmark|get_lock|release_lock|sleep)\s*\(/.test(normalized)) return 'DANGEROUS_FUNCTION';
  return null;
}

function astHasLockingRead(node: any, seen = new WeakSet<object>()): boolean {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if (node.locking_read) return true;
  for (const value of Object.values(node)) {
    if (astHasLockingRead(value, seen)) return true;
  }
  return false;
}

const CHANGING_STATEMENT_TYPES = new Set([
  'insert', 'update', 'delete', 'replace', 'merge',
  'create', 'alter', 'drop', 'truncate', 'rename', 'grant', 'revoke',
  'call', 'execute',
  'begin', 'start', 'commit', 'rollback', 'savepoint',
  'set', 'use', 'pragma',
]);

function nestedChangingStatement(node: any, seen = new WeakSet<object>()): boolean {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((item) => nestedChangingStatement(item, seen));
  const type = String(node.type ?? '').toLowerCase();
  if (type !== 'select' && CHANGING_STATEMENT_TYPES.has(type)) return true;
  return Object.values(node).some((value) => nestedChangingStatement(value, seen));
}

function hasDangerousSelectShape(node: any, skeleton: string): SqlReasonCode | null {
  const fromText = dangerousSelectText(skeleton);
  if (fromText) return fromText;
  if (astHasLockingRead(node)) return 'LOCKING_READ';
  if (nestedChangingStatement(node)) return 'UNCLASSIFIED';
  return checkUnsafeFunctions(node) ? 'DANGEROUS_FUNCTION' : null;
}

function unclassified(dialect: string): SqlClassification {
  return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect };
}

function isReadOnly(result: SqlClassification): boolean {
  return result.commandType === 'read' && result.reasonCode === 'READ_ONLY';
}

/** A read is allowed only when every closed interpretation is a read. */
function stricterClassification(primary: SqlClassification, alternate: SqlClassification): SqlClassification {
  const primaryDenies = !isReadOnly(primary);
  const alternateDenies = !isReadOnly(alternate);
  if (primaryDenies && alternateDenies) {
    if (primary.reasonCode === 'UNCLASSIFIED' && alternate.reasonCode !== 'UNCLASSIFIED') return alternate;
    return primary;
  }
  return alternateDenies ? alternate : primary;
}

function classifyScanned(sql: string, dialect: string, scanned: ScannedSql): SqlClassification {
  // MySQL parses the mode-specific canonical statement so default backslash
  // rules cannot pull code back into a literal. Other dialects parse the
  // original text; their scan only builds the skeleton.
  const source = dialect === 'mysql' ? scanned.canonical : sql;
  const parser = new Parser();
  let ast: any;
  try {
    // node-sql-parser does not fully model Dameng, so try its Oracle grammar
    // first and fall back to the shared MySQL subset below when unavailable.
    const parserDialect = dialect === 'dameng' ? 'oracle' : dialect;
    ast = parser.astify(source, { database: parserDialect });
  } catch {
    const dangerous = dangerousSelectText(scanned.skeleton);
    if (dangerous) return { commandType: 'unknown', reasonCode: dangerous, dialect };
    if (dialect !== 'oracle' && dialect !== 'dameng') return unclassified(dialect);
    try {
      ast = parser.astify(source, { database: 'mysql' });
    } catch {
      return unclassified(dialect);
    }
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) return { commandType: 'unknown', reasonCode: 'MULTI_STATEMENT', dialect, ast };
  const rawType = String(statements[0]?.type ?? '').toLowerCase();
  const firstKeyword = scanned.skeleton.trim().split(/\s+/)[0]?.toLowerCase();
  const type = TYPE_MAP[rawType] ?? TYPE_MAP[firstKeyword] ?? 'unknown';
  // User-submitted read paths deliberately accept SELECT only. SHOW,
  // DESCRIBE and EXPLAIN have separate application-owned implementations.
  if (type === 'read' && rawType !== 'select') return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect, ast };
  if (type === 'read') {
    const dangerous = hasDangerousSelectShape(statements[0], scanned.skeleton);
    if (dangerous) return { commandType: 'unknown', reasonCode: dangerous, dialect, ast };
  }
  return { commandType: type, reasonCode: type === 'read' ? 'READ_ONLY' : 'UNCLASSIFIED', dialect, ast };
}

/** AST-first classifier. Parser failure is deliberately unknown rather than a heuristic allow. */
export function classifySql(sql: string, dialect: string = 'mysql'): SqlClassification {
  if (!DIALECTS.has(dialect) || !sql.trim()) return unclassified(dialect);
  if (Buffer.byteLength(sql, 'utf8') > 64 * 1024) return { commandType: 'unknown', reasonCode: 'SQL_TOO_LARGE', dialect };
  const escaped = scanSqlTokens(sql, dialect, true);
  if (dialect !== 'mysql') return escaped ? classifyScanned(sql, dialect, escaped) : unclassified(dialect);
  // The session sql_mode is not known here. An unclosed literal cannot run.
  // Every closed reading must parse to the same whitelist decision: the
  // alternate text skeleton is not a function allow-list.
  const literal = scanSqlTokens(sql, dialect, false);
  const closed = [escaped, literal].filter((scan): scan is ScannedSql => scan !== null);
  if (closed.length === 0) return unclassified(dialect);
  let result = classifyScanned(sql, dialect, closed[0]);
  for (const scan of closed.slice(1)) {
    if (scan.canonical === closed[0].canonical) continue;
    result = stricterClassification(result, classifyScanned(sql, dialect, scan));
  }
  return result;
}

export function isSingleReadOnlySql(sql: string, dialect?: string): SqlClassification {
  return classifySql(sql, dialect);
}

/**
 * 验证 SQL 是否为纯 SELECT 查询。
 * 省略方言时保持 MySQL，与既有调用方兼容。显式传入未知方言时拒绝，而不是退回 MySQL。
 * @param sql 用户输入的 SQL 语句
 * @param dialect 实例 db_type；仅 mysql、postgresql、oracle、dameng 可被分类
 * @returns { valid: true } 或 { valid: false, error: string }
 */
export function validateSqlIsSelectOnly(sql: string, dialect: string = 'mysql'): ValidationResult {
  const classification = classifySql(sql, dialect);
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
