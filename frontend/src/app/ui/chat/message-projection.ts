import { createMessageProjection, hydrateMessageProjection, reduceMessageProjection,
  type MessageProjection, type ProjectionFrame } from '../../../../../packages/agent-core/src/message-projection.ts';
import type { MessageParts } from '../../../../../packages/agent-core/src/message-parts.ts';
import type { ToolStreamEntry } from '../app-tool-stream.ts';

type Host = Record<string, unknown>;
const projections = new WeakMap<object, { sessionKey: string; runs: Map<string, MessageProjection> }>();
function session(host: Host) {
  const sessionKey = String(host.sessionKey ?? '');
  let stored = projections.get(host);
  if (!stored || stored.sessionKey !== sessionKey) {
    stored = { sessionKey, runs: new Map() }; projections.set(host, stored);
  }
  return stored;
}
export function getChatProjection(host: Host, runId = String(host.chatRunId ?? '')): MessageProjection | undefined {
  return session(host).runs.get(runId);
}
export function acceptChatProjection(host: Host, frame: ProjectionFrame): boolean {
  if (!frame || typeof frame.runId !== 'string' || host.chatRunId && host.chatRunId !== frame.runId) return false;
  const runs = session(host).runs;
  const prior = runs.get(frame.runId) ?? createMessageProjection(frame.runId);
  const next = reduceMessageProjection(prior, frame);
  if (next === prior) return false;
  runs.set(frame.runId, next);
  return true;
}
export function hydrateChatProjections(host: Host, messages: unknown[]): void {
  const grouped = new Map<string, MessageParts[]>();
  for (const message of messages) {
    const doc = (message as { messageParts?: MessageParts })?.messageParts;
    if (!doc || typeof doc.runId !== 'string') continue;
    const docs = grouped.get(doc.runId) ?? []; docs.push(doc); grouped.set(doc.runId, docs);
  }
  const runs = new Map<string, MessageProjection>();
  for (const [runId, docs] of grouped) runs.set(runId, hydrateMessageProjection(runId, docs));
  projections.set(host, { sessionKey: String(host.sessionKey ?? ''), runs });
}

/** Existing render inputs are derived copies, never another lifecycle reducer. */
export function renderChatProjection(host: Host, runId = String(host.chatRunId ?? '')): void {
  const state = getChatProjection(host, runId);
  if (!state) return;
  const rows = state.parts.filter(p => p.part.status !== 'discarded');
  const thinking = rows.filter(p => p.part.type === 'reasoning');
  host.chatThinkingText = thinking.map(p => p.part.type === 'reasoning' ? p.part.text ?? '' : '').join('');
  host.chatThinkingComplete = thinking.every(p => p.part.generation !== 'open');
  const text = rows.filter(p => p.part.type === 'text' || p.part.type === 'runtime_notice');
  const lastTool = rows.reduce((last, p, i) => p.part.type === 'tool_call' ? i : last, -1);
  const tail = text.filter(p => rows.indexOf(p) > lastTool);
  host.chatStream = tail.map(p => 'text' in p.part ? p.part.text : '').join('');
  host.chatStreamPartId = tail.at(-1)?.part.id;
  host.chatStreamSegments = text.filter(p => rows.indexOf(p) < lastTool).map(p => {
    const tool = rows.slice(rows.indexOf(p) + 1).find(p => p.part.type === 'tool_call');
    return { text: 'text' in p.part ? p.part.text : '', ts: tool?.part.tool?.occurredAt ?? 0,
      partId: p.part.id, beforeToolCallId: tool?.part.type === 'tool_call' ? tool.part.call.id : undefined };
  });
  const byId = new Map<string, ToolStreamEntry>();
  const messages: Record<string, unknown>[] = [];
  for (const row of rows) {
    const part = row.part;
    if (part.type === 'tool_input') {
      if (!rows.some(p => p.part.type === 'tool_call' && p.part.call.id === part.toolCallId)) messages.push({ id: part.id, role: 'assistant', runId,
        content: [{ type: 'text', text: `${part.name ?? '工具'}：正在生成参数\n${part.text}` }] });
      continue;
    }
    if (part.type !== 'tool_call') continue;
    const event = part.tool;
    const content: Record<string, unknown>[] = [{ type: 'toolcall', id: part.call.id, name: part.call.function.name, arguments: event?.args ?? part.call.function.arguments }];
    if (event?.preview) content.push({ type: 'toolresult', toolCallId: part.call.id, name: part.call.function.name,
      text: event.preview.text, isError: event.outcome !== 'ok' });
    const message = { id: part.id, role: 'assistant', toolCallId: part.call.id, runId, content,
      timestamp: event?.occurredAt, toolPhase: event?.phase, toolOutcome: event?.outcome, toolProgress: event?.progress,
      toolStartedAt: event?.startedAt, toolSettledAt: event?.settledAt, toolPersistedAt: event?.persistedAt, toolPreview: event?.preview };
    messages.push(message);
    byId.set(part.call.id, { toolCallId: part.call.id, runId, sessionKey: String(host.sessionKey), name: part.call.function.name,
      args: event?.args, output: event?.preview?.text, phase: event?.phase, outcome: event?.outcome, preview: event?.preview,
      progress: event?.progress, startedAt: event?.startedAt, settledAt: event?.settledAt, persistedAt: event?.persistedAt,
      updatedAt: event?.occurredAt ?? 0, message });
  }
  host.toolStreamById = byId; host.toolStreamOrder = [...byId.keys()]; host.chatToolMessages = messages;
}
