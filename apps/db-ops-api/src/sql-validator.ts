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
export type SqlReasonCode = 'READ_ONLY' | 'MULTI_STATEMENT' | 'LOCKING_READ' | 'SELECT_INTO' | 'DANGEROUS_FUNCTION' | 'UNSUPPORTED_DIALECT' | 'UNCLASSIFIED';

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
  const functionViolation = checkDangerousFunctions(node);
  return functionViolation ? 'DANGEROUS_FUNCTION' : null;
}

/** AST-first classifier. Parser failure is deliberately unknown rather than a heuristic allow. */
export function classifySql(sql: string, dialect: string = 'mysql'): SqlClassification {
  if (!DIALECTS.has(dialect) || !sql.trim()) return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect };
  const parser = new Parser();
  let ast: any;
  try {
    // node-sql-parser does not fully model Dameng. Its Oracle grammar is the
    // closest supported grammar and failures remain fail-closed.
    const parserDialect = dialect === 'dameng' ? 'oracle' : dialect;
    ast = parser.astify(sql, { database: parserDialect });
  } catch {
    return { commandType: 'unknown', reasonCode: 'UNCLASSIFIED', dialect };
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) return { commandType: 'unknown', reasonCode: 'MULTI_STATEMENT', dialect, ast };
  const rawType = String(statements[0]?.type ?? '').toLowerCase();
  const firstKeyword = sql.trim().replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '').split(/\s+/)[0]?.toLowerCase();
  const type = TYPE_MAP[rawType] ?? TYPE_MAP[firstKeyword] ?? 'unknown';
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

const DANGEROUS_FUNCTIONS = new Set(['load_file', 'benchmark', 'get_lock', 'release_lock', 'sleep']);

function checkDangerousFunctions(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  const functionName = typeof node.name === 'string' ? node.name : node.name?.name;
  if (node.type === 'function' && typeof functionName === 'string' && DANGEROUS_FUNCTIONS.has(functionName.toLowerCase())) {
    return `禁止使用的 SQL 函数: ${functionName}`;
  }
  // Recurse into all keys of the node to find nested function calls
  for (const key of Object.keys(node)) {
    const result = checkDangerousFunctions(node[key]);
    if (result) return result;
  }
  return null;
}
