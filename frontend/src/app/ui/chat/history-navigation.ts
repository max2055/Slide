import { extractTextCached } from "./message-extract.ts";

export type HistoryTurn = { key: string; index: number; question: string; answer: string };
const cache = new WeakMap<unknown[], { length: number; turns: HistoryTurn[] }>();

function preview(message: unknown): string {
  return (extractTextCached(message) ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Only visible user/assistant text enters previews; tool results and reasoning stay out. */
export function buildHistoryTurns(messages: unknown[], keyFor: (message: unknown, index: number) => string): HistoryTurn[] {
  const cached = cache.get(messages);
  if (cached?.length === messages.length) return cached.turns;
  const turns: HistoryTurn[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const role = String((message as Record<string, unknown>).role ?? "").toLowerCase();
    if (role === "user") {
      turns.push({ key: keyFor(message, index), index, question: preview(message) || "附件消息", answer: "" });
    } else if (role === "assistant" && turns.length) {
      const text = preview(message);
      if (text && text !== "NO_REPLY") turns[turns.length - 1].answer = text;
    }
  }
  cache.set(messages, { length: messages.length, turns });
  return turns;
}

/** Render complete turns around a selected node, with roughly 200 messages per segment. */
export function historyWindow(turns: HistoryTurn[], count: number, selectedKey: string | null, limit = 200) {
  const selected = turns.find((turn) => turn.key === selectedKey);
  const desiredStart = selected?.index ?? Math.max(0, count - limit);
  const start = selected?.index ?? turns.findLast((turn) => turn.index <= desiredStart)?.index ?? 0;
  const end = selected ? turns.find((turn) => turn.index >= start + limit)?.index ?? count : count;
  const previous = turns.findLast((turn) => turn.index <= Math.max(0, start - limit));
  const next = turns.find((turn) => turn.index === end);
  return { start, end, previous: start > 0 ? previous : undefined, next };
}
