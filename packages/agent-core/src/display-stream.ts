/** Browser-safe display transport. Its cursor never denotes durable execution. */
import { reduceMessageProjection, restoreMessageProjection, validProjectionFrame, type MessageProjection, type ProjectionFrame } from './message-projection.js';

export const PARTS_STREAM_CAPABILITY = 'parts-stream-v1';
export interface DisplayCursor { streamEpoch: string; runId: string; turnId: string; toSeq: number; }
export interface DisplayWatermark extends DisplayCursor { version: 1; subscriptionId: string; fromSeq: number; }
export interface DisplayRecovery {
  truncated: boolean;
  cold?: boolean;
  omittedParts: number;
  detailRef: { sessionKey: string; runId: string; kind: 'authorized-history' };
}
export interface DisplayStreamEvent {
  type: 'stream.snapshot' | 'stream.delta';
  sessionKey: string;
  stream: DisplayWatermark;
  snapshot?: MessageProjection;
  projection?: ProjectionFrame;
  recovery?: DisplayRecovery;
}
export interface DisplayStreamState {
  subscriptionId: string;
  cursor?: DisplayCursor;
  projection?: MessageProjection;
  recovering: boolean;
  recovery?: DisplayRecovery;
}
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const seq = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function readDisplayStreamEvent(value: unknown): DisplayStreamEvent | undefined {
  const e = value as DisplayStreamEvent;
  const w = e?.stream;
  if (!e || !['stream.snapshot', 'stream.delta'].includes(e.type) || !id(e.sessionKey) || !w || w.version !== 1
    || ![w.streamEpoch, w.runId, w.turnId, w.subscriptionId].every(id)
    || !seq(w.fromSeq) || !seq(w.toSeq) || w.fromSeq > w.toSeq) return;
  if (e.type === 'stream.delta' && (!validProjectionFrame(e.projection, w.runId) || w.fromSeq === 0)) return;
  if (e.type === 'stream.snapshot') {
    try { if (restoreMessageProjection(e.snapshot).runId !== w.runId || w.fromSeq !== w.toSeq) return; } catch { return; }
  }
  return e;
}

/** Gateway retains only bounded cursor metadata; the UI owns the one projection. */
export function inspectDisplayWatermark(state: Omit<DisplayStreamState, 'projection'>, e: DisplayStreamEvent): 'applied' | 'ignored' | 'recover' {
  const w = e.stream, prior = state.cursor;
  if (w.subscriptionId !== state.subscriptionId) return 'ignored';
  const same = prior?.streamEpoch === w.streamEpoch && prior.runId === w.runId && prior.turnId === w.turnId;
  if (e.type === 'stream.snapshot') {
    if (prior && !same && !state.recovering) return 'recover';
    return same && w.toSeq < prior.toSeq ? 'ignored' : 'applied';
  }
  if (same && w.toSeq <= prior.toSeq) return 'ignored';
  return !same || state.recovering || w.fromSeq !== prior!.toSeq + 1 ? 'recover' : 'applied';
}

/** Snapshot+watermark replace in one call. No merge of old tools/terminal/anchor. */
export function reduceDisplayStream(state: DisplayStreamState, value: unknown): { state: DisplayStreamState; result: 'applied' | 'ignored' | 'recover' } {
  const e = readDisplayStreamEvent(value);
  if (!e || e.stream.subscriptionId !== state.subscriptionId) return { state, result: 'ignored' };
  const w = e.stream;
  const cursor: DisplayCursor = { streamEpoch: w.streamEpoch, runId: w.runId, turnId: w.turnId, toSeq: w.toSeq };
  const prior = state.cursor;
  const same = prior?.streamEpoch === w.streamEpoch && prior.runId === w.runId && prior.turnId === w.turnId;
  if (e.type === 'stream.snapshot') {
    if (prior && !same && !state.recovering) return { state: { ...state, recovering: true }, result: 'recover' };
    if (same && w.toSeq < prior.toSeq) return { state, result: 'ignored' };
    return { state: { subscriptionId: state.subscriptionId, cursor, projection: restoreMessageProjection(e.snapshot),
      recovering: false, recovery: e.recovery }, result: 'applied' };
  }
  if (same && w.toSeq <= prior.toSeq) return { state, result: 'ignored' };
  if (!same || state.recovering || !state.projection || w.fromSeq !== prior!.toSeq + 1) {
    return { state: { ...state, recovering: true }, result: 'recover' };
  }
  const projection = reduceMessageProjection(state.projection, e.projection);
  if (projection === state.projection) {
    if (state.projection.terminal) return { state, result: 'ignored' };
    return { state: { ...state, recovering: true }, result: 'recover' };
  }
  return { state: { ...state, cursor, projection, recovering: false }, result: 'applied' };
}
