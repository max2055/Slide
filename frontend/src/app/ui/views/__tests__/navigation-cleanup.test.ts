import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const NAV_PATH = '/Users/max/Coding/39-Slide/frontend/src/openclaw/ui/navigation.ts';
const RENDER_PATH = '/Users/max/Coding/39-Slide/frontend/src/openclaw/ui/app-render.ts';

// Per commit 3d6f4483c5e: only config and system were permanently removed
// from the Tab type union. sessions, usage, skills were intentionally restored.
// Note: "appearance" is in TAB_GROUPS settings group but NOT in Tab type
// (pre-existing inconsistency — kept as-is since tabs render via groups).
const REMOVED_TABS = ['config', 'system'];

function extractDecl(source: string, declName: string): string {
  const re = new RegExp(`(?:export\\s+)?(?<kind>const|function|type)\\s+${declName}(?:<[^>]+>)?(?:\\s*:\\s*[^;{}=]+)?\\s*(?:=|\\()`);
  const match = re.exec(source);
  if (!match) throw new Error(`Could not find declaration for ${declName}`);
  const start = match.index;
  const kind = match.groups!.kind;

  let braceDepth = 0;
  let parenDepth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') braceDepth++;
    else if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0 && kind === 'function') return source.slice(start, i + 1);
    } else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === ';' && braceDepth === 0 && parenDepth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not find delimiter for ${declName}`);
}

describe('UI-02: Removed tabs absent from navigation.ts data structures', () => {
  const navContent = readFileSync(NAV_PATH, 'utf8');

  describe('Tab type union', () => {
    const tabTypeDecl = extractDecl(navContent, 'Tab');
    for (const tab of REMOVED_TABS) {
      it(`"${tab}" is absent from Tab type union`, () => {
        expect(tabTypeDecl).not.toContain(`"${tab}"`);
      });
    }
    // sessions, usage, skills were intentionally restored (commit 3d6f4483c5e)
    it('"sessions" is kept (intentionally restored)', () => {
      expect(tabTypeDecl).toContain('"sessions"');
    });
    it('"usage" is kept (intentionally restored)', () => {
      expect(tabTypeDecl).toContain('"usage"');
    });
    it('"skills" is kept (intentionally restored)', () => {
      expect(tabTypeDecl).toContain('"skills"');
    });
    // "appearance" was also removed from Tab type (not restored)
    it('"appearance" is absent from Tab type union', () => {
      expect(tabTypeDecl).not.toContain('"appearance"');
    });
  });

  describe('TAB_GROUPS', () => {
    const groupsDecl = extractDecl(navContent, 'TAB_GROUPS');
    for (const tab of REMOVED_TABS) {
      it(`"${tab}" is absent from TAB_GROUPS`, () => {
        expect(groupsDecl).not.toContain(`"${tab}"`);
      });
    }
    // Sessions, usage, skills kept in openclaw group
    it('"sessions" is kept in openclaw group (intentionally restored)', () => {
      expect(groupsDecl).toContain('"sessions"');
    });
    it('"usage" is kept in openclaw group (intentionally restored)', () => {
      expect(groupsDecl).toContain('"usage"');
    });
    it('"skills" is kept in openclaw group (intentionally restored)', () => {
      expect(groupsDecl).toContain('"skills"');
    });
    // Note: "appearance" is in TAB_GROUPS settings but NOT in Tab type
    // This is a pre-existing inconsistency — the group entry is inert since
    // no valid Tab value matches it. Kept for documentation.
    it('"appearance" in TAB_GROUPS is noted (inert — not a valid Tab value)', () => {
      expect(groupsDecl).toContain('"appearance"');
    });
  });

  describe('TAB_PATHS', () => {
    const pathsDecl = extractDecl(navContent, 'TAB_PATHS');
    for (const tab of REMOVED_TABS) {
      it(`key "${tab}" is absent from TAB_PATHS`, () => {
        expect(pathsDecl).not.toContain(`${tab}:`);
      });
    }
    it('"sessions" path is kept (intentionally restored)', () => {
      expect(pathsDecl).toContain('sessions:');
    });
    it('"usage" path is kept (intentionally restored)', () => {
      expect(pathsDecl).toContain('usage:');
    });
    it('"skills" path is kept (intentionally restored)', () => {
      expect(pathsDecl).toContain('skills:');
    });
    it('"appearance" path is kept', () => {
      expect(pathsDecl).toContain('appearance:');
    });
  });

  describe('iconForTab switch cases', () => {
    const iconDecl = extractDecl(navContent, 'iconForTab');
    for (const tab of REMOVED_TABS) {
      it(`case "${tab}" is absent from iconForTab`, () => {
        expect(iconDecl).not.toContain(`case "${tab}":`);
      });
    }
    it('case "sessions" is kept (intentionally restored)', () => {
      expect(iconDecl).toContain('case "sessions":');
    });
    it('case "usage" is kept (intentionally restored)', () => {
      expect(iconDecl).toContain('case "usage":');
    });
    it('case "skills" is kept (intentionally restored)', () => {
      expect(iconDecl).toContain('case "skills":');
    });
    it('case "appearance" is kept', () => {
      expect(iconDecl).toContain('case "appearance":');
    });
  });
});

describe('UI-02: Dead render code for removed tabs in app-render.ts', () => {
  const renderContent = readFileSync(RENDER_PATH, 'utf8');

  it('has no "config" in Tab type (verified above), so config/appearance/system render block is unreachable dead code', () => {
    // Line 1608: state.tab === "config" || state.tab === "appearance" || state.tab === "system"
    // These three values are NOT in the Tab type union, so this branch never executes.
    // This is dead code that should be cleaned up.
    expect(renderContent).toMatch(/state\.tab\s*===\s*["']config["']\s*\|\|\s*state\.tab\s*===\s*["']appearance["']\s*\|\|\s*state\.tab\s*===\s*["']system["']/);
  });

  it('has "state.tab === config" guard at line 932 (dead — "config" not a valid Tab)', () => {
    // Line 932: state.tab === "config" ? nothing : html`<section class="content-header">...
    // Since "config" is not in Tab type, this guard always evaluates true.
    // In practice it correctly hides the content header for nothing.
    expect(renderContent).toMatch(/state\.tab\s*===\s*["']config["']/);
  });
});
