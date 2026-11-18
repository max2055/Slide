export interface WorkerCleanup {
  name: string;
  stop: () => unknown | Promise<unknown>;
}

export interface WorkerDrainEvent {
  consumer: string;
  state: 'stopping' | 'drained' | 'failed';
}

/** Preserve every consumer's terminal result without logging driver errors or secrets. */
export async function drainWorkers(cleanups: WorkerCleanup[], report: (event: WorkerDrainEvent) => void): Promise<void> {
  const emit = (event: WorkerDrainEvent) => {
    try { report(event); } catch { /* Reporting must not skip cleanup. */ }
  };
  const results = await Promise.allSettled(cleanups.map(async cleanup => {
    emit({ consumer: cleanup.name, state: 'stopping' });
    try {
      await cleanup.stop();
      emit({ consumer: cleanup.name, state: 'drained' });
    } catch (error) {
      emit({ consumer: cleanup.name, state: 'failed' });
      throw error;
    }
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw new Error('WORKER_DRAIN_FAILED', { cause: failed.reason });
}
