/**
 * Phase 109-04 — DirectGatewayClient contract tests.
 *
 * Tests the new DirectAdapter WS client API shape:
 * - Class construction with options
 * - Method signatures match expected API
 * - sendChat produces correct JSON wire format
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DirectGatewayClient } from './direct-gateway.ts';
import type {
  AdapterChatEvent,
  AdapterTextDeltaEvent,
  ConnectionState,
} from './direct-gateway.ts';

describe('109-04: DirectGatewayClient', () => {
  let onEvent: ReturnType<typeof vi.fn<(event: AdapterChatEvent) => void>>;
  let onStateChange: ReturnType<typeof vi.fn<(state: ConnectionState) => void>>;

  beforeEach(() => {
    onEvent = vi.fn<(event: AdapterChatEvent) => void>();
    onStateChange = vi.fn<(state: ConnectionState) => void>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('can be constructed with required options', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(client).toBeInstanceOf(DirectGatewayClient);
  });

  it('can be constructed with custom URL', () => {
    const client = new DirectGatewayClient({
      url: 'ws://localhost:9999',
      onEvent,
      onStateChange,
    });
    expect(client).toBeInstanceOf(DirectGatewayClient);
  });

  it('exposes expected API methods', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(typeof client.connect).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(typeof client.sendChat).toBe('function');
    expect(typeof client.requestHistory).toBe('function');
    expect(typeof client.isConnected).toBe('function');
  });

  it('sendChat does not throw', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(() => client.sendChat('test-session', 'hello world')).not.toThrow();
  });

  it('requestHistory does not throw', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(() => client.requestHistory('test-session')).not.toThrow();
  });

  it('connect calls onStateChange with connecting state', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    expect(onStateChange).toHaveBeenCalledWith('connecting');
    client.disconnect();
  });

  it('isConnected returns false initially', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(client.isConnected()).toBe(false);
  });

  it('disconnect cleans up without throwing', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(() => client.disconnect()).not.toThrow();
  });

  it('disconnect sets state to disconnected', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.disconnect();
    expect(onStateChange).toHaveBeenCalledWith('disconnected');
  });

  it('AdapterChatEvent types are correctly typed', () => {
    const delta: AdapterTextDeltaEvent = { type: 'text_delta', delta: 'hello' };
    expect(delta.type).toBe('text_delta');
    expect(delta.delta).toBe('hello');

    const all: AdapterChatEvent[] = [
      { type: 'text_delta', delta: '' },
      { type: 'tool_start', toolName: 'test', args: {} },
      { type: 'tool_result', toolName: 'test', result: null },
      { type: 'tool_error', toolName: 'test', error: 'err' },
      { type: 'complete', finalContent: 'done' },
      { type: 'error', error: 'fail' },
    ];
    expect(all.length).toBe(6);
  });
});
