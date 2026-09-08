import { describe, expect, it } from 'vitest';
import { icons } from '../../../../icons.ts';
import { TAB_GROUPS, TAB_REQUIRED_PERMISSIONS, UTILITY_TABS, iconForTab, inferBasePathFromPathname, pathForTab, tabFromPath } from '../../navigation.ts';
import { hasSlidePermission } from '../../app-settings.ts';
import { SETTINGS_ITEMS } from '../../settings-navigation.ts';
import { agentLogoUrl } from '../agents-utils.ts';

describe('UI-02: navigation contract', () => {
  it('round-trips every visible navigation tab through its route', () => {
    const visibleTabs = [...TAB_GROUPS.flatMap((group) => group.tabs), ...UTILITY_TABS];
    for (const tab of visibleTabs) {
      expect(tabFromPath(pathForTab(tab))).toBe(tab);
    }
  });

  it('resolves legacy setting routes through the settings shell', () => {
    expect(tabFromPath('/system')).toBe('settings');
    expect(tabFromPath('/appearance')).toBe('settings');
    expect(inferBasePathFromPathname('/system')).toBe('');
    expect(inferBasePathFromPathname('/appearance')).toBe('');
  });

  it('recognizes every stable settings child route with and without a base path', () => {
    for (const item of SETTINGS_ITEMS) {
      expect(tabFromPath(item.path)).toBe('settings');
      expect(tabFromPath(`/control${item.path}`, '/control')).toBe('settings');
      expect(inferBasePathFromPathname(`/control${item.path}`)).toBe('/control');
    }
  });

  it('uses the specified primary navigation groups and fixed utility entries', () => {
    expect(TAB_GROUPS.map((group) => [group.label, [...group.tabs]])).toEqual([
      ['workspace', ['chat', 'dashboard']],
      ['resources', ['servers', 'network-devices', 'instances-db']],
      ['operations', ['events', 'resource-diagnosis', 'sql-console', 'cron-jobs', 'reports']],
      ['securityGovernance', ['approval', 'audit-center']],
    ]);
    expect(UTILITY_TABS).toEqual(['health-center', 'feedback', 'settings']);
    expect(pathForTab('health-center')).toBe('/health');
    expect(tabFromPath('/health')).toBe('health-center');
    expect(pathForTab('feedback')).toBe('/feedback');
    expect(tabFromPath('/feedback')).toBe('feedback');
    expect(TAB_REQUIRED_PERMISSIONS['health-center']).toBe('config:view');
    expect(TAB_REQUIRED_PERMISSIONS['audit-center']).toBe('audit:view');
  });

  it('uses valid, distinct icons for every visible primary and settings entry', () => {
    const visibleTabs = [...TAB_GROUPS.flatMap((group) => group.tabs), ...UTILITY_TABS];
    const iconNames = [
      ...visibleTabs.map((tab) => iconForTab(tab)),
      ...SETTINGS_ITEMS.map((item) => item.icon),
    ];

    for (const iconName of iconNames) expect(icons[iconName]).toBeDefined();
    expect(new Set(iconNames).size).toBe(iconNames.length);
  });

  it('resolves the product logo from the app root and an optional base path', () => {
    expect(agentLogoUrl('')).toBe('/favicon.svg');
    expect(agentLogoUrl('/control/')).toBe('/control/favicon.svg');
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
    expect(hasSlidePermission(new Set(['instance:*']), TAB_REQUIRED_PERMISSIONS.dashboard)).toBe(true);
    expect(hasSlidePermission(new Set(['servers:*']), TAB_REQUIRED_PERMISSIONS.dashboard)).toBe(true);
    expect(hasSlidePermission(new Set(['network_devices:*']), TAB_REQUIRED_PERMISSIONS.dashboard)).toBe(true);
    expect(hasSlidePermission(new Set(['*:view']), TAB_REQUIRED_PERMISSIONS.dashboard)).toBe(true);
  });
});
