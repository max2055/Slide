import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintSshHostKey } from './security/ssh-host-key.js';

const mocks = vi.hoisted(() => ({
  authorizeTarget: vi.fn(),
  connectConfigs: [] as any[],
}));

vi.mock('./security/server-target-policy', () => ({
  authorizeServerTarget: mocks.authorizeTarget,
}));

vi.mock('ssh2', () => ({
  Client: class {
    private handlers: Record<string, (...args: any[]) => void> = {};
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
    connect(config: any) {
      mocks.connectConfigs.push(config);
      queueMicrotask(() => this.handlers.ready?.());
    }
    end() {}
    exec() {}
  },
}));

import sshSessionPool from './ssh-session-pool.js';

describe('SSH session pool target and identity controls', () => {
  beforeEach(() => {
    mocks.connectConfigs.length = 0;
    mocks.authorizeTarget.mockReset().mockResolvedValue({
      hostname: 'ssh.internal.example',
      address: '10.20.30.40',
      port: 22,
    });
  });

  afterEach(() => sshSessionPool.closeAll());

  it('authorizes every acquisition, pins the socket address, and requires the stored host key', async () => {
    const key = Buffer.from('known-host-key');
    await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', 'secret', fingerprintSshHostKey(key),
    );

    expect(mocks.authorizeTarget).toHaveBeenCalledWith({ host: 'ssh.internal.example', port: 22 });
    expect(mocks.connectConfigs[0].host).toBe('10.20.30.40');
    expect(mocks.connectConfigs[0].hostVerifier(key)).toBe(true);
    expect(mocks.connectConfigs[0].hostVerifier(Buffer.from('wrong-key'))).toBe(false);
  });

  it('rejects legacy managed servers that have no trusted fingerprint', async () => {
    await expect(sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', 'secret', null,
    )).rejects.toThrow('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
    expect(mocks.connectConfigs).toHaveLength(0);
  });
});
