const sensitiveTextKey =
  /(?:^|[^a-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key|subscription[_-]?key|authorization|cookie|credential|connection[_-]?string|private[_-]?key)(?:$|[^a-z0-9])/;
const assignmentKey = 'password|passwd|pwd|secret|token|api[_-]?key|subscription[_-]?key|authorization|cookie|credential|connection[_-]?string|private[_-]?key';
const spacedAssignmentValue = `[^\\s,;\\r\\n{}\\[\\]"']+(?:[^\\S\\r\\n]+(?!(?:${assignmentKey})[^\\S\\r\\n]*[=:])[^\\s,;\\r\\n{}\\[\\]"']+)*`;
const assignmentPattern = new RegExp(`((?:${assignmentKey})[^\\S\\r\\n]*[=:][^\\S\\r\\n]*)${spacedAssignmentValue}`, 'gi');
const escapedJsonPattern = new RegExp(`(\\\\?"(?:${assignmentKey})\\\\?"\\s*:\\s*\\\\?")[^"\\\\]*`, 'gi');

interface QuotedText {
  end: number;
  open: string;
  close: string;
  value: string;
}

function readQuotedText(text: string, start: number): QuotedText | null {
  const escaped = text.startsWith('\\"', start);
  const quote = escaped ? '\\"' : text[start];
  if (quote !== '"' && quote !== "'" && !escaped) return null;
  const contentStart = start + quote.length;
  for (let i = contentStart; i < text.length; i++) {
    if (escaped && text.startsWith('\\"', i)) {
      return { end: i + 2, open: quote, close: quote, value: text.slice(contentStart, i) };
    }
    if (!escaped && text[i] === quote) {
      return { end: i + 1, open: quote, close: quote, value: text.slice(contentStart, i) };
    }
    if (text[i] === "\\") i++;
  }
  return { end: text.length, open: quote, close: "", value: text.slice(contentStart) };
}

function isSensitiveTextKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return sensitiveTextKey.test(normalized);
}

function sensitiveTextProperty(text: string, start: number): { valueStart: number } | null {
  let key: string;
  let keyEnd: number;
  const quoted = readQuotedText(text, start);
  if (quoted) {
    key = quoted.value;
    keyEnd = quoted.end;
  } else {
    if (!/[A-Za-z_$]/.test(text[start] ?? "")) return null;
    keyEnd = start + 1;
    while (/[\w$-]/.test(text[keyEnd] ?? "")) keyEnd++;
    key = text.slice(start, keyEnd);
  }
  let valueStart = keyEnd;
  while (/\s/.test(text[valueStart] ?? "")) valueStart++;
  if (text[valueStart] !== ":" && text[valueStart] !== "=") return null;
  valueStart++;
  while (/\s/.test(text[valueStart] ?? "")) valueStart++;
  return isSensitiveTextKey(key) ? { valueStart } : null;
}

function scanTextValue(text: string, start: number): { end: number; replacement: string } {
  const quoted = readQuotedText(text, start);
  if (quoted) {
    return { end: quoted.end, replacement: quoted.open + "[REDACTED]" + quoted.close };
  }
  const first = text[start];
  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    for (let i = start + 1; i < text.length; i++) {
      const nestedQuote = readQuotedText(text, i);
      if (nestedQuote) {
        i = nestedQuote.end - 1;
        continue;
      }
      if (text[i] === "{") stack.push("}");
      else if (text[i] === "[") stack.push("]");
      else if (text[i] === "}" || text[i] === "]") {
        if (stack.at(-1) === text[i]) stack.pop();
        if (stack.length === 0) return { end: i + 1, replacement: '"[REDACTED]"' };
      }
    }
    return { end: text.length, replacement: '"[REDACTED]' };
  }
  let end = start;
  while (end < text.length && !/[\s,;{}\[\]]/.test(text[end])) end++;
  if (end === start && end < text.length) {
    return { end: end + 1, replacement: "[REDACTED]" + text[end] };
  }
  return { end, replacement: "[REDACTED]" };
}

function redactSensitiveTextProperties(text: string): string {
  let output = "";
  let copiedThrough = 0;
  for (let i = 0; i < text.length;) {
    const quoted = readQuotedText(text, i);
    if (quoted) {
      const property = sensitiveTextProperty(text, i);
      if (property) {
        const value = scanTextValue(text, property.valueStart);
        output += text.slice(copiedThrough, property.valueStart) + value.replacement;
        i = value.end;
        copiedThrough = i;
      } else {
        i = quoted.end;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(text[i])) {
      let keyEnd = i + 1;
      while (/[\w$-]/.test(text[keyEnd] ?? "")) keyEnd++;
      const property = sensitiveTextProperty(text, i);
      if (property) {
        const value = scanTextValue(text, property.valueStart);
        output += text.slice(copiedThrough, property.valueStart) + value.replacement;
        i = value.end;
        copiedThrough = i;
      } else {
        i = keyEnd;
      }
      continue;
    }
    i++;
  }
  return output + text.slice(copiedThrough);
}

export function redactSensitiveText(text: string): string {
  const standardSecrets = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
  return redactSensitiveTextProperties(standardSecrets)
    .replace(escapedJsonPattern, '$1[REDACTED]')
    .replace(assignmentPattern, '$1[REDACTED]');
}
