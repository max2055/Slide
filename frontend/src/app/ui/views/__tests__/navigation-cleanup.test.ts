import { describe, expect, it } from 'vitest';
import { TAB_GROUPS, TAB_REQUIRED_PERMISSIONS, inferBasePathFromPathname, pathForTab, tabFromPath } from '../../navigation.ts';
import { hasSlidePermission } from '../../app-settings.ts';

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
    expect(inferBasePathFromPathname('/system')).toBe('');
    expect(inferBasePathFromPathname('/appearance')).toBe('');
  });

  it('exposes system health under operations with config:view protection', () => {
    const operations = TAB_GROUPS.find((group) => group.label === 'slide');
    expect(operations?.tabs).toContain('health-center');
    expect(pathForTab('health-center')).toBe('/health');
    expect(tabFromPath('/health')).toBe('health-center');
    expect(TAB_REQUIRED_PERMISSIONS['health-center']).toBe('config:view');
  });

  it('round-trips network-device inventory and context routes independently', () => {
    expect(pathForTab('network-devices' as any)).toBe('/network-devices');
    expect(tabFromPath('/network-devices')).toBe('network-devices');
    expect(pathForTab('network-device-detail' as any)).toBe('/network-device-detail');
    expect(tabFromPath('/network-device-detail')).toBe('network-device-detail');
    expect(TAB_REQUIRED_PERMISSIONS['network-devices' as any]).toBe('network_devices:view');
  });

  it('protects the unified dashboard with the dashboard permission', () => {
    expect(TAB_REQUIRED_PERMISSIONS.dashboard).toBe('view_dashboard');
    expect(hasSlidePermission(new Set(['servers:view']), TAB_REQUIRED_PERMISSIONS.dashboard)).toBe(true);
    expect(hasSlidePermission(new Set(['network_devices:view']), TAB_REQUIRED_PERMISSIONS.dashboard)).toBe(true);
  });
});
