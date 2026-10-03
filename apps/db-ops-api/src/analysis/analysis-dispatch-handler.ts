import { instanceAccessLifecycle } from '../resources/instance-access-lifecycle.js';
import type { IAgentEngine } from '../adapter/types.js';
import type { JobRegistry } from '../workflows/job-registry.js';
import type { AnalysisDispatchStore, AnalysisRequest } from './analysis-dispatch-store.js';
import type { analysisConfigurationVersion } from './analysis-identity.js';

export interface AnalysisHandlerDependencies {
  store: AnalysisDispatchStore;
  engine: () => Promise<IAgentEngine>;
  authorize: (request: AnalysisRequest) => Promise<void>;
  configurationVersion: typeof analysisConfigurationVersion;
}

export function registerAnalysisDispatchHandler(registry: JobRegistry, deps: AnalysisHandlerDependencies): void {
  registry.register('analysis.dispatch', async (payload, job, context) => {
    if (!Number.isSafeInteger(payload.analysisId) || Number(payload.analysisId) <= 0) throw new Error('ANALYSIS_ID_INVALID');
    const owned = await deps.store.claim(Number(payload.analysisId), job, context);
    if (!owned) return; // Completed or unknown is never replayed.
    const targetId = owned.request.subject.type === 'instance' ? owned.request.subject.id : undefined;
    const signal = targetId === undefined ? context.signal : AbortSignal.any([context.signal, instanceAccessLifecycle.signal(targetId)]);
    let completionWriteFailed = false;
    const check = async () => {
      signal.throwIfAborted();
      if (process.env.ANALYSIS_DISPATCH_ENABLED === 'false') throw new Error('ANALYSIS_DISPATCH_DISABLED');
      if (completionWriteFailed) throw new Error('ANALYSIS_COMPLETION_WRITE_UNCONFIRMED');
      if (targetId !== undefined) {
        try { await instanceAccessLifecycle.assertAvailable(targetId); } catch { throw new Error('ANALYSIS_SUBJECT_DELETED'); }
      }
      await deps.authorize(owned.request);
      if (await deps.configurationVersion(owned.request.purpose, owned.request.systemPrompt) !== owned.request.configVersion) throw new Error('ANALYSIS_CONFIGURATION_CHANGED');
      signal.throwIfAborted();
    };
    try {
      await check();
      const engine = await deps.engine();
      signal.throwIfAborted();
      const invoke = () => engine.invoke(owned.request.sessionKey!, owned.request.message, owned.request.systemPrompt, {
        purpose: owned.request.purpose, analysisId: owned.analysisId, signal,
        runtimeRunId: owned.runtimeRunId,
        recordAnalysisExecution: async event => { await deps.store.recordExecution(owned, event); },
        beforeProviderRequest: async () => { await check(); await deps.store.beforeSend(owned); },
        completeAnalysis: async envelope => {
          await check();
          try { return await deps.store.completeEnvelope(owned, envelope); }
          catch (error) { completionWriteFailed = true; throw error; }
        },
      });
      const result = await (targetId === undefined ? invoke() : instanceAccessLifecycle.track(targetId, invoke));
      const known = result.stopReason === 'completed' && !result.error;
      if (known) await deps.store.responded(owned);
      const settled = await deps.store.fail(owned, known ? 'ANALYSIS_ENVELOPE_NOT_SAVED' : 'ANALYSIS_PROVIDER_RESULT_UNKNOWN', known);
      if (!settled) throw new Error('ANALYSIS_UNSENT_RETRY');
    } catch (error) {
      // Expired owners cannot write. The wired scan/new claimant reconciles their intent.
      const reason = error instanceof Error && /^ANALYSIS_[A-Z_]+$/.test(error.message) ? error.message : 'ANALYSIS_EXECUTION_INTERRUPTED';
      await deps.store.fail(owned, reason, false, /^ANALYSIS_(AUTHORITY_REVOKED|CONFIGURATION_CHANGED|SUBJECT_DELETED|AUTOMATION_DISABLED)$/.test(reason)).catch(() => {});
      throw error;
    }
  });
}
