/**
 * Nyquist validation: Phase 98 — Structural artifact verification
 *
 * Verifies:
 * - GatewayThinkingLevelOption type exists in types.ts
 * - CHAT_SESSIONS_REFRESH_LIMIT constant exists in app-chat.ts
 * - i18n key "chat.selectors.agentFilter" exists in en.ts and zh-CN.ts
 * - renderChatAgentSelect is imported in app-render.helpers.ts
 * - agentSelect wiring exists with switchChatSession handler
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const UI_DIR = resolve(import.meta.dirname, '.');

describe('98-T1-REQ-C: GatewayThinkingLevelOption type in types.ts', () => {
  const typesContent = readFileSync(resolve(UI_DIR, 'types.ts'), 'utf8');

  it('is declared as a type', () => {
    expect(typesContent).toMatch(/export\s+type\s+GatewayThinkingLevelOption\s*=\s*\{/);
  });

  it('has an id field', () => {
    expect(typesContent).toMatch(/id:\s*string/);
  });

  it('has a label field', () => {
    expect(typesContent).toMatch(/label:\s*string/);
  });
});

describe('98-T1-REQ-D: CHAT_SESSIONS_REFRESH_LIMIT constant in app-chat.ts', () => {
  const appChatContent = readFileSync(resolve(UI_DIR, 'app-chat.ts'), 'utf8');

  it('is exported as a constant', () => {
    expect(appChatContent).toMatch(/export\s+const\s+CHAT_SESSIONS_REFRESH_LIMIT\s*=/);
  });

  it('has value 100', () => {
    expect(appChatContent).toMatch(/CHAT_SESSIONS_REFRESH_LIMIT\s*=\s*100/);
  });
});

describe('98-T1-REQ-E: i18n key chat.selectors.agentFilter', () => {
  it('exists in en.ts', () => {
    const enContent = readFileSync(
      resolve(UI_DIR, '../i18n/locales/en.ts'),
      'utf8',
    );
    expect(enContent).toContain('agentFilter');
  });

  it('exists in zh-CN.ts', () => {
    const zhContent = readFileSync(
      resolve(UI_DIR, '../i18n/locales/zh-CN.ts'),
      'utf8',
    );
    expect(zhContent).toContain('agentFilter');
  });
});

describe('98-T3-REQ-A: renderChatAgentSelect import and wiring in app-render.helpers.ts', () => {
  const helpersContent = readFileSync(resolve(UI_DIR, 'app-render.helpers.ts'), 'utf8');

  it('imports renderChatAgentSelect from chat/session-controls', () => {
    expect(helpersContent).toMatch(
      /import\s*\{\s*renderChatAgentSelect\s*\}\s*from\s*["']\.\/chat\/session-controls\.ts["']/,
    );
  });

  it('calls renderChatAgentSelect with state and switchChatSession handler', () => {
    expect(helpersContent).toMatch(
      /agentSelect\s*=\s*renderChatAgentSelect\s*\(.*switchChatSession/,
    );
  });

  it('has agentSelect variable in renderChatSessionSelect', () => {
    expect(helpersContent).toMatch(/const\s+agentSelect\s*=\s*renderChatAgentSelect/);
  });

  it('includes ${agentSelect} in the template output', () => {
    expect(helpersContent).toMatch(/\$\{agentSelect\}/);
  });
});

describe('98-T2: session-controls.ts file integrity', () => {
  const controlsContent = readFileSync(resolve(UI_DIR, 'chat/session-controls.ts'), 'utf8');

  it('has export keyword on renderChatAgentSelect', () => {
    expect(controlsContent).toMatch(/export\s+function\s+renderChatAgentSelect/);
  });

  it('has minimum 800 lines (ported session controls)', () => {
    const lines = controlsContent.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(800);
  });

  it('has the i18n import with correct relative path for ui/chat/ location', () => {
    // File at ui/chat/session-controls.ts, i18n at frontend/src/openclaw/i18n/index.ts
    // From ui/chat/ => ../../i18n/index.ts resolves correctly
    expect(controlsContent).toMatch(
      /import\s*\{[^}]*\b[tT]\b[^}]*\}\s*from\s*"\.\.\/\.\.\/i18n\/index\.ts"/,
    );
  });

  it('does not contain old upstream-only paths like "../../../i18n/"', () => {
    // Verify no path hopping beyond expected depth
    const threeLevelUp = controlsContent.match(/import.*"\.\.\/\.\.\/\.\.\//);
    expect(threeLevelUp).toBeNull();
  });
});
