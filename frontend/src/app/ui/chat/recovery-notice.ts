import { chatSessionHost } from '../chat-session-state.ts';
import type { DisplayStreamEvent } from '../../../../../packages/agent-core/src/display-stream.ts';

type Host = { sessionKey: string; chatRunId: string | null; chatRecoveryNotice?: string | null };
type RecoveryState = { sessionKey: string; serial: number; interruptedRun?: string; seen: Set<string> };
const recoveries = new WeakMap<object, RecoveryState>();
function recoveryFor(host: Host): RecoveryState {
  host = chatSessionHost(host);
  let state = recoveries.get(host);
  if (!state) {
    state = { sessionKey: host.sessionKey, serial: 0, seen: new Set() };
    recoveries.set(host, state);
  }
  if (state.sessionKey !== host.sessionKey) {
    state.sessionKey = host.sessionKey;
    state.interruptedRun = undefined;
    host.chatRecoveryNotice = null;
  }
  return state;
}

/** Capture the execution that actually experienced a transport interruption. */
export function markChatRecoveryInterruption(host: Host): void {
  const state = recoveryFor(host);
  if (!host.chatRunId) return;
  state.serial++;
  state.interruptedRun = host.chatRunId;
}

/** Seen event identities survive dismissal, refresh and repeated watch snapshots. */
export function clearChatRecoveryNotice(host: Host): void {
  const state = recoveryFor(host);
  state.interruptedRun = undefined;
  chatSessionHost(host).chatRecoveryNotice = null;
}
export function dismissChatRecoveryNotice(host: Host): void {
  chatSessionHost(host).chatRecoveryNotice = null;
}

export function applyChatRecoveryNotice(host: Host, event: DisplayStreamEvent): void {
  const state = recoveryFor(host);
  const cold = event.recovery?.cold;
  const interruptedRun = state.interruptedRun;
  // cold means no live baseline. Only a locally interrupted execution proves
  // that an unsaved tail might have existed, including with older servers.
  if (cold && (!interruptedRun || host.chatRunId !== interruptedRun)) return;
  if (!cold && !event.recovery?.truncated) {
    state.interruptedRun = undefined;
    return; // Full replay/snapshot has recovered; no lasting success notice.
  }
  const runId = cold ? interruptedRun! : event.stream.runId;
  const identity = JSON.stringify([host.sessionKey, runId, cold ? 'cold' : event.stream.streamEpoch,
    state.serial, cold ? 'lost-tail' : 'bounded-preview']);
  if (state.seen.has(identity)) return;
  state.seen.add(identity);
  while (state.seen.size > 64) state.seen.delete(state.seen.values().next().value!);
  chatSessionHost(host).chatRecoveryNotice = cold
    ? '连接已恢复；仅恢复已保存边界，未保存的流尾部可能丢失。'
    : '恢复快照仅保留本轮尾部和结果预览；完整已保存内容请查看聊天历史。';
}
