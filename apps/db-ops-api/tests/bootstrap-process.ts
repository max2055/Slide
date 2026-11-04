import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Only for detached process groups spawned by the bootstrap acceptance harness. */
export function trackBootstrapProcess(child: ChildProcess) {
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  // Register before any signal/await: close may arrive before stop() is called.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  function signalGroup(signal: NodeJS.Signals | 0) {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }
  async function waitClosed(ms: number) {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
  return {
    child,
    closed,
    async stop(graceMs = 10_000) {
      signalGroup('SIGTERM');
      if (!await waitClosed(graceMs)) {
        signalGroup('SIGKILL');
        if (!await waitClosed(5_000)) throw new Error(`Bootstrap child ${child.pid} did not close after SIGKILL`);
      }
      // A wrapper may close while a descendant without inherited pipes survives.
      if (signalGroup(0)) {
        signalGroup('SIGKILL');
        for (let i = 0; i < 50 && signalGroup(0); i++) await delay(100);
        if (signalGroup(0)) throw new Error(`Bootstrap process group ${child.pid} still exists after SIGKILL`);
      }
      if (spawnError) throw spawnError;
    },
  };
}
