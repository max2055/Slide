import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { diagnosticCommands } from './server-diagnostic-service.js';

// Execute the production command through a real POSIX shell. A shell function
// records argv without requiring journald on the machine running unit tests.
function journalArguments(command: string): string[] {
  const result = spawnSync('/bin/sh', ['-c', `journalctl() { printf '%s\\0' "$@"; }; ${command}`], {
    encoding: 'utf8', timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.split('\0').slice(0, -1);
}

describe('MAX-175 journalctl time argument boundary', () => {
  const command = diagnosticCommands().find(value => value.includes('journalctl'))!;

  it('demonstrates that the original unquoted window becomes an extra journal match', () => {
    const legacy = command.replace('--since="-5 minutes"', '--since=-5 minutes');
    expect(journalArguments(legacy)).toEqual([
      '--no-pager', '--quiet', '--output=json', '--since=-5', 'minutes', '--priority=warning', '--lines=200',
    ]);
  });

  it('passes the fixed five-minute window as one argument and preserves all other bounds', () => {
    expect(journalArguments(command)).toEqual([
      '--no-pager', '--quiet', '--output=json', '--since=-5 minutes', '--priority=warning', '--lines=200',
    ]);
  });
});
