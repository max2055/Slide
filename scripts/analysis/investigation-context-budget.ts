/**
 * Offline investigation context budget measurement.
 *
 * Uses one recorded real request (fixtures/ops-fs-final-20261024.json) plus the
 * production prompt, policy and tool contracts. No model or provider is called.
 */
import { readFileSync } from 'node:fs';
import { estimatePromptTokens } from '../../packages/agent-core/src/runtime/context-manager.ts';
import { investigationPrompt, INVESTIGATION_PROFILES } from '../../apps/db-ops-api/src/investigations/profiles.ts';
import { MODEL_ANALYSIS_POLICY } from '../../apps/db-ops-api/src/investigations/model-analysis.ts';
import { investigationToolContract, investigationToolPolicy } from '../../apps/db-ops-api/src/investigations/tool-contract.ts';
import { investigationToolContextResult } from '../../apps/db-ops-api/src/investigations/executor.ts';
import { queryMetricsTool } from '../../apps/db-ops-api/src/tools/ops/query_metrics.ts';
import { getInstanceSummaryTool } from '../../apps/db-ops-api/src/tools/ops/get_instance_summary.ts';
import { listActiveAlertsTool } from '../../apps/db-ops-api/src/tools/ops/list_active_alerts.ts';
import { getServerMetricsTool, getServerAlertsTool } from '../../apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts';
import { getResourceObservationsTool, getResourceRelationsTool } from '../../apps/db-ops-api/src/tools/generated/slide-self-mgmt/resource_tools.ts';

const fixture = JSON.parse(readFileSync(new URL('../../apps/db-ops-api/src/investigations/fixtures/ops-fs-final-20261024.json', import.meta.url), 'utf8'));
const profile = INVESTIGATION_PROFILES.ops;
const resources = [{ type: 'server', id: 3 }];

const allowlist = ['get_instance_summary', 'query_metrics', 'list_active_alerts', 'get_server_metrics', 'get_server_alerts', 'get_resource_observations', 'get_resource_relations'];
const all = [getInstanceSummaryTool, queryMetricsTool, listActiveAlertsTool, getServerMetricsTool, getServerAlertsTool, getResourceObservationsTool, getResourceRelationsTool];
const tools = all.filter(tool => allowlist.includes(tool.name))
  .map(tool => investigationToolContract(tool as any, resources, profile.budget))
  .filter(Boolean)
  .map(tool => ({ type: 'function', function: { name: (tool as any).name, description: (tool as any).description, parameters: (tool as any).parameters } })) as any[];

const prompt = investigationPrompt(profile) + investigationToolPolicy(resources, profile.budget);
const messages = fixture.sent.messages as any[];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
const tokens = (slice: any[], toolList: any[] = tools) => estimatePromptTokens(slice, toolList);
// The recorded messages carry the projection that was live when the fixture was
// captured. Re-project the raw receipts with the current code to measure what a
// live request would send now (the model projection never mutates the receipt).
const byId = new Map((Object.values(fixture.receipts ?? {}) as any[]).map(receipt => [receipt.id, receipt]));
const liveMessages = messages.map(message => {
  if (message.role !== 'tool') return message;
  const receipt = byId.get(message.tool_call_id) as any;
  if (!receipt) return message;
  const raw = receipt.rawReceipt && typeof receipt.rawReceipt === 'object'
    ? receipt.rawReceipt : JSON.parse(receipt.rawContent);
  const projected = investigationToolContextResult(raw, receipt.id, 'ops', receipt.name, receipt.arguments);
  return { ...message, content: typeof projected === 'string' ? projected : JSON.stringify(projected) };
});

const cuts = [3, 5, 8, 12, 20];
const windows: Array<[number, number]> = [[16000, 2048], [32768, 4096], [65536, 8192], [294912, 8192]];
const estimateWith = (extraSystem: string, slice: any[]) => {
  const withSystem = [{ role: 'system', content: extraSystem }, ...slice];
  const withTools = tokens(withSystem);
  const withoutTools = tokens(withSystem, []);
  return { total: withTools, messagesOnly: withoutTools, tools: withTools - withoutTools };
};
const summarize = (list: any[]) => {
  const roleBytes: Record<string, number> = {};
  for (const message of list) roleBytes[message.role] = (roleBytes[message.role] ?? 0) + bytes(message);
  const toolResults = list.filter(m => m.role === 'tool')
    .map(m => ({ bytes: bytes(m), head: String(m.content).slice(0, 60).replace(/\s+/g, ' ') }))
    .sort((a, b) => b.bytes - a.bytes);
  const batches = cuts.map(cut => {
    const slice = list.slice(0, cut);
    const estimate = estimateWith(prompt, slice);
    return { messages: cut, fixtureTokens: tokens(slice, []), estimate };
  });
  return { messages: list.length, toolResults: toolResults.length, totalBytes: bytes(list), roleBytes,
    largestToolResults: toolResults.slice(0, 6), batched: batches,
    budgets: windows.map(([window, output]) => {
      const inputBudget = window - output - 1024;
      return { window, output, inputBudget,
        fitsOneBatch: inputBudget >= batches[0].estimate.total,
        fitsTwoFilesystemReads: inputBudget >= batches[1].estimate.total,
        fitsSixReads: inputBudget >= batches[2].estimate.total,
        fitsFullRecordedRun: inputBudget >= batches[4].estimate.total };
    }) };
};
const staticPrompt = estimateWith(prompt, []);
console.log('MEASUREMENT_JSON ' + JSON.stringify({
  fixture: { messages: messages.length, totalBytes: bytes(messages) },
  staticPrompt: { chars: prompt.length, tokens: staticPrompt.total, analysisPolicyChars: MODEL_ANALYSIS_POLICY.length },
  tools: { count: tools.length, bytes: bytes(tools), tokens: staticPrompt.tools },
  recorded: summarize(messages),
  live: summarize(liveMessages),
}));
