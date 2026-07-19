import { describe, expect, it } from 'vitest';
import { TAB_GROUPS, pathForTab, tabFromPath } from '../../navigation.ts';

describe('UI-02: navigation contract', () => {
  it('round-trips every visible navigation tab through its route', () => {
    const visibleTabs = TAB_GROUPS.flatMap((group) => group.tabs);
    for (const tab of visibleTabs) {
      expect(tabFromPath(pathForTab(tab))).toBe(tab);
    }
  });

  it('does not resolve removed legacy routes', () => {
    expect(tabFromPath('/system')).toBeNull();
    expect(tabFromPath('/appearance')).toBeNull();
  });
});
