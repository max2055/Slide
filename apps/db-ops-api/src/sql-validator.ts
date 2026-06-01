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

/**
 * 验证 SQL 是否为纯 SELECT 查询
 * @param sql 用户输入的 SQL 语句
 * @returns { valid: true } 或 { valid: false, error: string }
 */
export function validateSqlIsSelectOnly(sql: string): ValidationResult {
  const parser = new Parser();

  let ast: any;
  try {
    ast = parser.astify(sql);
  } catch (e: any) {
    return {
      valid: false,
      error: `SQL 语法错误: ${e.message || '无法解析'}`,
    };
  }

  // astify returns either a single AST or an array for multi-statement SQL
  const statements = Array.isArray(ast) ? ast : [ast];

  for (const stmt of statements) {
    const type = (stmt.type || '').toLowerCase();
    if (type !== 'select') {
      return {
        valid: false,
        error: `不允许的 SQL 操作: ${type}。仅支持 SELECT 查询`,
      };
    }
  }

  // Check for dangerous functions within SELECT expressions
  const funcViolation = checkDangerousFunctions(ast);
  if (funcViolation) {
    return { valid: false, error: funcViolation };
  }

  return { valid: true };
}

const DANGEROUS_FUNCTIONS = new Set(['load_file', 'benchmark', 'get_lock', 'release_lock', 'sleep']);

function checkDangerousFunctions(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'function' && node.name && DANGEROUS_FUNCTIONS.has(node.name.toLowerCase())) {
    return `禁止使用的 SQL 函数: ${node.name}`;
  }
  // Recurse into all keys of the node to find nested function calls
  for (const key of Object.keys(node)) {
    const result = checkDangerousFunctions(node[key]);
    if (result) return result;
  }
  return null;
}
