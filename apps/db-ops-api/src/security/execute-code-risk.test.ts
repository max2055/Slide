import { describe, expect, it } from 'vitest';
import { classifyExecuteCodeRisk } from './execute-code-risk.js';

describe('execute_code risk policy', () => {
  it('auto-allows a single read-only shell command in the sandbox workspace', () => {
    expect(classifyExecuteCodeRisk({ runtime: 'shell', code: 'pwd' })).toEqual({
      level: 'low',
      scope: 'none',
      requiresApproval: false,
    });
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
});
