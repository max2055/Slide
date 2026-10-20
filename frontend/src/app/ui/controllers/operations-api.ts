import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { authFetch } from '../../../api/index.ts';

export interface ResourceRef { type: 'instance' | 'server' | 'network_device'; id: number }
export interface VersionRef { id: string; version: number; hash: string; validUntil: string }
export interface CaseCandidate {
  investigationId: string; resultVersion: number;
  content: { title: string; symptoms: string; faultType: string; confirmedCause: string; actions: string; actualEffect: string; counterexamples: string };
  applicability: { conditions: string; productVersion: string; resourceVersion: string };
  validUntil: string; humanConfirmed: true;
}
export interface CaseRecord {
  id: string; revision: number; version: number; contentHash: string;
  state: 'draft' | 'pending_review' | 'published' | 'expired' | 'withdrawn';
  author: { kind: string; id: number }; resources: ResourceRef[]; validUntil: string;
  content?: CaseCandidate['content']; applicability?: CaseCandidate['applicability'];
  source?: { investigationId: string; resultVersion: number; resultId: string; evidence: Array<{ id: string; hash: string; validUntil: string; observedFrom?: string|null; observedTo?: string|null; collectedAt?: string; quality?: {partial:boolean|null;truncated:boolean|null;hasMore:boolean|null}; page?: {limit:number|null;offset:number|null;nextOffset:number|null} }> };
  tombstone: boolean; reason?: string; referenceOnly: true;
}
export interface CasePage { items: CaseRecord[]; authorizedCounts: { total: number }; nextCursor: string | null }
export interface PlanRecord {
  id: string; version: number; contentHash: string;
  approvalId?: string|null;
  executions?: Array<{id:string;planVersion:number;state:string}>;
  state: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'expired' | 'superseded';
  content: {
    investigationId: string; resultVersion: number; target: ResourceRef;
    tool: { name: string; version: string; hash: string }; parameters: { unit: string };
    impact: string; risk: string; validFrom: string; validUntil: string;
    author: { kind: string; id: number }; requester: { kind: string; id: number };
    evidence: VersionRef[]; relations: VersionRef[]; baselines: VersionRef[];
    preconditions: Array<{ kind: string; expected: string }>;
    verifier: { beforeSeconds: number; readinessSeconds: number; observationSeconds: number; intervalSeconds: number; maxExtraRestarts: number; requireAllHealthy: boolean };
    rollback: { capability: string; description: string };
  };
}
export interface RelationGraph {
  resource: ResourceRef; partial: boolean;
  edges: Array<{ relationId: string; version: number; contentHash: string; source: ResourceRef; target: ResourceRef;
    relationType: string; provenance: string; verification: string; state: string; validFrom: string; validUntil: string | null }>;
}
export interface BaselineRecord {
  id: string; version: number; contentHash: string;
  result: {
    state: string; status: string; reason: string | null; mode: string; validUntil: string;
    quality: { validDays: number; coverage: number; samples: number; missing: number };
    training: { from: string; until: string }; validation: { from: string; until: string };
    comparison: { value: number | null; observedAt: string | null; baselineAnomaly: boolean | null; reference: { lower: number; upper: number; median: number } | null };
    staticComparison: { status: string; value: number | null; anomaly: boolean | null };
  };
}
export interface AttentionPage {
  id: string; version: number; partial: boolean; from: string; until: string; ruleVersion: string;
  items: Array<{ id: string; eventIds: string[]; investigationIds: string[]; severity: string;
    reasons: unknown[]; missing: string[]; currentValidity: string;
    score: { lower: number; upper: number; coverage: number; components: Record<string, number | null> } }>;
  authorizedCounts: { total: number }; nextCursor: string | null;
}

export class OperationsApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function operationsApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  return authorizedJson<T>(`/api/operations${path}`, options);
}
export async function authorizedJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authFetch(path, { ...options, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new OperationsApiError(response.status, value.reasonCode ?? value.error ?? 'OPERATIONS_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
export function operationsErrorText(error: unknown): string {
  if (!(error instanceof OperationsApiError)) return '连接中断，未能确认请求结果。';
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前权限不足，内容已清除。';
  if (error.status === 404) return '记录不可访问或当前服务尚未提供此入口。';
  if (error.status === 409) return '版本已变化，请只读刷新后核对当前版本。';
  if (error.status === 410) return '记录或授权已过期，请重新核对。';
  if (error.code === 'OPERATIONS_FEATURE_DISABLED') return '此能力当前未启用。';
  if (error.status === 422) return '请求未被接受，请核对来源、版本、有效期与适用条件。';
  return '服务暂不可用，未能确认请求结果。';
}

/** A view owns its lifetime. No cached result can cross an authority/object epoch.
 * Writes are never retried; an uncertain acknowledgement locks further writes
 * for this view, while read-only reconciliation remains available. */
export class OperationsResource<T> implements ReactiveController {
  data: T | null = null;
  loading = false;
  writing = false;
  error = '';
  accessInvalidated = false;
  mutationUnknown = false;
  private epoch = 0;
  private connected = false;
  constructor(private readonly host: ReactiveControllerHost, private readonly clearDrafts = () => {}, private readonly request = operationsApi) { host.addController(this); }
  private authorityChanged = () => {
    this.reset(); this.accessInvalidated = true;
    this.error = '权限或登录状态已变更，内容已清除。请重新打开页面核验。'; this.host.requestUpdate();
  };
  hostConnected() {
    this.connected = true;
    window.addEventListener('slide-permissions-loaded', this.authorityChanged);
    window.addEventListener('slide-session-expired', this.authorityChanged);
  }
  hostDisconnected() {
    this.connected = false; this.reset();
    window.removeEventListener('slide-permissions-loaded', this.authorityChanged);
    window.removeEventListener('slide-session-expired', this.authorityChanged);
  }
  reset() {
    ++this.epoch; this.data = null; this.loading = false; this.writing = false; this.error = ''; this.clearDrafts();
  }
  invalidate(message = '来源已失效，正文已清除。') { this.reset(); this.error=message; this.host.requestUpdate(); }
  get locked() { return this.loading || this.writing || this.accessInvalidated || this.mutationUnknown; }
  async load(path: string): Promise<T | null> {
    if (!this.connected || this.accessInvalidated || this.writing) return null;
    const epoch = ++this.epoch;
    this.data = null; this.error = ''; this.loading = true; this.host.requestUpdate();
    try {
      const data = await this.request<T>(path);
      if (!this.connected || epoch !== this.epoch) return null;
      this.data = data; return data;
    } catch (error) {
      if (this.connected && epoch === this.epoch) this.fail(error);
      return null;
    } finally { if (epoch === this.epoch) { this.loading = false; this.host.requestUpdate(); } }
  }
  async write<R>(path: string, body: unknown, method = 'POST'): Promise<R | null> {
    if (!this.connected || this.locked) return null;
    const epoch = ++this.epoch;
    this.writing = true; this.error = ''; this.host.requestUpdate();
    try {
      const value = await this.request<R>(path, { method, body: JSON.stringify(body) });
      if (!this.connected || epoch !== this.epoch) return null;
      return value;
    } catch (error) {
      if (this.connected && epoch === this.epoch) {
        this.mutationUnknown = !(error instanceof OperationsApiError) || error.status >= 500;
        this.data = null; this.fail(error);
      }
      return null;
    } finally { if (epoch === this.epoch) { this.writing = false; this.host.requestUpdate(); } }
  }
  private fail(error: unknown) {
    if (error instanceof OperationsApiError && [401, 403, 404].includes(error.status)) {
      this.data = null; this.clearDrafts();
      if (error.status !== 404) this.accessInvalidated = true;
    }
    this.error = operationsErrorText(error);
  }
}
export const operationLabels: Record<string, string> = {
  queued:'已排队',prechecking:'执行前核验',dispatching:'已开始发送',succeeded:'执行成功',failed:'失败',outcome_unknown:'执行结果未知',cancelled:'已取消',pending:'待观测',observing:'观察中',passed:'验证通过',inconclusive:'无法确认恢复',
  draft: '草稿', pending_review: '待审核', published: '已发布', expired: '已过期', withdrawn: '已撤回',
  pending_approval: '待独立审批', approved: '已批准', rejected: '已驳回', superseded: '已被新版本替代',
  confirmed: '已确认', suggested: '待确认', conflicted: '存在冲突', unverified: '未经验证',
  runs_on: '运行于', hosts: '承载', replicates_to: '复制到', depends_on: '依赖', connected_to: '连接', serves: '服务于',
  manual: '人工', collector: '采集器', model: '模型建议', low: '低', medium: '中', high: '高', critical: '严重',
};
export const resourceLabel = (ref: ResourceRef) => `${({ instance: '数据库实例', server: '服务器', network_device: '网络设备' })[ref.type]} #${ref.id}`;
export const validRecord = (record: { validUntil: string }) => Number.isFinite(Date.parse(record.validUntil)) && Date.parse(record.validUntil) > Date.now();
export const currentUserId = () => { try { return Number(JSON.parse(localStorage.getItem('user') ?? '{}').id) || null; } catch { return null; } };

/** One authenticated read stream per opened case. Disconnects fail closed;
 * there is no action retry, content cache or transport reconnect loop. */
export function watchCase(id:string, receive:(value:CaseRecord|null)=>void):()=>void {
  const abort=new AbortController();let live=true,expiry:ReturnType<typeof setTimeout>|undefined;
  const invalidate=()=>{if(live)receive(null);};
  void (async()=>{
    try {
      const response=await authFetch(`/api/operations/knowledge/${encodeURIComponent(id)}/watch`,{cache:'no-store',signal:abort.signal});
      if(!response.ok||!response.body)throw new Error('CASE_WATCH_UNAVAILABLE');
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      while(live){
        const {done,value}=await reader.read();if(done)break;
        pending+=decoder.decode(value,{stream:true});if(pending.length>1048576)throw new Error('CASE_WATCH_TOO_LARGE');
        let newline:number;
        while((newline=pending.indexOf('\n'))>=0){
          const frame=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);
          if(!live)break;if(expiry)clearTimeout(expiry);
          if(frame.type==='operations.case.snapshot'&&frame.case?.id===id&&!frame.case.tombstone&&validRecord(frame.case)){
            receive(frame.case);expiry=setTimeout(invalidate,Math.min(2147483647,Date.parse(frame.case.validUntil)-Date.now()));
          }else invalidate();
        }
      }
      invalidate();
    }catch{if(!abort.signal.aborted)invalidate();}
  })();
  return ()=>{live=false;abort.abort();if(expiry)clearTimeout(expiry);};
}
