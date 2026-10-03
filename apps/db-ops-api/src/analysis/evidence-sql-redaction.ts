import { classifySql } from '../sql-validator.js';

const dialects = new Set(['mysql', 'postgresql', 'oracle', 'dameng']);

/** Tokenize rather than replace substrings: numbers inside identifiers are not literals.
 * SQL must also pass the existing AST parser. Plan text uses the database formatter's
 * header, never error text or arbitrary strings. Unsupported forms fail closed.
 * These strings are display evidence only and are never executed.
 */
export function redactSqlEvidence(text: string, dialect = 'mysql', plan = false): string | null {
  if (!dialects.has(dialect) || text.length > 64_000) return null;
  if (plan) {
    const header = { mysql: 'MySQL', postgresql: 'PostgreSQL', oracle: 'Oracle', dameng: '达梦数据库' }[dialect];
    if (!text.startsWith(`${header} 执行计划:\n`) || /获取执行计划失败|执行计划无法生成/.test(text)) return null;
  } else if (!classifySql(text, dialect).ast) return null;
  let result = '';
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    if (rest.startsWith('/*')) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0 || text.slice(i + 2, end).includes('/*')) return null;
      result += ' '; i = end + 2; continue;
    }
    if (rest.startsWith('--') || (dialect === 'mysql' && text[i] === '#')) {
      const end = text.indexOf('\n', i);
      result += '\n'; i = end < 0 ? text.length : end + 1; continue;
    }
    // PostgreSQL dollar strings (including $$); parameters such as $1 are retained.
    const dollar = dialect === 'postgresql' ? /^(\$(?:[A-Za-z_][\w]*)?\$)/.exec(rest)?.[1] : undefined;
    if (dollar) {
      const end = text.indexOf(dollar, i + dollar.length);
      if (end < 0) return null;
      result += "'[REDACTED]'"; i = end + dollar.length; continue;
    }
    // Oracle alternative quoting. The AST may reject it for SQL; plan predicates
    // still need to hide the entire literal, including any embedded apostrophes.
    if ((dialect === 'oracle' || dialect === 'dameng') && /^[qQ]'/.test(rest)) {
      const open = text[i + 2];
      const close = ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
      if (!open || /\s/.test(open)) return null;
      const end = text.indexOf(`${close}'`, i + 3);
      if (end < 0) return null;
      result += "'[REDACTED]'"; i = end + 2; continue;
    }
    // U& strings/identifiers need their UESCAPE setting, which is not frozen.
    if (/^[uU]&['"]/.test(rest)) return null;
    const escapeString = dialect === 'postgresql' && /^[eE]'/.test(rest);
    if (escapeString) i++;
    const quote = text[i];
    if (quote === "'" || quote === '"' || quote === '`') {
      const identifier = quote === '`' || (quote === '"' && dialect !== 'mysql');
      if (quote === '`' && dialect !== 'mysql') return null;
      const start = i++;
      let closed = false;
      for (; i < text.length; i++) {
        if (text[i] === '\\' && (dialect === 'mysql' || escapeString)) { i++; continue; }
        if (text[i] !== quote) continue;
        if (text[i + 1] === quote) { i++; continue; }
        i++; closed = true; break;
      }
      if (!closed) return null;
      result += identifier ? text.slice(start, i) : "'[REDACTED]'";
      continue;
    }
    const word = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(rest)?.[0];
    if (word) { result += /^(true|false)$/i.test(word) ? (plan ? '[REDACTED]' : 'NULL') : word; i += word.length; continue; }
    const number = /^(?:0x[\da-f]+|0b[01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(rest)?.[0];
    if (number) {
      // Only application-formatted numeric metadata may retain plan numbers.
      // Predicate constants and unrecognized plan text never get this exemption.
      const line = text.slice(text.lastIndexOf('\n', i) + 1, text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i));
      const estimate = plan && dialect === 'mysql' && /^\s*(?:ID:|键长度：|行数：)\s*\d+(?:\.\d+)?\s*$/.test(line);
      result += estimate ? number : plan ? '[REDACTED]' : 'NULL'; i += number.length; continue;
    }
    result += text[i++];
  }
  return result;
}
