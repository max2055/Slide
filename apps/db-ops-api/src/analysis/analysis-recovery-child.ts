import mysql from 'mysql2/promise';
import { AnalysisDispatchStore } from './analysis-dispatch-store.js';
import { MysqlWorkflowStore } from '../workflows/worker-runtime.js';
import { JobRegistry } from '../workflows/job-registry.js';
import { registerAnalysisDispatchHandler } from './analysis-dispatch-handler.js';

const window = process.argv[2];
const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.ANALYSIS_TEST_MYSQL_PORT), user: 'root', password: process.env.ANALYSIS_TEST_MYSQL_PASSWORD ?? '', database: process.env.ANALYSIS_TEST_DATABASE, timezone: 'Z' });
const store = new AnalysisDispatchStore(() => pool);
const workflows = new MysqlWorkflowStore(() => pool as any);
const analysisId = Number(process.env.ANALYSIS_TEST_ID);
const pause = async (at: string): Promise<never> => { process.send?.({ at }); return new Promise(() => {}); };
if (window === 'committed') await pause('committed');
const job = (await workflows.claim('child', 30))!;
const context = { workerId: 'child', fencingToken: job.fencingToken, signal: new AbortController().signal };
if (window === 'claimed') { await store.claim(analysisId, job, context); await pause('claimed'); }
const registry = new JobRegistry();
registerAnalysisDispatchHandler(registry, {
  store, authorize: async () => {}, configurationVersion: async () => 'c1',
  engine: async () => ({ invoke: async (_session, _message, _prompt, options) => {
    if (window === 'before-send') await pause('before-send');
    await options!.beforeProviderRequest!();
    // The parent kills this process on HTTP acceptance for the sending window,
    // while its fake supplier deliberately withholds the response.
    const response = await fetch(process.env.ANALYSIS_TEST_SUPPLIER!, { method: 'POST', body: String(analysisId) });
    const envelope = await response.json();
    if (window === 'responded') { const owned = { analysisId, job, context, runtimeRunId: options!.runtimeRunId!, request: { purpose: 'fault_diagnosis', subject: { type: 'instance', id: 42 }, message: '', systemPrompt: '', evidenceVersion: 'e1', configVersion: 'c1', authorizationVersion: 'a1' } as const }; await store.responded(owned); await pause('responded'); }
    if (window === 'before-completion') await pause('before-completion');
    await options!.completeAnalysis!(envelope);
    if (window === 'completed') await pause('completed');
    return { content: null, stopReason: 'completed' };
  } } as any),
});
await registry.execute(job, context);
await pool.end();
