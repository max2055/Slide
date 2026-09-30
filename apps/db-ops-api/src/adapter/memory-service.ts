import path from 'node:path';
import {
  MemoryPipeline, ProviderMemoryExtractor, StructuredMemoryStore, memoryHash,
  MemoryRetriever, emptyRetrieval, type LLMProvider, type MemoryScope, type MemoryRetrievalLimits, type MemorySourceReader,
} from '@slide/agent-core';
import type { ActorContext } from '../auth/actor-context.js';
import { canonicalStore } from './canonical-store.js';
import { agentRunService } from './agent-run-service.js';
import { chatDatabaseService } from '../chat-database-service.js';

/** Authenticated business entrance. Extraction has no registry, tools, approvals or write-to-chat capability. */
export class BusinessMemoryService {
  readonly pipeline: MemoryPipeline;
  readonly retriever: MemoryRetriever;
  constructor(workspace: string, private workspaceId: string | undefined, provider: () => Promise<LLMProvider>, pipeline?: MemoryPipeline,
    limits: Partial<MemoryRetrievalLimits> = {}) {
    const enabled = process.env.SLIDE_MEMORY_PIPELINE_ENABLED === 'true';
    if ((enabled || pipeline?.enabled) && !workspaceId?.trim()) throw new Error('MEMORY_WORKSPACE_ID_REQUIRED');
    const reader: MemorySourceReader = async (scope, ids) => {
        if (scope.workspaceId !== this.workspaceId || !/^\d+$/.test(scope.actorId)) throw new Error('MEMORY_SCOPE_INVALID');
        // The record's stored owner scope is trusted server metadata. This check
        // is also used to invalidate a deliberately shared record on owner deletion.
        const live = [];
        for (let offset = 0; offset < ids.length; offset += 1000) live.push(...await canonicalStore.getCommittedMemoryInputs(Number(scope.actorId), scope.sessionId, ids.slice(offset, offset + 1000)));
        return live;
      };
    this.pipeline = pipeline ?? new MemoryPipeline(new StructuredMemoryStore(path.join(workspace, '.slide', 'structured-memory')),
      new ProviderMemoryExtractor(provider), reader, enabled);
    this.retriever = new MemoryRetriever(scope => this.pipeline.store.list(scope), reader, {
      ...(process.env.SLIDE_MEMORY_RETRIEVAL_MAX_COUNT !== undefined ? { maxCount: Number(process.env.SLIDE_MEMORY_RETRIEVAL_MAX_COUNT) } : {}),
      ...(process.env.SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS !== undefined ? { maxTokens: Number(process.env.SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS) } : {}),
      ...limits,
    });
  }
  private scope(actor: ActorContext, sessionId: string): MemoryScope {
    if (!this.workspaceId) throw new Error('MEMORY_WORKSPACE_ID_REQUIRED');
    return { workspaceId: this.workspaceId, actorId: String(actor.userId), sessionId };
  }
  contextScope(actor: ActorContext, sessionId: string): MemoryScope | undefined {
    return this.pipeline.enabled ? this.scope(actor, sessionId) : undefined;
  }
  async retrieve(actor: ActorContext, sessionId: string, text: string, requestId: string) {
    if (!this.pipeline.enabled) return emptyRetrieval(this.retriever.limits, 'disabled');
    // This is an admission check; errors cannot grant access or expose foreign IDs.
    await chatDatabaseService.authorizeSession(actor, sessionId, 'append');
    const result = await this.retriever.retrieve(this.scope(actor, sessionId), { text });
    console.info('[MemoryRetrieval]', JSON.stringify({ requestId: memoryHash(requestId), status: result.status,
      errorCode: result.errorCode, recordIds: result.items.map(r => r.id),
      sourceIds: result.items.flatMap(r => r.sources.map(s => s.id)), count: result.count,
      tokens: result.tokens, method: result.method, maxCount: result.limits.maxCount, maxTokens: result.limits.maxTokens }));
    return result;
  }
  async completed(actor: ActorContext, sessionId: string, runId: string, signal?: AbortSignal): Promise<void> {
    if (!this.pipeline.enabled) return;
    await chatDatabaseService.authorizeSession(actor, sessionId, 'append');
    const run = await agentRunService.getForActor(runId, actor.userId, sessionId);
    if (run?.state !== 'completed') return;
    const inputs = await canonicalStore.getCommittedMemoryInputs(actor.userId, sessionId, [`run_${runId}_user`]);
    await this.pipeline.reconcile(this.scope(actor, sessionId));
    await this.pipeline.run({ scope: this.scope(actor, sessionId), boundary: runId, completed: true,
      messages: inputs.map(s => ({ id: s.id, role: 'user', content: s.content, source: 'fact', timestamp: new Date().toISOString() })) }, signal);
  }
  async request(actor: ActorContext, sessionId: string, operation: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.pipeline.enabled) throw new Error('MEMORY_DISABLED');
    // Shared chat read permission does not confer memory write permission.
    await chatDatabaseService.authorizeSession(actor, sessionId, 'append');
    const scope = this.scope(actor, sessionId);
    const store = this.pipeline.store;
    switch (operation) {
      case 'memory.list': return this.pipeline.list(scope);
      case 'memory.export': return { schemaVersion: 1, records: await this.pipeline.list(scope) };
      case 'memory.delete': await store.delete(scope, String(payload.recordId ?? '')); return { deleted: true };
      case 'memory.share': {
        const actors = payload.actorIds;
        if (!Array.isArray(actors) || actors.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('MEMORY_SHARE_INVALID');
        await this.pipeline.reconcile(scope);
        await store.share(scope, String(payload.recordId ?? ''), actors.map(String)); return { shared: true };
      }
      case 'memory.import': {
        if (payload.export !== undefined) {
          await store.importVersioned(scope, payload.export); await this.pipeline.reconcile(scope);
          return { imported: true, schemaVersion: 1 };
        }
        if (typeof payload.text !== 'string') throw new Error('MEMORY_LEGACY_UNSAFE');
        await store.importLegacy(scope, payload.text); return { imported: true, sourceHash: memoryHash(payload.text) };
      }
      case 'memory.stop': {
        if (typeof payload.runId !== 'string') throw new Error('MEMORY_RUN_INVALID');
        await this.pipeline.cancel(scope, payload.runId); return { stopped: true };
      }
      case 'memory.retry': {
        if (typeof payload.runId !== 'string') throw new Error('MEMORY_RUN_INVALID');
        await this.completed(actor, sessionId, payload.runId); return { retried: true };
      }
      default: throw new Error('MEMORY_OPERATION_INVALID');
    }
  }
  close(): Promise<void> { return this.pipeline.close(); }
}
