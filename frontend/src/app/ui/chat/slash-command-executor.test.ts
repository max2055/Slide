import { describe, it, expect, vi } from 'vitest';
import { executeSlashCommand } from './slash-command-executor.ts';
import { SLASH_COMMANDS } from './slash-commands.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';

const run = async (name: string, row: Record<string, unknown> = {}, args = '') => {
  const request = vi.fn().mockResolvedValue({ sessions: [{ key: 'main', ...row }] });
  const result = await executeSlashCommand({ request } as unknown as DirectGatewayClient, 'main', name, args);
  return { result, request };
};

describe('MAX-626 /usage trustworthy statistics (#413)', () => {
  it('does not substitute message count or zero for missing token fields', async () => {
    const { result } = await run('usage', { message_count: 100 });
    expect(result.content).toContain('Input: 不可用');
    expect(result.content).toContain('Output: 不可用');
    expect(result.content).toContain('Total: 不可用');
    expect(result.content).toContain('Context: 不可用');
    expect(result.content).not.toContain('**0**');
  });
  it('preserves actual zero and nonzero measurements', async () => {
    expect((await run('usage', { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).result.content).toContain('Total: **0** tokens');
    const { result } = await run('usage', { inputTokens: 1200, outputTokens: 300 });
    expect(result.content).toContain('Total: **1.5k** tokens');
    expect(result.content).toContain('Context: 不可用');
  });
  it.each([null, -1, NaN, Infinity, '10'])('rejects untrusted numeric value %s', async value => {
    expect((await run('usage', { inputTokens: value, outputTokens: 2 })).result.content).toContain('Total: 不可用');
  });
});

it('MAX-644 /help groups all commands under one heading per category (#712)', async () => {
  const { result } = await run('help');
  const categories = [...new Set(SLASH_COMMANDS.map(c => c.category ?? 'session'))];
  for (const cat of categories) {
    const title = `**${cat.charAt(0).toUpperCase() + cat.slice(1)}**`;
    expect(result.content.split(title)).toHaveLength(2);
    const block = result.content.split(title)[1].split('\n**')[0];
    for (const cmd of SLASH_COMMANDS.filter(c => (c.category ?? 'session') === cat)) expect(block).toContain(`/${cmd.name}`);
  }
});

it('MAX-628 steer delegates active-run authority and MAX-641 suggests only available actions (#414/#644)', async () => {
  const request = vi.fn().mockResolvedValue({ status: 'no_active_run' });
  const result = await executeSlashCommand({ request } as unknown as DirectGatewayClient, 'main', 'steer', 'hello');
  expect(request).toHaveBeenCalledWith('chat.steer', { sessionKey: 'main', message: 'hello' });
  expect(result.content).not.toContain('/redirect');
  expect(result.content).toContain('聊天输入框');
  expect(request).not.toHaveBeenCalledWith('chat.send', expect.anything());
});

it('steer marks unknown side effects without replay and ignores cached running status', async () => {
  const request = vi.fn().mockRejectedValue(new Error('lost acknowledgement'));
  const result = await executeSlashCommand({ request } as unknown as DirectGatewayClient, 'B', 'steer', 'hello', {
    sessionsResult: { sessions: [{ key: 'A', status: 'running' }] } as never,
  });
  expect(request).toHaveBeenCalledExactlyOnceWith('chat.steer', { sessionKey: 'B', message: 'hello' });
  expect(result.failure).toBe('unknown');
});

it('steer resolves an ended descendant explicitly without falling back to its parent', async () => {
  const request = vi.fn().mockResolvedValue({ status: 'no_active_run' });
  const result = await executeSlashCommand({ request } as unknown as DirectGatewayClient, 'agent:main:parent', 'steer', 'child hello', {
    sessionsResult: { sessions: [{ key: 'agent:main:subagent:child', spawnedBy: 'agent:main:parent', endedAt: 1 }] } as never,
  });
  expect(request).toHaveBeenCalledWith('chat.steer', { sessionKey: 'agent:main:subagent:child', message: 'hello' });
  expect(result.content).not.toContain('/redirect');
});
