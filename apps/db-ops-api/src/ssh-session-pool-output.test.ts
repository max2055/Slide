import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SshSessionPool } from './ssh-session-pool.js';

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  close = vi.fn(() => this.emit('close'));
}

function fakeClient(channel: FakeChannel) {
  return {
    exec: vi.fn((_command: string, callback: (error?: Error, channel?: FakeChannel) => void) => {
      callback(undefined, channel);
    }),
  } as any;
}

describe('SshSessionPool command output boundary', () => {
  afterEach(() => vi.useRealTimers());

  it('returns channel exit metadata without rejecting a non-zero exit code', async () => {
    const channel = new FakeChannel();
    const pending = new SshSessionPool().execCommands(fakeClient(channel), ['fixed-command']);

    channel.emit('data', Buffer.from('out'));
    channel.stderr.emit('data', Buffer.from('warning'));
    channel.emit('close', 7, 'TERM');

    await expect(pending).resolves.toEqual([{
      stdout: 'out',
      stderr: 'warning',
      exitCode: 7,
      signal: 'TERM',
      truncated: false,
    }]);
  });

  it('closes the channel and rejects with a stable timeout code', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    const secretCommand = 'read /sensitive/database/path';
    const pending = new SshSessionPool().execCommands(
      fakeClient(channel),
      [secretCommand],
      { timeoutMs: 20 },
    );

    const rejection = expect(pending).rejects.toThrow('SSH_COMMAND_TIMEOUT');
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(channel.close).toHaveBeenCalledOnce();
    await expect(pending).rejects.not.toThrow(secretCommand);
  });

  it('caps stdout and stderr together by bytes and never leaks the command', async () => {
    const channel = new FakeChannel();
    const secretCommand = 'cat /private/customer/path';
    const pending = new SshSessionPool().execCommands(
      fakeClient(channel),
      [secretCommand],
      { maxOutputBytes: 5 },
    );

    channel.emit('data', Buffer.from('123'));
    channel.stderr.emit('data', Buffer.from('456'));

    await expect(pending).rejects.toThrow('SSH_COMMAND_OUTPUT_LIMIT');
    await expect(pending).rejects.not.toThrow(secretCommand);
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it('sanitizes synchronous client execution errors', async () => {
    const secretCommand = 'stat /private/tenant/path';
    const client = {
      exec: () => { throw new Error(`failed to execute ${secretCommand}`); },
    } as any;

    const pending = new SshSessionPool().execCommands(client, [secretCommand]);
    await expect(pending).rejects.toThrow('SSH_COMMAND_FAILED');
    await expect(pending).rejects.not.toThrow(secretCommand);
  });
});
