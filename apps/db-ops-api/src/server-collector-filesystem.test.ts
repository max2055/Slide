import { describe, expect, it } from 'vitest';
import { buildFilesystemMetricRows } from './server-collector.js';
import { ServerMetricProvider, isSupportedLinuxOsType } from './server-metric-provider.js';
import { metricRegistry } from './metric-registry.js';

describe('server collector filesystem rows', () => {
  it('persists legacy usage plus byte and inode metrics with filesystem dimensions', () => {
    const rows = buildFilesystemMetricRows(
      `Filesystem 1-blocks Used Available Capacity Mounted on
/dev/mapper/rhel-data 100000 60000 40000 60% /var/lib/mysql`,
      `Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/mapper/rhel-data 1000 250 750 25% /var/lib/mysql`,
      '/dev/mapper/rhel-data /var/lib/mysql xfs',
    );

    expect(rows).toEqual([
      { metricName: 'disk_usage', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fsType: 'xfs' }, value: 60 },
      { metricName: 'filesystem_size_bytes', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fsType: 'xfs' }, value: 100000 },
      { metricName: 'filesystem_used_bytes', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fsType: 'xfs' }, value: 60000 },
      { metricName: 'filesystem_available_bytes', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fsType: 'xfs' }, value: 40000 },
      { metricName: 'filesystem_inode_usage', dimensions: { mount: '/var/lib/mysql', device: '/dev/mapper/rhel-data', fsType: 'xfs' }, value: 25 },
    ]);
  });
});

describe('server metric Linux OS recognition', () => {
  it.each([
    'RHEL 7.9', 'rhel8', 'CentOS Linux 7', 'Rocky Linux 8.9',
    'AlmaLinux 9.2', 'Oracle Linux Server 8.10',
    'Red Hat Enterprise Linux 7', 'Red Hat Enterprise Linux 8.10',
  ])('recognizes supported distro label %s', (osType) => {
    expect(isSupportedLinuxOsType(osType)).toBe(true);
    expect(new ServerMetricProvider().getDefinitions(osType).length).toBeGreaterThan(0);
  });

  it('does not trust arbitrary or unverified OS labels as Linux', () => {
    expect(isSupportedLinuxOsType('other')).toBe(false);
    expect(isSupportedLinuxOsType('AIX')).toBe(false);
    expect(new ServerMetricProvider().getDefinitions('other')).toEqual([]);
  });
});

describe('filesystem metric registry', () => {
  it.each([
    ['filesystem_size_bytes', 'bytes'],
    ['filesystem_used_bytes', 'bytes'],
    ['filesystem_available_bytes', 'bytes'],
    ['filesystem_inode_usage', '%'],
  ])('registers %s as a server metric', (metricName, unit) => {
    const definition = metricRegistry.getById(metricName, 'server');
    expect(definition).toMatchObject({ id: metricName, unit, target_type: 'server' });
  });
});
