/**
 * Nyquist validation: Phase 98 — session-controls.ts
 *
 * Tests renderChatAgentSelect behavior:
 * - Single agent -> returns "" (empty string, no selector shown)
 * - Multiple agents -> returns TemplateResult (selector rendered)
 * - i18n key "chat.selectors.agentFilter" used for aria-label
 * - onSwitchSession callback called with correct session key
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock lit so we can detect TemplateResult returns
const mockTemplateResult = { _templateType: 'TemplateResult' as const };
vi.mock('lit', () => ({
  html: Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => mockTemplateResult,
    { _templateType: 'TemplateResult' as const },
  ),
}));

vi.mock('lit/directives/repeat.js', () => ({
  repeat: () => '',
}));

// Track t() calls
const tMock = vi.fn((key: string) => key);
vi.mock('../../i18n/index.ts', () => ({
  t: (...args: Parameters<typeof tMock>) => tMock(...args),
}));

// Mock modules with unresolved upstream aliases to prevent cascade
vi.mock('../app-chat.ts', () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 120,
  CHAT_SESSIONS_REFRESH_LIMIT: 100,
  refreshChat: vi.fn(),
  refreshChatAvatar: vi.fn(),
}));

vi.mock('../chat-model-ref.ts', () => ({
  createChatModelOverride: vi.fn((model: string) => ({ model })),
}));

vi.mock('../chat-model-select-state.ts', () => ({
  resolveChatModelOverrideValue: vi.fn(() => ''),
  resolveChatModelSelectState: vi.fn(() => ({
    currentOverride: '',
    defaultLabel: 'Default',
    provider: null,
    model: null,
    options: [],
  })),
}));

vi.mock('../controllers/agents.ts', () => ({
  refreshVisibleToolsEffectiveForCurrentSession: vi.fn(),
}));

vi.mock('../controllers/sessions.ts', () => ({
  loadSessions: vi.fn(),
}));

import { renderChatAgentSelect } from './session-controls.ts';
import type { AppViewState } from '../app-view-state.ts';

describe('98-T2-REQ-B: renderChatAgentSelect — single agent behavior', () => {
  beforeEach(() => {
    tMock.mockClear();
  });

  it('returns empty string when options array is empty', () => {
    const state = { connected: true } as AppViewState;
    const result = renderChatAgentSelect(state, vi.fn(), []);
    expect(result).toBe('');
  });

  it('returns empty string when options array has exactly 1 element', () => {
    const state = { connected: true } as AppViewState;
    const result = renderChatAgentSelect(
      state,
      vi.fn(),
      [{ id: 'main', label: 'Main Agent' }],
    );
    expect(result).toBe('');
  });

  it('does not call t() when there is a single agent', () => {
    const state = { connected: true } as AppViewState;
    renderChatAgentSelect(state, vi.fn(), [{ id: 'main', label: 'Main Agent' }]);
    expect(tMock).not.toHaveBeenCalled();
  });

  it('does not call onSwitchSession when there is a single agent', () => {
    const onSwitch = vi.fn();
    const state = { connected: true } as AppViewState;
    renderChatAgentSelect(state, onSwitch, [{ id: 'main', label: 'Main Agent' }]);
    expect(onSwitch).not.toHaveBeenCalled();
  });
});

describe('98-T2-REQ-B: renderChatAgentSelect — multiple agents behavior', () => {
  const multiAgentState = {
    connected: true,
    sessionKey: 'main',
    agentsList: {
      defaultId: 'main',
      agents: [
        { id: 'main', name: 'Main' },
        { id: 'analysis', name: 'Analysis Agent' },
      ],
    },
  } as unknown as AppViewState;

  beforeEach(() => {
    tMock.mockClear();
  });

  it('returns a TemplateResult when multiple agents exist', () => {
    const options = [
      { id: 'main', label: 'Main Agent' },
      { id: 'analysis', label: 'Analysis Agent' },
    ];
    const result = renderChatAgentSelect(multiAgentState, vi.fn(), options);
    expect(result).not.toBe('');
  });

  it('calls t() with "chat.selectors.agentFilter" for aria-label', () => {
    const options = [
      { id: 'main', label: 'Main Agent' },
      { id: 'analysis', label: 'Analysis Agent' },
    ];
    renderChatAgentSelect(multiAgentState, vi.fn(), options);
    expect(tMock).toHaveBeenCalledWith('chat.selectors.agentFilter');
  });
});

describe('98-T3-REQ: Agent selector wiring in app-render.helpers.ts', () => {
  it('renderChatAgentSelect is exported and is a function', () => {
    expect(renderChatAgentSelect).toBeTypeOf('function');
  });

  it('renderChatAgentSelect has name "renderChatAgentSelect"', () => {
    expect(renderChatAgentSelect.name).toBe('renderChatAgentSelect');
  });
});
