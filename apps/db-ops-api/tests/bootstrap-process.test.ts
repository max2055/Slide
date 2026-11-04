import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { trackBootstrapProcess } from './bootstrap-process.js';

function launch(source = 'setInterval(() => {}, 1000); console.log("ready")') {
  return trackBootstrapProcess(spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}
describe('MAX-266 bootstrap process cleanup', () => {
  it('handles signal exit with null exitCode and an already absent group, repeatedly', async () => {
    const owned = launch();
    try {
      await once(owned.child.stdout!, 'data');
      process.kill(-owned.child.pid!, 'SIGTERM');
      await owned.closed;
      expect(owned.child.exitCode).toBeNull();
      expect(owned.child.signalCode).toBe('SIGTERM');
      await owned.stop(); await owned.stop();
      expect(() => process.kill(-owned.child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally { await owned.stop(); }
  });
  it('observes close before stop for normal exits and preserves failure exit codes', async () => {
    for (const code of [0, 7]) {
      const owned = launch(`process.exit(${code})`);
      expect((await owned.closed).code).toBe(code);
      await owned.stop();
      expect(owned.child.exitCode).toBe(code);
    }
  });
  it('escalates a TERM-ignoring child and waits for close without a listener race', async () => {
    const owned = launch('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")');
    try {
      await once(owned.child.stdout!, 'data');
      await owned.stop(50);
      expect((await owned.closed).signal).toBe('SIGKILL');
      expect(() => process.kill(-owned.child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally { await owned.stop(); }
  });
  it('does not swallow permission errors', async () => {
    const owned = launch();
    try {
      await once(owned.child.stdout!, 'data');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
      try { await expect(owned.stop(1)).rejects.toMatchObject({ code: 'EPERM' }); }
      finally { kill.mockRestore(); }
    } finally { await owned.stop(); }
  });
  it('rejects cleanup timeout instead of counting an unclosed child as success', async () => {
    const owned = launch();
    try {
      await once(owned.child.stdout!, 'data');
      vi.useFakeTimers();
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      try {
        const rejected = expect(owned.stop(1)).rejects.toThrow('did not close after SIGKILL');
        await vi.advanceTimersByTimeAsync(5_001);
        await rejected;
      } finally { kill.mockRestore(); vi.useRealTimers(); }
    } finally { await owned.stop(); }
  });
});
