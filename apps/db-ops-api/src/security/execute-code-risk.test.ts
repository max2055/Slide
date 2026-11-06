import { describe, expect, it } from 'vitest';
import { classifyExecuteCodeRisk, executeCodeRequiresNetwork } from './execute-code-risk.js';

describe('execute_code risk policy', () => {
  it('auto-allows a single read-only shell command in the sandbox workspace', () => {
    expect(classifyExecuteCodeRisk({ runtime: 'shell', code: 'pwd' })).toEqual({
      level: 'low',
      scope: 'none',
      requiresApproval: false,
    });
  });

  // GitHub #282 / OCR-0018, OCR-0251, OCR-0252: classify the whole script.
  it.each([
    'pwd\nmv secret back', 'ls\ncp a b', 'pwd\r\nmv a b',
    'pwd; mv a b', 'pwd && cp a b', 'pwd || cp a b', 'pwd | tee output',
    'pwd & cp a b', 'cat foo > bar', 'cat foo >> bar', 'ls 2> errors',
    'cat foo <> bar', 'cat <<EOF\ntext\nEOF', 'cat <(cp a b)',
    'pwd $(cp a b)', 'pwd `cp a b`', 'pwd ${x:=value}',
    'pwd\\\ncp a b', 'pwd # comment\ncp a b', 'pwd(foo)',
    'PWD', 'pwd\u000bcp a b', 'cat "foo"',
    'find . -delete', 'find . -fprint output', 'find . -fprintf output %p',
    'find . -fls output', 'find . -exec cp a b ;', 'find . -execdir cp a b ;',
    'find . -ok cp a b ;', 'find . -unknown', 'find . -print',
  ])('requires approval for compound, writing or unproven shell source: %j', (code) => {
    const risk = classifyExecuteCodeRisk({ runtime: 'shell', code });
    expect(risk.requiresApproval).toBe(true);
    expect(risk.level).not.toBe('low');
    expect(risk.scope).not.toBe('none');
  });

  it.each(['pwd', 'ls -la', 'cat report.txt', 'head -n 5 report.txt',
    'tail -n 5 report.txt', 'grep error report.txt', 'wc -l report.txt',
    'du -s data', 'stat report.txt', '  pwd\n'])('preserves simple read-only commands: %j', (code) => {
    expect(classifyExecuteCodeRisk({ runtime: 'shell', code })).toEqual({
      level: 'low', scope: 'none', requiresApproval: false,
    });
  });

  it('requires approval for supporting file writes even with a read-only command', () => {
    expect(classifyExecuteCodeRisk({ runtime: 'shell', code: 'pwd', files: [{ path: 'input.txt', content: 'data' }] }))
      .toEqual({ level: 'medium', scope: 'window', requiresApproval: true });
  });

  it('requires a short approval window for shell writes or compound commands', () => {
    expect(classifyExecuteCodeRisk({ runtime: 'shell', code: 'echo report > report.txt' })).toMatchObject({
      level: 'medium',
      scope: 'window',
      requiresApproval: true,
    });
  });

  it('requires one-time approval for network scanning and destructive commands', () => {
    expect(classifyExecuteCodeRisk({ runtime: 'shell', code: 'nmap -sV 10.0.0.0/24' })).toMatchObject({
      level: 'high',
      scope: 'once',
      requiresApproval: true,
    });
    expect(classifyExecuteCodeRisk({ runtime: 'python', code: 'import subprocess; subprocess.run(["rm", "-rf", "/tmp/x"])' })).toMatchObject({
      level: 'high',
      scope: 'once',
      requiresApproval: true,
    });
  });

  it('does not auto-classify arbitrary Python or Node source as low risk', () => {
    expect(classifyExecuteCodeRisk({ runtime: 'python', code: 'print(1)' }).requiresApproval).toBe(true);
    expect(classifyExecuteCodeRisk({ runtime: 'node', code: 'console.log(1)' }).requiresApproval).toBe(true);
  });

  it('identifies network APIs across shell, Python, and Node runtimes', () => {
    expect(executeCodeRequiresNetwork({ runtime: 'shell', code: 'nmap 10.0.0.0/24' })).toBe(true);
    expect(executeCodeRequiresNetwork({ runtime: 'python', code: 'import socket' })).toBe(true);
    expect(executeCodeRequiresNetwork({ runtime: 'node', code: 'fetch("http://10.0.0.1")' })).toBe(true);
    expect(executeCodeRequiresNetwork({ runtime: 'node', code: 'console.log(1)' })).toBe(false);
  });
});
