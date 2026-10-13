import { createMessageProjection, reduceMessageProjection, projectionMessageParts } from '../../../../../packages/agent-core/src/message-projection.ts';
import type { InvestigationStreamEvent } from '../../../api/generated/public-api.ts';
import type { DirectGatewayClient } from '../direct-gateway.ts';
import { investigationApi, InvestigationApiError, investigationErrorText, factMessages, type InvestigationMessage,
  type InvestigationRecord, type InvestigationList, type InvestigationSnapshot, type FactPage,
  type InvestigationAccepted, type InvestigationCreateRequest, type InvestigationEvidence, type InvestigationResultPage } from './investigation-api.ts';

/** Server-owned facts only. Missing ordinals require a new authorized snapshot. */
export function applyInvestigationEvent(snapshot: InvestigationSnapshot, event: InvestigationStreamEvent): InvestigationSnapshot {
  if (event.investigationId !== snapshot.investigationId || event.sequence <= snapshot.watermark) return snapshot;
  if (event.sequence !== snapshot.watermark + 1) throw new Error('REPLAY_REQUIRED');
  const next = structuredClone(snapshot);
  switch (event.type) {
    case 'parts.operation': {
      if (next.projection.runs[event.runId]?.terminal) break;
      const operations = event.payload.operations.map(op => {
        if (op.type !== 'parts.persisted') return op;
        for (const doc of op.documents) {
          const index = next.documents.findIndex(d => d.id === doc.id);
          // Preserve exact fact ID; live process projection is never an extra message.
          const fact = { ...doc, legacy: { id: doc.id, role: doc.role, content: '' } };
          if (index < 0) next.documents.push(fact); else next.documents[index] = fact;
        }
        return { ...op, documents: op.documents.filter(d => d.role !== 'user' && d.role !== 'system') };
      });
      next.projection.runs[event.runId] = reduceMessageProjection(next.projection.runs[event.runId] ?? createMessageProjection(event.runId), { ...event.payload, operations });
      break;
    }
    case 'run.started':
      if (!next.runs.some(r => r.runId === event.runId)) next.runs.push({ requestId: event.requestId ?? '', runId: event.runId, state: 'running', resolution: 'known' });
      break;
    case 'run.terminal': {
      const run = next.runs.find(r => r.runId === event.runId);
      if (run && run.state === 'running') Object.assign(run, event.payload);
      const projection = next.projection.runs[event.runId] ?? createMessageProjection(event.runId);
      if (!projection.terminal) { projection.terminal = event.payload.state; projection.runState = event.payload.state; }
      next.projection.runs[event.runId] = projection;
      break;
    }
    case 'investigation.changed': next.metadata = event.payload; break;
    case 'evidence.added': if (!next.evidenceIds.includes(event.payload.evidenceId)) next.evidenceIds.push(event.payload.evidenceId); break;
  }
  next.watermark = event.sequence;
  return next;
}

export function investigationMessages(snapshot: InvestigationSnapshot | null, history: InvestigationMessage[] = []): InvestigationMessage[] {
  const messages = new Map(history.map(m => [m.id, m]));
  for (const doc of snapshot?.documents ?? []) messages.set(doc.id, { ...doc.legacy, id: doc.id, role: doc.role, runId: doc.runId, messageParts: doc });
  for (const projection of Object.values(snapshot?.projection.runs ?? {})) {
    for (const id of new Set(projection.parts.map(row => row.messageId))) {
      const factId = projection.parts.find(row => row.messageId === id)?.factMessageId ?? id;
      const saved = messages.get(factId);
      const doc = projectionMessageParts(projection, id, { id: factId, role: 'assistant', content: '' });
      messages.set(factId, { ...saved, id: doc.id, role: doc.role, runId: doc.runId, messageParts: doc });
    }
  }
  return [...messages.values()];
}

export class InvestigationsController {
  list: InvestigationList = { items: [], authorizedCounts: { total: 0 }, nextCursor: null };
  detail: InvestigationRecord | null = null;
  snapshot: InvestigationSnapshot | null = null;
  history: InvestigationMessage[] = [];
  historyBefore: string | null = null;
  results: InvestigationResultPage = { items: [], nextBefore: null };
  evidence: InvestigationEvidence[] = [];
  loading = false; detailLoading = false; busy = false; cancelRequested = false;
  error = ''; forbidden = false; operationForbidden = false; online = false;
  private generation = 0; private listGeneration = 0; private disposed = false;
  private contentEpoch = 0; private refreshOrdinal = 0;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private unsubscribe?: () => void;
  private pending?: { signature: string; key: string; path: string; body: unknown };
  get acceptanceUnknown() { return !!this.pending && !this.busy; }
  private filters = '';
  private id = '';
  constructor(private update: () => void, private client: DirectGatewayClient | null) {}

  private fail(error: unknown) {
    this.error = investigationErrorText(error);
    if (error instanceof InvestigationApiError && [401, 403, 404].includes(error.status)) this.clearSensitive();
    this.update();
  }
  clearSensitive() {
    this.generation++; this.contentEpoch++; this.listGeneration++; this.detail = null; this.snapshot = null; this.history = [];
    this.results = { items: [], nextBefore: null }; this.evidence = [];
    this.list = { items: [], authorizedCounts: { total: 0 }, nextCursor: null };
    this.forbidden = true; this.loading = false; this.detailLoading = false; this.online = false; this.busy = false; this.cancelRequested = false; this.pending = undefined;
    this.historyBefore = null; this.unsubscribe?.(); this.unsubscribe = undefined;
  }
  dispose() { this.disposed = true; this.clearSensitive(); }
  async loadList(filters = this.filters, more = false) {
    const generation = ++this.listGeneration;
    this.filters = filters; this.loading = true; this.error = ''; this.update();
    try {
      const query = new URLSearchParams(filters);
      query.set('limit', '20');
      if (more && this.list.nextCursor) query.set('cursor', this.list.nextCursor);
      const list = await investigationApi<InvestigationList>(`?${query}`);
      if (generation !== this.listGeneration || this.disposed) return;
      this.list = more ? { ...list, items: [...this.list.items, ...list.items] } : list;
    } catch (error) { if (generation === this.listGeneration) this.fail(error); }
    finally { if (generation === this.listGeneration) { this.loading = false; this.update(); } }
  }
  async select(id: string) {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    const generation = ++this.generation; this.id = id;
    this.detail = null; this.snapshot = null; this.history = []; this.evidence = []; this.historyBefore = null;
    this.results = { items: [], nextBefore: null }; this.cancelRequested = false;
    this.detailLoading = true; this.forbidden = false; this.operationForbidden = false; this.error = ''; this.update();
    try {
      const [detail, facts, results] = await Promise.all([
        investigationApi<InvestigationRecord>(`/${id}`), investigationApi<FactPage>(`/${id}/facts`),
        investigationApi<InvestigationResultPage>(`/${id}/results`),
      ]);
      if (generation !== this.generation || this.disposed) return;
      this.detail = detail; this.history = factMessages(facts); this.historyBefore = facts.nextBefore; this.results = results;
      this.unsubscribe = this.client?.observeInvestigation(id, event => this.receive(event, generation));
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { if (generation === this.generation) { this.detailLoading = false; this.update(); } }
  }
  private receive(event: Record<string, unknown>, generation: number) {
    if (generation !== this.generation || this.disposed) return;
    if (event.type === 'investigation.disconnected') {
      this.contentEpoch++; this.listGeneration++;
      this.online = false;
      // A transport outage cannot prove continued authority. Drop content immediately.
      this.snapshot = null; this.history = []; this.evidence = []; this.results = { items: [], nextBefore: null };
      this.detail = null; this.list = { items: [], authorizedCounts: { total: 0 }, nextCursor: null };
      if (event.revoked) { this.clearSensitive(); this.error = '访问权限已撤销，请重新确认权限。'; }
      else this.error = '连接中断，内容已隐藏；重新连接后从服务器恢复。';
    } else if (event.type === 'investigation.error') {
      this.fail(new InvestigationApiError(event.code === 'INVESTIGATION_NOT_FOUND' ? 404 : 503, String(event.code)));
    } else if (event.type === 'investigation.replay_required') {
      this.client?.refreshInvestigation(this.id);
    } else if (event.type === 'investigation.snapshot') {
      if (event.investigationId !== this.id) return;
      this.contentEpoch++; this.snapshot = event as unknown as InvestigationSnapshot; this.online = true; this.error = '';
      void this.refreshFacts(generation);
    } else if (event.type === 'investigation.event' && this.snapshot) {
      const fact = event.event as InvestigationStreamEvent;
      try {
        const previous = this.snapshot; this.snapshot = applyInvestigationEvent(previous, fact);
        if (this.snapshot !== previous && ['run.terminal', 'result.persisted', 'investigation.changed', 'request.accepted', 'evidence.added'].includes(fact.type)) void this.refreshFacts(generation);
      } catch { this.client?.refreshInvestigation(this.id); }
    }
    this.update();
  }
  private refreshFacts(generation = this.generation): Promise<void> {
    if (generation !== this.generation || this.disposed) return Promise.resolve();
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      do { this.refreshAgain = false; await this.readFacts(this.generation); }
      while (this.refreshAgain && !this.disposed && !this.forbidden);
    })().finally(() => this.refreshing = undefined);
    return this.refreshing;
  }
  private async readFacts(generation: number) {
    const id = this.id;
    const epoch = this.contentEpoch, ordinal = ++this.refreshOrdinal;
    try {
      const [detail, results, evidence] = await Promise.all([
        investigationApi<InvestigationRecord>(`/${id}`), investigationApi<InvestigationResultPage>(`/${id}/results`),
        Promise.all((this.snapshot?.evidenceIds ?? []).map(eid => investigationApi<InvestigationEvidence>(`/${id}/evidence/${eid}`))),
      ]);
      if (generation !== this.generation || epoch !== this.contentEpoch || ordinal !== this.refreshOrdinal || this.disposed) return;
      this.detail = detail; this.results = results; this.evidence = evidence;
      if (!detail.activeRequestId) this.cancelRequested = false;
      this.update();
    } catch (error) { if (generation === this.generation && epoch === this.contentEpoch) this.fail(error); }
  }
  async loadHistory() {
    if (!this.historyBefore || !this.detail) return;
    const generation = this.generation;
    const epoch = this.contentEpoch;
    try {
      const facts = await investigationApi<FactPage>(`/${this.id}/facts?before=${encodeURIComponent(this.historyBefore)}`);
      if (generation !== this.generation || epoch !== this.contentEpoch) return;
      this.history = [...factMessages(facts), ...this.history]; this.historyBefore = facts.nextBefore; this.update();
    } catch (error) { if (generation === this.generation && epoch === this.contentEpoch) this.fail(error); }
  }
  async loadResults() {
    if (!this.results.nextBefore) return;
    const generation = this.generation;
    const epoch = this.contentEpoch;
    try {
      const page = await investigationApi<InvestigationResultPage>(`/${this.id}/results?before=${this.results.nextBefore}`);
      if (generation !== this.generation || epoch !== this.contentEpoch) return;
      this.results = { ...page, items: [...this.results.items, ...page.items] }; this.update();
    } catch (error) { if (generation === this.generation && epoch === this.contentEpoch) this.fail(error); }
  }
  async retryPending() {
    const pending = this.pending;
    if (!pending) return;
    const result = await this.submit<InvestigationAccepted>(pending.path, pending.body);
    if (result?.id) { await this.select(result.id); await this.loadList(); }
    else if (result) await this.refreshFacts();
    return result;
  }
  private async submit<T>(path: string, body: unknown): Promise<T | undefined> {
    if (this.busy || this.disposed || this.forbidden) return;
    const signature = JSON.stringify([path, body]);
    // Until an ambiguous response is resolved, another body must not create a new execution.
    if (this.pending && this.pending.signature !== signature) { this.error = '上一请求接受结果尚未确认，请核对原请求后再修改目标。'; this.update(); return; }
    this.pending ??= { signature, key: crypto.randomUUID(), path, body: structuredClone(body) };
    const generation = this.generation;
    const pending = this.pending;
    this.busy = true; this.error = ''; this.update();
    try {
      const result = await investigationApi<T>(path, { method: 'POST', headers: { 'Idempotency-Key': this.pending.key }, body: JSON.stringify(body) });
      if (this.pending === pending) this.pending = undefined;
      if (generation !== this.generation || this.disposed) return;
      return result;
    } catch (error) {
      if (error instanceof InvestigationApiError && error.status < 500) if (this.pending === pending) this.pending = undefined;
      if (generation === this.generation) {
        if (error instanceof InvestigationApiError && error.code === 'INVESTIGATION_OPERATION_FORBIDDEN') { this.operationForbidden = true; this.error = investigationErrorText(error); this.update(); }
        else this.fail(error);
      }
    } finally { if (generation === this.generation) { this.busy = false; this.update(); } }
  }
  async create(body: InvestigationCreateRequest, observe = true) {
    const result = await this.submit<InvestigationAccepted>('', body);
    if (result && observe) { await this.select(result.id); await this.loadList(); }
    return result;
  }
  async continue(message: string) {
    if (!this.detail || this.detail.activeRequestId || !message.trim()) return;
    const result = await this.submit<InvestigationAccepted>(`/${this.id}/runs`, { message, expectedVersion: this.detail.version });
    if (result) await this.refreshFacts();
    return result;
  }
  async cancel() {
    if (!this.detail?.activeRequestId || this.cancelRequested) return;
    const result = await this.submit(`/${this.id}/requests/${this.detail.activeRequestId}/cancel`, {});
    if (result) { this.cancelRequested = true; this.update(); }
  }
}
