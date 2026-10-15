import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { diagnosticCommands, ServerDiagnosticService } from './server-diagnostic-service.js';
import { SshSessionPool } from './ssh-session-pool.js';

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
      '--no-pager', '--quiet', '--output=json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_PID', '--since=-5', 'minutes', '--priority=warning', '--lines=200',
    ]);
  });

  it('passes the fixed five-minute window as one argument and preserves all other bounds', () => {
    expect(journalArguments(command)).toEqual([
      '--no-pager', '--quiet', '--output=json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_PID', '--since=-5 minutes', '--priority=warning', '--lines=200',
    ]);
  });
});

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null, truncated: false });
function journalLine(bytes = 1024) {
  const row = { MESSAGE: '', PRIORITY: '4', _SYSTEMD_UNIT: 'sshd.service', SYSLOG_IDENTIFIER: 'sshd', _PID: '42', __REALTIME_TIMESTAMP: '1723248000000000' };
  row.MESSAGE = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(row)) - 1);
  return JSON.stringify(row) + '\n';
}
function setup(stdout: string, journalExit = 0, transportLimit = false) {
  const closeConnection = vi.fn(), releaseConnection = vi.fn();
  const execCommands = vi.fn(async (_: unknown, commands: string[], options: {timeoutMs?: number; maxOutputBytes?: number}) => commands.map(command => {
    expect(options.timeoutMs).toBe(15_000);
    expect(options.maxOutputBytes).toBeLessThanOrEqual(128 * 1024);
    if (command.includes('uname')) return ok('Linux\n');
    if (command.includes('systemctl')) return ok('sshd.service loaded active running SSH daemon\n');
    if (command.includes('ss -lntup')) return ok('tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n');
    if (command.includes('ps -eo')) return ok('42 sshd 1.0 0.2\n');
    if (command.includes('/proc/net/dev')) return ok(' eth0: 100 0 2 3 0 0 0 0 200 0 4 5 0 0 0 0\n');
    if (command.includes('journalctl')) {
      if (transportLimit) throw new Error('SSH_COMMAND_OUTPUT_LIMIT');
      return { ...ok(stdout), exitCode: journalExit };
    }
    if (command.includes('tail')) return ok('fallback token=private\n');
    throw new Error('UNEXPECTED_COMMAND');
  }));
  const service = new ServerDiagnosticService({
    serverDatabaseService: {
      getServerById: vi.fn().mockResolvedValue({ id: 1, host: 'task.invalid', port: 22, os_type: 'kylin', credential_type: 'password' }),
      getDecryptedCredentials: vi.fn().mockResolvedValue({ username: 'test', password: 'test-only' }),
    } as any,
    sshSessionPool: { getConnection: vi.fn().mockResolvedValue({}), execCommands, releaseConnection, closeConnection } as any,
  });
  return { service, execCommands, closeConnection, releaseConnection };
}

describe('MAX-175 journal projection and existing parser capacity', () => {
  it.each([128 * 1024, 128 * 1024 + 1])('enforces the real SSH byte guard at %i bytes', async bytes => {
    const channel = Object.assign(new EventEmitter(), {stderr:new EventEmitter(),close:vi.fn()});
    const client = {exec: (_:string, cb:Function) => cb(undefined,channel)} as any;
    const pending = new SshSessionPool().execCommands(client,['fixed-journal-command'],{timeoutMs:15_000,maxOutputBytes:128*1024});
    channel.emit('data',Buffer.alloc(bytes,120));
    if(bytes>128*1024) {
      await expect(pending).rejects.toThrow('SSH_COMMAND_OUTPUT_LIMIT');
      expect(channel.close).toHaveBeenCalledOnce();
    } else {
      channel.emit('close',0,null);
      const result=await pending;
      expect(Buffer.byteLength(result[0].stdout)).toBe(bytes);
      expect(result[0].truncated).toBe(false);
    }
  });
  it('keeps small complete output good, original time and redaction', async () => {
    const {service} = setup(journalLine().replace('xxxx', 'token=secret '));
    const result = await service.collectDiagnostics(1);
    expect(result.quality).toBe('good');
    expect(result.truncated).toBe(false);
    expect(result.recentSystemLogs).toMatchObject({quality:'good',truncated:false});
    expect(result.recentSystemLogs.reason).toBeUndefined();
    expect(result.recentSystemLogs.items[0].timestamp).toBe('2024-08-10T00:00:00.000Z');
    expect(result.recentSystemLogs.items[0].message).not.toContain('secret');
  });

  it('does not degrade exactly 64 KiB of complete lines', async () => {
    const result = await setup(journalLine().repeat(64)).service.collectDiagnostics(1);
    expect(result.quality).toBe('good');
    expect(result.recentSystemLogs.items).toHaveLength(64);
    expect(result.recentSystemLogs.truncated).toBe(false);
  });

  it('keeps complete-line truncation partial in the section, alias, cache and summary', async () => {
    const {service} = setup(journalLine().repeat(65));
    const result = await service.collectDiagnostics(1);
    expect(result.recentSystemLogs).toMatchObject({quality:'partial',truncated:true,reason:'JOURNAL_OUTPUT_TRUNCATED'});
    expect(result.sections.systemLogs).toEqual(result.recentSystemLogs);
    expect(result.recentSystemLogs.items).toHaveLength(64);
    expect(result).toMatchObject({quality:'partial',truncated:true});
    expect(service.getCachedDiagnostics(1)).toEqual(result);
    expect(await service.getDiagnostics(1)).toEqual(result);
  });

  it('preserves malformed JSON reason for a cut final line as well as truncation', async () => {
    const result = await setup(journalLine(1000).repeat(70)).service.collectDiagnostics(1);
    expect(result.recentSystemLogs).toMatchObject({quality:'partial',truncated:true,reason:'JOURNAL_JSON_MALFORMED'});
    expect(result.recentSystemLogs.items).toHaveLength(65);
    expect(result).toMatchObject({quality:'partial',truncated:true});
  });

  it('reports malformed small JSON separately from capacity truncation', async () => {
    const result = await setup(journalLine() + '{broken}\n').service.collectDiagnostics(1);
    expect(result.recentSystemLogs).toMatchObject({quality:'partial',truncated:false,reason:'JOURNAL_JSON_MALFORMED'});
  });

  it('keeps the 128 KiB transport guard fatal without fallback or cache success', async () => {
    const {service,execCommands,closeConnection,releaseConnection} = setup('',0,true);
    await expect(service.collectDiagnostics(1)).rejects.toThrow('SSH_COMMAND_OUTPUT_LIMIT');
    expect(execCommands.mock.calls.some(c => c[1][0].includes('tail'))).toBe(false);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(releaseConnection).not.toHaveBeenCalled();
    expect(service.getCachedDiagnostics(1)).toBeNull();
  });

  it('retains partial, redacted messages fallback when journal is unavailable', async () => {
    const result = await setup('',1).service.collectDiagnostics(1);
    expect(result.recentSystemLogs).toMatchObject({quality:'partial',reason:'JOURNAL_UNAVAILABLE_FALLBACK_MESSAGES'});
    expect(result.recentSystemLogs.items[0].message).not.toContain('private');
  });
});
