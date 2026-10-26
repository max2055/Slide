import { strict as assert } from 'node:assert';
// LOCAL ONLY: synthetic future calls derived from immutable B18 receipts.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
export const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const bytes = gunzipSync(readFileSync(new URL('./fixtures/ops-frozen-allocation-b18.json.gz', import.meta.url)));
if (sha(bytes) !== '24bd8e27ee2931a7dc377f31c6879c98aab7eafdaaa2a59f15c0673094270a6a') throw Error('SOURCE_CHANGED');
export const f = JSON.parse(String(bytes));
export const limits = Object.freeze({ contextWindowTokens: 294912, maxTokens: 8192, summaryMaxTokens: 10240,
  maxProviderAttempts: 8, maxToolCalls: 36, maxTotalTokens: 1200000, runTimeoutMs: 120000 });
export const planned: any[] = [];
for (const original of f.entries.flatMap((e: any) => e.tool_calls ?? [])) {
  const raw = f.entries.find((e: any) => e.tool_call_id === original.id).content;
  const receipt = JSON.parse(raw), count = Math.max(1, receipt.data?.metrics?.[0]?.series?.length ?? 1);
  for (let index = 0; index < count; index++) {
    const value = JSON.parse(raw), args = JSON.parse(original.function.arguments);
    if (count > 1) {
      value.data.metrics[0].series = [value.data.metrics[0].series[index]];
      value.data.selection = { series_index: index, total_series: count };
      args.series_index = index;
    }
    const id = `SYNTH-FROZEN-${String(planned.length + 1).padStart(3, '0')}`;
    const call = { id, type: 'function', function: { name: original.function.name, arguments: JSON.stringify(args) } };
    planned.push({ call, receipt: value, sourceCallId: original.id, sourceReceiptSha256: sha(raw),
      seriesIndex: count > 1 ? index : null, syntheticReceiptSha256: sha(JSON.stringify(value)) });
  }
}
if (planned.length !== 36) throw Error('PLAN_SIZE');
// Discovery first. Explicitly scripted legal history batches; never rewrite B18.
// The 36 receipts total ~294 KB against a 294,912-token window, so they cannot
// all stay value-bearing in one projected request under the runtime's
// conservative estimator; the natural summary is required, not an anomaly.
// The script therefore reads the answer's metric receipts last: the runtime
// summarizes the oldest receipts (discovery, instance summary, alerts, network)
// into identity-only references and keeps every metric value the answer uses.
export const script = [...planned.slice(1, 3), ...planned.slice(5, 34),
  planned[0], planned[3], planned[4], planned[34], planned[35]];
if (script.length !== 36 || new Set(script).size !== 36) throw Error('PLAN_ORDER');
export const batches = [script.slice(0, 15), script.slice(15, 31), script.slice(31)];
export const reasoning = 'SYNTHETIC local planning. Read the complete selected series and all six buckets; preserve null, zero, quality, dimensions, sources and failures. This script is not autonomous model analysis.';
export const toolReply = (batch: any[]) => ({ role: 'assistant', content: null, reasoning_content: reasoning,
  tool_calls: batch.map(p => p.call) });

/** The verified evidence index carries the runtime's compacted receipt, which
 * encodes repeated bucket fields as a present-mask plus value columns. Decode
 * it back to one ordinary bucket so the answer reads the same values. */
function decodeBucket(series: any, bucket: any) {
  if (!Array.isArray(bucket) || !Array.isArray(series.bucketColumns)) return { ...series.bucketDefaults, ...bucket };
  const [present, values] = bucket;
  return { ...series.bucketDefaults, ...Object.fromEntries(series.bucketColumns.flatMap((key: string, i: number) => present[i] ? [[key, values[i]]] : [])) };
}

/** Exactly the receipts readable in THIS request, in canonical plan order. A
 * receipt listed by the verified evidence index with valuesProvided=false stays
 * an identity-only reference and is never inferred as an observation. */
export function deliveredReceipts(body: any) {
  const calls: Map<string, any> = new Map(body.messages.flatMap((m: any) => m.tool_calls ?? []).map((c: any) => [c.id, c]));
  const provided = new Map<string, any>();
  for (const m of body.messages.filter((m: any) => m.role === 'tool')) {
    const call: any = calls.get(m.tool_call_id);
    if (!call || String(call.function?.name ?? '').startsWith('runtime_')) continue;
    provided.set(call.id, JSON.parse(m.content));
  }
  for (const m of body.messages.filter((m: any) => m.role === 'tool'
    && calls.get(m.tool_call_id)?.function?.name === 'runtime_current_execution_evidence')) {
    const index = JSON.parse(String(m.content).replace(/^\[[^\n]*\]\n/, ''));
    for (const r of index.receipts ?? []) {
      if (!r.valuesProvided || r.observation === undefined || provided.has(r.toolCallId)) continue;
      provided.set(r.toolCallId, typeof r.observation === 'string' ? JSON.parse(r.observation) : r.observation);
    }
  }
  return planned.filter(p => provided.has(p.call.id)).map(p => [p.call.id, provided.get(p.call.id)] as const);
}

/** Oldest metric receipts in the script. After the natural summary they are
 * carried as identity-only references, so no answer may state their values. */
export const referenceOnlyMetricCalls = ['mysql.connections.limit', 'mysql.threads.connected']
  .map(metric => planned.find(p => JSON.parse(p.call.function.arguments).metric_ids?.[0] === metric)!.call.id);

export function syntheticAnalysisFromWire(body: any) {
  const calls: Map<string, any> = new Map(body.messages.flatMap((m: any) => m.tool_calls ?? []).map((c: any) => [c.id, c]));
  const numeric: Record<string, any[]> = {};
  for (const [callId, receipt] of deliveredReceipts(body)) {
    const call: any = calls.get(callId), r = receipt, metric = r.data?.metrics?.[0];
    if (!metric) continue;
    // A summarized call keeps its verified observation but not its pinned
    // arguments; the definition carried by the receipt names the metric.
    const key = call ? JSON.parse(call.function.arguments).metric_ids[0] : metric.definition?.id;
    assert.ok(key);
    assert.ok(!r.data.evidenceOmitted);
    const series = metric.series.map((s: any) => ({ ...s, buckets: s.buckets.map((b: any) => decodeBucket(s, b)) }));
    (numeric[key] ??= []).push({ callId, definition: metric.definition, state: metric.state, series });
  }
  const last = (id: string) => numeric[id][0].series[0].buckets.filter((b: any) => b.value !== null && b.value !== undefined).at(-1);
  const value = (id: string) => String(last(id).value.value), ref = (id: string) => numeric[id][0].callId;
  const key = (d: any) => JSON.stringify(Object.fromEntries(Object.entries(d).sort()));
  const sizes = new Map(numeric['host.filesystem.size_bytes'].map(p => [key(p.series[0].dimensions), p]));
  const filesystems = numeric['host.filesystem.used_bytes'].map(p => {
    const s: any = sizes.get(key(p.series[0].dimensions)); assert.ok(s);
    const rows = p.series[0].buckets.map((b: any, i: number) => {
      const size = s.series[0].buckets[i]; assert.deepEqual(b.window, size.window);
      const denominator = size.value == null ? null : BigInt(size.value.value);
      const numerator = b.value == null ? null : BigInt(b.value.value);
      const lower = numerator === null || denominator === null || denominator <= 0n ? null : Number(numerator * 10000n / denominator) / 100;
      return { window: b.window, used: b.value, capacity: size.value, quality: [b.quality, size.quality],
        utilizationPercentLowerBoundAtTwoDecimals: lower,
        utilizationDisplay: lower === null ? 'unknown' : numerator === 0n ? '0%' : lower === 0 ? '<0.01%' : `≈${lower}%` };
    });
    return { dimensions: p.series[0].dimensions, toolCallIds: [p.callId, s.callId], rows };
  });
  assert.equal(filesystems.length, 11);
  const fsText = filesystems.map(p => `${p.dimensions.mount} ${p.rows.filter((r: any) => r.utilizationPercentLowerBoundAtTwoDecimals !== null).at(-1)?.utilizationDisplay ?? 'unknown'}`).join('；');
  const statement = (text: string, ids: string[]) => ({ statement: text, supportingToolCallIds: ids.map(ref), contradictingToolCallIds: [] });
  // Connections/limit are the oldest metric receipts in the plan: the runtime's
  // summary projection keeps them as identity-only references, so the scripted
  // answer must not state their values. Every number below comes from a receipt
  // this request actually provided.
  const referenceOnly = referenceOnlyMetricCalls;
  const answer = { analysisVersion: 1,
    summary: `合成脚本，非自主模型。07:06:50–07:12:50 UTC各最近有效桶：processlist ${value('custom.mysql.processlist_connections')}；慢查询snapshot ${value('custom.mysql.slow_queries_snapshot')}；容量estimated ${value('mysql.tables.estimated_allocated_bytes')} B；CPU ${value('linux.cpu.user_system_percent')}%、内存${value('linux.memory.used_percent')}%。FS同维度/同桶：${fsText}。网络失败非0。`,
    claims: [
      statement(`processlist ${value('custom.mysql.processlist_connections')}、慢查询snapshot ${value('custom.mysql.slow_queries_snapshot')}、容量estimated ${value('mysql.tables.estimated_allocated_bytes')} B分别来自snapshot与estimated，不计算counter增量。`, ['custom.mysql.processlist_connections','custom.mysql.slow_queries_snapshot','mysql.tables.estimated_allocated_bytes']),
      statement(`CPU ${value('linux.cpu.user_system_percent')}%、内存${value('linux.memory.used_percent')}%；保留桶时间/质量，单点不能断言持续健康。`, ['linux.cpu.user_system_percent','linux.memory.used_percent']),
      { statement: `同维度FS ${filesystems[0].dimensions.mount}最近有效桶占用${filesystems[0].rows.filter((r:any)=>r.utilizationDisplay!=='unknown').at(-1)?.utilizationDisplay ?? 'unknown'}，其余维度另审计。`, supportingToolCallIds: filesystems[0].toolCallIds, contradictingToolCallIds: [] },
    ], hypotheses: [], unresolvedQuestions: ['可信counter启动/重置和接口生命周期producer未齐备；null桶不推算，真实覆盖未验。',`连接/上限回执 ${referenceOnly.join('、')} 在本请求仅作为已返回调用的身份引用，未携带观测值；不据此断言连接使用率。`,'回答、选择、用量为合成；真实Provider时延、自主分析、活动摘要续跑未验。'],
    recommendations: [{ action:'按完整mount/device/fs_type及同桶核对FS，保留null，补齐网络可信来源后重新判断。',priority:'medium'}] };
  assert.ok(answer.summary.length <= 400);
  return {numeric, filesystems, answer};
}
