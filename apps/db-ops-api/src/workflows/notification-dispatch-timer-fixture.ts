// Test-only harness: execute the server's actual timer assembly, including its
// admission guards, without binding ports or constructing unrelated services.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { WorkerStartup } from '../lifecycle/worker-startup.js';
import type { NotificationDispatchReconciler } from './notification-dispatch.js';
import type { BoundedWorkflowRuntime } from './bounded-worker.js';
import type { JobRegistry } from './job-registry.js';

export function mountWorkflowTimer(
  startup: WorkerStartup,
  notificationDispatchReconciler: Pick<NotificationDispatchReconciler, 'ensure'>,
  workflowRuntime: Pick<BoundedWorkflowRuntime, 'runOnce'>,
  workflowRegistry: Pick<JobRegistry, 'execute'>,
  logger: Pick<Console, 'error'> = console,
) {
  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const timerStart = server.indexOf('  workflowTimer = setInterval(() => {');
  const timerEnd = server.indexOf('\n  }, 1_000);', timerStart);
  if (timerStart < 0 || timerEnd < 0) throw new Error('WORKFLOW_TIMER_NOT_FOUND');
  const guards = server.lastIndexOf('  let notificationRepair:', timerStart);
  const assembly = server.slice(guards < 0 ? timerStart : guards, timerEnd + '\n  }, 1_000);'.length);
  const script = ts.transpileModule(`let workflowTimer; let dispatchAvailable = false;
    ${assembly}
    return { timer: workflowTimer, ready: () => dispatchAvailable };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let tick!: () => void;
  const schedule = (callback: () => void, ms: number) => { tick = callback; return setInterval(callback, ms); };
  const mounted = new Function('startup', 'notificationDispatchReconciler', 'workflowRuntime', 'workflowRegistry', 'console', 'setInterval', script)(
    startup, notificationDispatchReconciler, workflowRuntime, workflowRegistry, logger, schedule,
  ) as { timer: ReturnType<typeof setInterval>; ready: () => boolean };
  return { ...mounted, tick: () => tick(), close: () => clearInterval(mounted.timer) };
}
