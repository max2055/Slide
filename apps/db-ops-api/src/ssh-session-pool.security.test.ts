import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintSshHostKey } from './security/ssh-host-key.js';

const mocks = vi.hoisted(() => ({
  authorizeTarget: vi.fn(),
  connectConfigs: [] as any[],
  clients: [] as any[],
  holdReady: false,
  held: [] as Array<{ fire: () => void }>,
  endMode: 'silent' as 'silent' | 'close' | 'close-and-error',
}));

vi.mock('./security/server-target-policy', () => ({
  authorizeServerTarget: mocks.authorizeTarget,
}));

vi.mock('ssh2', () => ({
  Client: class {
    private handlers: Record<string, (...args: any[]) => void> = {};
    end = vi.fn(() => {
      if (mocks.endMode === 'silent') return;
      this.handlers.close?.();
      if (mocks.endMode === 'close-and-error') {
        this.handlers.error?.(new Error('SSH_SOCKET_CLOSED'));
      }
    });
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
    connect(config: any) {
      mocks.connectConfigs.push(config);
      mocks.clients.push(this);
      const fire = () => {
        if (config.password === 'reject-auth' || config.privateKey === 'reject-auth') {
          this.handlers.error?.(new Error('SSH_AUTH_FAILED'));
          return;
        }
        this.handlers.ready?.();
      };
      if (mocks.holdReady) {
        mocks.held.push({ fire });
        return;
      }
      queueMicrotask(fire);
    }
    exec() {}
  },
}));

import sshSessionPool from './ssh-session-pool.js';

describe('SSH session pool target and identity controls', () => {
  beforeEach(() => {
    mocks.connectConfigs.length = 0;
    mocks.clients.length = 0;
    mocks.held.length = 0;
    mocks.holdReady = false;
    mocks.endMode = 'silent';
    mocks.authorizeTarget.mockReset().mockResolvedValue({
      hostname: 'ssh.internal.example',
      address: '10.20.30.40',
      port: 22,
    });
  });

  afterEach(() => sshSessionPool.closeAll());

  it('authorizes every acquisition, pins the socket address, and verifies a stored host key', async () => {
    const key = Buffer.from('known-host-key');
    await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', 'secret', fingerprintSshHostKey(key),
    );

    expect(mocks.authorizeTarget).toHaveBeenCalledWith({ host: 'ssh.internal.example', port: 22 });
    expect(mocks.connectConfigs[0].host).toBe('10.20.30.40');
    expect(mocks.connectConfigs[0].hostVerifier(key)).toBe(true);
    expect(mocks.connectConfigs[0].hostVerifier(Buffer.from('wrong-key'))).toBe(false);
  });

  it('connects without installing a host verifier when the stored fingerprint is absent', async () => {
    await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', 'secret', null,
    );
    expect(mocks.connectConfigs).toHaveLength(1);
    expect(mocks.connectConfigs[0]).not.toHaveProperty('hostVerifier');
  });

  it('reuses one idle session only for the same account, credential, and host key', async () => {
    const fingerprint = fingerprintSshHostKey(Buffer.from('known-host-key'));
    const secret = 'root-secret-not-for-logs';
    const first = await sshSessionPool.getConnection(
      'SSH.internal.example', 22, 'root', 'password', secret, fingerprint,
    );
    sshSessionPool.releaseConnection(first);

    const reused = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', secret, `${fingerprint}=`,
    );
    expect(reused).toBe(first);
    expect(mocks.connectConfigs).toHaveLength(1);
    sshSessionPool.releaseConnection(reused);

    const otherAccount = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', secret, fingerprint,
    );
    expect(otherAccount).not.toBe(first);
    expect((first as any).end).not.toHaveBeenCalled();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 2, idle: 1, active: 1 });
    sshSessionPool.releaseConnection(otherAccount);

    await expect(sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'reject-auth', fingerprint,
    )).rejects.toThrow('SSH_AUTH_FAILED');
    expect((first as any).end).not.toHaveBeenCalled();
    const stillRoot = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', secret, fingerprint,
    );
    expect(stillRoot).toBe(first);
  });

  it('ends the old session when the password, key, or host fingerprint changes', async () => {
    const fingerprint = fingerprintSshHostKey(Buffer.from('known-host-key'));
    const rotatedFingerprint = fingerprintSshHostKey(Buffer.from('rotated-host-key'));
    const root = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'old-password', fingerprint,
    );

    const changedPassword = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'new-password', fingerprint,
    );
    expect(changedPassword).not.toBe(root);
    expect((root as any).end).toHaveBeenCalledOnce();
    sshSessionPool.releaseConnection(changedPassword);

    const changedType = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'key', 'new-password', fingerprint,
    );
    expect(changedType).not.toBe(changedPassword);
    expect((changedPassword as any).end).toHaveBeenCalledOnce();
    sshSessionPool.releaseConnection(changedType);

    const changedHostKey = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'key', 'new-password', rotatedFingerprint,
    );
    expect(changedHostKey).not.toBe(changedType);
    expect((changedType as any).end).toHaveBeenCalledOnce();
    expect(mocks.connectConfigs).toHaveLength(4);
    expect(JSON.stringify(sshSessionPool.getPoolStats())).not.toContain('old-password');
    expect(JSON.stringify(sshSessionPool.getPoolStats())).not.toContain('new-password');
  });

  it('revokes one account on the shared pool without closing another account or logging the secret', async () => {
    const secret = 'revoked-private-key-material';
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => (
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(' '));
      })
    ));
    try {
      const root = await sshSessionPool.getConnection(
        'ssh.internal.example', 22, 'root', 'key', secret, null,
      );
      const operator = await sshSessionPool.getConnection(
        'ssh.internal.example', 22, 'operator', 'key', 'operator-key', null,
      );
      sshSessionPool.releaseConnection(root);
      sshSessionPool.releaseConnection(operator);

      expect(sshSessionPool.revokeSessions({
        host: ' SSH.internal.example ',
        port: 22,
        username: 'root',
        credentialType: 'key',
        credentialValue: secret,
      })).toBe(1);
      expect((root as any).end).toHaveBeenCalledOnce();
      expect((operator as any).end).not.toHaveBeenCalled();
      expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 1, idle: 1, active: 0 });

      const again = await sshSessionPool.getConnection(
        'ssh.internal.example', 22, 'root', 'key', secret, null,
      );
      expect(again).not.toBe(root);
      expect(sshSessionPool.revokeSessions({ host: 'ssh.internal.example', port: 22 })).toBe(2);

      expect(() => sshSessionPool.revokeSessions({
        host: 'ssh.internal.example',
        port: 22,
        credentialValue: secret,
      })).toThrow('SSH_REVOCATION_CREDENTIAL_TYPE_REQUIRED');
      await expect(sshSessionPool.getConnection(
        'ssh.internal.example', 22, 'root', 'password', secret, 'not-a-fingerprint',
      )).rejects.toThrow('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
      await expect(sshSessionPool.getConnection(
        'ssh.internal.example', 22, 'root', 'password', secret, 'not-a-fingerprint',
      )).rejects.not.toThrow(secret);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }

    const observed = `${lines.join('\n')}\n${JSON.stringify(mocks.connectConfigs.map((config) => Object.keys(config)))}`;
    expect(observed).not.toContain(secret);
    expect(mocks.connectConfigs.some((config) => config.privateKey === secret)).toBe(true);
  });

  it('cancels an acquisition revoked during authorization before it connects', async () => {
    const secret = 'authorize-window-secret';
    const pooled = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', secret, null,
    );
    sshSessionPool.releaseConnection(pooled);
    const pending = sshSessionPool.getConnection(
      ' SSH.internal.example ', 22, 'operator', 'password', secret, null,
    );
    const otherAccount = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'other-account-secret', null,
    );

    expect(sshSessionPool.revokeSessions({
      host: 'ssh.internal.example',
      port: 22,
      username: 'operator',
      credentialType: 'password',
      credentialValue: secret,
    })).toBe(2);
    await expect(pending).rejects.toThrow('SSH_SESSION_REVOKED');
    await expect(pending).rejects.not.toThrow(secret);
    const kept = await otherAccount;
    expect((kept as any).end).not.toHaveBeenCalled();
    expect(mocks.connectConfigs).toHaveLength(2);
    expect((pooled as any).end).toHaveBeenCalledOnce();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 1, idle: 0, active: 1 });

    const replacement = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', secret, null,
    );
    expect(replacement).not.toBe(pooled);
    expect((kept as any).end).not.toHaveBeenCalled();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 2, active: 2 });
  });

  it('drops a ready login that was already connecting when its identity was revoked', async () => {
    const fingerprint = fingerprintSshHostKey(Buffer.from('known-host-key'));
    const otherFingerprint = fingerprintSshHostKey(Buffer.from('other-host-key'));
    const oldSecret = 'connecting-old-secret';
    const otherSecret = 'connecting-other-secret';
    const revoked = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', oldSecret, fingerprint,
    );
    const otherAccount = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', otherSecret, fingerprint,
    );
    const otherKey = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'key', oldSecret, otherFingerprint,
    );
    await Promise.resolve();
    expect(mocks.connectConfigs).toHaveLength(3);

    expect(sshSessionPool.revokeSessions({
      host: 'ssh.internal.example',
      port: 22,
      username: 'operator',
      credentialType: 'password',
      credentialValue: oldSecret,
      hostKeyFingerprint: fingerprint,
    })).toBe(1);
    await expect(revoked).rejects.toThrow('SSH_SESSION_REVOKED');
    await expect(revoked).rejects.not.toThrow(oldSecret);
    expect((mocks.clients[0] as any).end).toHaveBeenCalled();

    const keptAccount = await otherAccount;
    const keptKey = await otherKey;
    expect((keptAccount as any).end).not.toHaveBeenCalled();
    expect((keptKey as any).end).not.toHaveBeenCalled();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 2, active: 2 });
    sshSessionPool.releaseConnection(keptAccount);

    const reused = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', otherSecret, fingerprint,
    );
    expect(reused).toBe(keptAccount);
    expect(mocks.connectConfigs).toHaveLength(3);
  });

  it('discards an older login that finishes after a newer identity is pooled', async () => {
    const fingerprint = fingerprintSshHostKey(Buffer.from('known-host-key'));
    mocks.holdReady = true;
    const oldPending = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'old-password', fingerprint,
    );
    const newPending = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'new-password', fingerprint,
    );
    await Promise.resolve();
    expect(mocks.held).toHaveLength(2);

    mocks.held[1].fire();
    const newer = await newPending;
    mocks.held[0].fire();
    await expect(oldPending).rejects.toThrow('SSH_SESSION_SUPERSEDED');
    await expect(oldPending).rejects.not.toThrow('old-password');
    expect((mocks.clients[0] as any).end).toHaveBeenCalled();
    expect((newer as any).end).not.toHaveBeenCalled();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 1, active: 1 });

    sshSessionPool.releaseConnection(newer);
    mocks.holdReady = false;
    const reused = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'new-password', fingerprint,
    );
    expect(reused).toBe(newer);

    const laterOld = await sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'old-password', fingerprint,
    );
    expect(laterOld).not.toBe(newer);
    expect((newer as any).end).toHaveBeenCalledOnce();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 1, active: 1 });
  });

  it('settles a revoked handshake when the socket closes without ready or error', async () => {
    const secret = 'close-only-secret';
    mocks.holdReady = true;
    mocks.endMode = 'close';
    const revoked = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', secret, null,
    );
    const otherAccount = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'root', 'password', 'kept-secret', null,
    );
    await Promise.resolve();
    expect(mocks.connectConfigs).toHaveLength(2);

    expect(sshSessionPool.revokeSessions({
      host: 'ssh.internal.example',
      port: 22,
      username: 'operator',
      credentialType: 'password',
      credentialValue: secret,
    })).toBe(1);
    await expect(revoked).rejects.toThrow('SSH_SESSION_REVOKED');
    await expect(revoked).rejects.not.toThrow(secret);
    expect((sshSessionPool as any).inflight).toHaveLength(1);
    expect((mocks.clients[0] as any).end).toHaveBeenCalledOnce();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 0 });

    mocks.held[1].fire();
    const kept = await otherAccount;
    expect((kept as any).end).not.toHaveBeenCalled();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 1, active: 1 });
    expect((sshSessionPool as any).inflight).toHaveLength(0);
  });

  it('settles a revoked handshake when the transport emits no further event', async () => {
    mocks.holdReady = true;
    mocks.endMode = 'silent';
    const revoked = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', 'silent-secret', null,
    );
    await Promise.resolve();
    expect(mocks.held).toHaveLength(1);

    expect(sshSessionPool.revokeSessions({
      host: 'ssh.internal.example',
      port: 22,
      username: 'operator',
    })).toBe(1);
    await expect(revoked).rejects.toThrow('SSH_SESSION_REVOKED');
    expect((sshSessionPool as any).inflight).toHaveLength(0);
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 0 });

    mocks.held[0].fire();
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 0 });
    expect((sshSessionPool as any).inflight).toHaveLength(0);
  });

  it('settles a revoked handshake once when close, error, and ready all arrive', async () => {
    mocks.holdReady = true;
    mocks.endMode = 'close-and-error';
    const secret = 'duplicate-event-secret';
    let settlements = 0;
    const revoked = sshSessionPool.getConnection(
      'ssh.internal.example', 22, 'operator', 'password', secret, null,
    ).then(
      () => { settlements += 1; return 'resolved'; },
      (error: Error) => { settlements += 1; return error.message; },
    );
    await Promise.resolve();

    expect(sshSessionPool.revokeSessions({
      host: 'ssh.internal.example',
      port: 22,
      username: 'operator',
      credentialType: 'password',
      credentialValue: secret,
    })).toBe(1);
    mocks.held[0].fire();
    (mocks.clients[0] as any).end();
    await expect(revoked).resolves.toBe('SSH_SESSION_REVOKED');
    expect(settlements).toBe(1);
    expect(sshSessionPool.getPoolStats()).toMatchObject({ total: 0 });
    expect((sshSessionPool as any).inflight).toHaveLength(0);
  });
});
