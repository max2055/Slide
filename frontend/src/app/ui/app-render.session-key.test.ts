import { html, render } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlideApp } from './app.ts';
import { renderApp } from './app-render.ts';
import type { AppViewState } from './app-view-state.ts';
import { renderAgents } from './views/agents.ts';
import { renderChat } from './views/chat.ts';

vi.mock('./views/agents.ts', () => ({ renderAgents: vi.fn(() => html``) }));
vi.mock('./views/chat.ts', () => ({
  renderChat: vi.fn(() => html``),
  clearChatViewCaches: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

function createState() {
  const app = new SlideApp();
  app.connected = true;
  app.agentsList = {
    defaultId: 'main', mainKey: 'main', scope: 'per-sender',
    agents: [
      { id: 'main', identity: { avatarUrl: 'https://example.test/main.png' } },
      { id: 'ops', identity: { avatarUrl: 'https://example.test/ops.png' } },
    ],
  };
  return app as unknown as AppViewState;
}

// MAX-453 / #288: exercise the rendering entry point, not only the parser.
describe('main app session identity', () => {
  it.each([
    ['agent:main:main', 'main'],
    ['agent:ops:main', 'ops'],
    ['agent:ops:chat:history', 'ops'],
    [' AGENT:OPS:MAIN ', 'ops'],
    ['main', 'main'],
    ['ops:main', 'main'],
    ['invalid', 'main'],
    ['agent:ops', 'main'],
    ['', 'main'],
  ])('resolves avatar for %s with existing default fallback', (key, agentId) => {
    const state = createState();
    state.tab = 'chat';
    state.sessionKey = key;
    renderApp(state);
    expect(vi.mocked(renderChat).mock.lastCall?.[0].assistantAvatarUrl)
      .toBe(`https://example.test/${agentId}.png`);
  });

  it('uses the configured default avatar for an invalid key', () => {
    const state = createState();
    state.tab = 'chat';
    state.sessionKey = 'invalid';
    state.agentsList!.defaultId = 'ops';
    renderApp(state);
    expect(vi.mocked(renderChat).mock.lastCall?.[0].assistantAvatarUrl)
      .toBe('https://example.test/ops.png');
  });

  it('recomputes tools session ownership when session or selected Agent changes', async () => {
    const state = createState();
    state.tab = 'agents';
    state.agentsPanel = 'tools';
    const container = document.createElement('div');
    for (const [key, selected, matches] of [
      ['agent:main:main', 'main', true],
      ['agent:ops:chat:history', 'main', false],
      ['agent:ops:chat:history', 'ops', true],
      [' AGENT:OPS:MAIN ', 'ops', true],
      ['agent:main:main', 'ops', false],
      ['main', 'main', false],
      ['ops:main', 'ops', false],
      ['agent:ops', 'ops', false],
      ['', 'main', false],
    ] as const) {
      state.sessionKey = key;
      state.agentsSelectedId = selected;
      await vi.waitFor(() => {
        render(renderApp(state), container);
        expect(vi.mocked(renderAgents).mock.lastCall?.[0]).toMatchObject({
          runtimeSessionKey: key,
          runtimeSessionMatchesSelectedAgent: matches,
        });
      });
    }
  });
});
