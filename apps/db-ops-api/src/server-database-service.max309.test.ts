import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ clients: [] as any[], scenario: 'ready' }));
vi.mock('./db-connection', () => ({ dbConnection: {}, encryptData: vi.fn(), decryptData: vi.fn(), needsEncryptionMigration: vi.fn() }));
vi.mock('./security/server-target-policy.js', () => ({
  authorizeServerTarget: async () => ({ address: '192.0.2.1', port: 22 }),
}));
vi.mock('ssh2', () => ({ Client: class extends EventEmitter {
  end = vi.fn(() => { this.emit('end'); this.emit('close'); return this; });
  destroy = vi.fn(() => { this.emit('close'); return this; });
  connect() {
    state.clients.push(this);
    if (state.scenario === 'throw') throw new Error('Invalid private key');
    queueMicrotask(() => {
      if (state.scenario === 'error' || state.scenario === 'timeout') {
        this.emit('error', new Error(state.scenario === 'timeout' ? 'Timed out while waiting for handshake' : 'Authentication failed'));
      } else this.emit(state.scenario);
      this.emit('error', new Error('late transport error'));
      this.emit('end');
      this.emit('close');
    });
    return this;
  }
} }));
import { serverDatabaseService } from './server-database-service.js';

describe('MAX-309 / #379 event ordering (mock transport)', () => {
  afterEach(() => { state.clients.length = 0; });
  it.each(['ready', 'end', 'close', 'error', 'timeout', 'throw'])('settles once and releases client on %s', async (scenario) => {
    state.scenario = scenario;
    const result = await serverDatabaseService.testConnection('fixture', 22, 'password', 'synthetic', 'max309');
    expect(result.success).toBe(scenario === 'ready');
    if (scenario !== 'ready') expect(result.error).toBeTruthy();
    const client = state.clients[0];
    expect(client.end.mock.calls.length + client.destroy.mock.calls.length).toBe(1);
    if (scenario === 'ready') expect(client.end).toHaveBeenCalledOnce();
    else expect(client.destroy).toHaveBeenCalledOnce();
  });
});
