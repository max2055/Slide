import { describe, expect, it } from 'vitest';

import {
  getServerOsProfile,
  isSupportedServerOs,
  normalizeServerOs,
  type SupportedServerOs,
} from './server-os-profile.js';

describe('server OS normalization', () => {
  it.each([
    ['kylin', 'kylin'],
    ['Kylin V10', 'kylin'],
    ['rhel 8', 'rhel'],
    ['RHEL8', 'rhel'],
    ['red hat enterprise linux 9', 'rhel'],
    ['centos 7', 'centos'],
    ['CentOS Linux 8', 'centos'],
    ['centos9', 'centos'],
  ] as const)('normalizes %s to %s', (input, expected: SupportedServerOs) => {
    expect(normalizeServerOs(input)).toBe(expected);
    expect(isSupportedServerOs(input)).toBe(true);
    expect(getServerOsProfile(input)?.canonical).toBe(expected);
  });

  it.each([
    '',
    '   ',
    null,
    undefined,
    'Ubuntu 22.04',
    'Debian 12',
    'Windows Server 2022',
    'Linux',
    'AIX',
    'rhel; id',
    'centos $(id)',
    'kylin\ncat /etc/passwd',
  ])('rejects unsupported or unsafe OS label %s', (input) => {
    expect(normalizeServerOs(input)).toBeNull();
    expect(isSupportedServerOs(input)).toBe(false);
    expect(getServerOsProfile(input)).toBeNull();
  });

  it('exposes a locale-independent command environment for every supported profile', () => {
    for (const value of ['kylin', 'rhel', 'centos'] as const) {
      const profile = getServerOsProfile(value);
      expect(profile).toMatchObject({ canonical: value });
      expect(profile?.commandEnvironment).toBe('LC_ALL=C LANG=C');
    }
  });
});
