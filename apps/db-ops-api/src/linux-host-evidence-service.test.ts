import { describe, expect, it, vi } from 'vitest';
import {
  LinuxHostEvidenceService,
  buildPhysicalFileCommand,
  discoverJournalUnits,
  parseFilesystemEvidence,
  parseJournalJson,
  parsePhysicalFileOutput,
  resolveJournalUnits,
  validatePhysicalPaths,
} from './linux-host-evidence-service.js';

describe('Linux host evidence parsers', () => {
  it('merges RHEL 7/8 byte, inode and findmnt output by decoded mount', () => {
    const bytes = `Filesystem 1-blocks Used Available Capacity Mounted on
/dev/mapper/rhel-root 53660876800 21464350720 32196526080 40% /
/dev/sdb1 107374182400 53687091200 53687091200 50% /var/lib/mysql\\040data`;
    const inodes = `Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/mapper/rhel-root 26214400 110000 26104400 1% /
/dev/sdb1 52428800 1000 52427800 1% /var/lib/mysql\\040data`;
    const findmnt = `/dev/mapper/rhel-root / xfs
/dev/sdb1 /var/lib/mysql\\040data ext4`;

    expect(parseFilesystemEvidence(bytes, inodes, findmnt)).toEqual([
      {
        mount: '/', device: '/dev/mapper/rhel-root', fsType: 'xfs',
        sizeBytes: 53660876800, usedBytes: 21464350720, availableBytes: 32196526080,
        usagePercent: 40, inodeTotal: 26214400, inodeUsed: 110000,
        inodeAvailable: 26104400, inodeUsagePercent: 1,
      },
      {
        mount: '/var/lib/mysql data', device: '/dev/sdb1', fsType: 'ext4',
        sizeBytes: 107374182400, usedBytes: 53687091200, availableBytes: 53687091200,
        usagePercent: 50, inodeTotal: 52428800, inodeUsed: 1000,
        inodeAvailable: 52427800, inodeUsagePercent: 1,
      },
    ]);
  });

  it('keeps safe journal fields, drops non-string messages and reports malformed JSON', () => {
    const input = [
      JSON.stringify({
        '__REALTIME_TIMESTAMP': '1700000000000000', PRIORITY: '3',
        '_SYSTEMD_UNIT': 'mysqld.service', SYSLOG_IDENTIFIER: 'mysqld', _PID: '42',
        MESSAGE: 'password=hunter2 failed login', EXTRA: 'discard',
      }),
      '{broken-json',
      JSON.stringify({ MESSAGE: { nested: 'not allowed' } }),
    ].join('\n');

    const result = parseJournalJson(input);
    expect(result.entries).toEqual([{
      timestamp: '2023-11-14T22:13:20.000Z', severity: 'error',
      unit: 'mysqld.service', identifier: 'mysqld', pid: '42',
      message: 'password=[REDACTED] failed login',
    }]);
    expect(result.malformedLines).toBe(1);
  });
});

describe('Linux host evidence input boundaries', () => {
  it('uses a strict database service allowlist and rejects shell syntax or newlines', () => {
    expect(resolveJournalUnits('mysql', ['mysqld', 'mariadb'])).toEqual([
      'mysqld.service', 'mariadb.service',
    ]);
    expect(resolveJournalUnits('postgresql', ['postgresql-13.service'])).toEqual([
      'postgresql-13.service',
    ]);
    expect(() => resolveJournalUnits('mysql', ['mysqld;id'])).toThrow('HOST_LOG_UNIT_INVALID');
    expect(() => resolveJournalUnits('mysql', ['mysqld\n--dmesg'])).toThrow('HOST_LOG_UNIT_INVALID');
    expect(() => resolveJournalUnits('mysql', ['postgresql'])).toThrow('HOST_LOG_UNIT_NOT_ALLOWED');
  });

  it('strictly discovers only database-specific systemd services', () => {
    const units = `postgresql.service enabled
postgresql-13.service enabled
postgresql-13.service;id enabled
oracle-db.service enabled
DmServiceDMSERVER.service enabled
ssh.service enabled`;

    expect(discoverJournalUnits('postgresql', units)).toEqual([
      'postgresql.service', 'postgresql-13.service',
    ]);
    expect(discoverJournalUnits('oracle', units)).toEqual(['oracle-db.service']);
    expect(discoverJournalUnits('dameng', units)).toEqual(['DmServiceDMSERVER.service']);
  });

  it('filters unsafe, ASM and duplicate paths and enforces the 128-path cap', () => {
    const paths = [
      '/var/lib/mysql', '/var/lib/mysql', '+DATA/ORCL/datafile/system.1',
      '/var/lib/../root', '/tmp/bad\npath', ...Array.from({ length: 140 }, (_, i) => `/data/${i}`),
    ];

    const result = validatePhysicalPaths(paths);
    expect(result.paths).toHaveLength(128);
    expect(result.paths[0]).toBe('/var/lib/mysql');
    expect(result.paths).not.toContain('+DATA/ORCL/datafile/system.1');
    expect(result.truncated).toBe(true);
    expect(result.rejected).toEqual(expect.arrayContaining([
      { index: 2, reason: 'PHYSICAL_PATH_NOT_POSIX' },
      { index: 3, reason: 'PHYSICAL_PATH_INVALID' },
      { index: 4, reason: 'PHYSICAL_PATH_INVALID' },
    ]));
  });

  it('passes a Base64 path as a fixed sh positional argument without exposing raw input', () => {
    const malicious = "/var/lib/mysql/a';$(touch /tmp/pwn)";
    const command = buildPhysicalFileCommand(malicious);

    expect(command).not.toContain(malicious);
    expect(command).toContain("sh -c");
    expect(command).toContain('stat -Lc');
    expect(command).toContain('df -P -B1 -- "$p"');
    expect(command).toContain('df -Pi -- "$p"');
    expect(command).not.toContain('sudo');
  });

  it('parses the fixed stat and df protocol without relying on escaped tabs', () => {
    const output = `STAT|regular file|10|2|4096|1700000000|640|mysql|mysql
DF_BYTES
Filesystem 1-blocks Used Available Capacity Mounted on
/dev/sda1 1000 400 600 40% /var/lib/mysql
DF_INODES
Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/sda1 100 20 80 20% /var/lib/mysql
`;

    expect(parsePhysicalFileOutput('/var/lib/mysql/ibdata1', output)).toMatchObject({
      path: '/var/lib/mysql/ibdata1', quality: 'good', type: 'regular file',
      sizeBytes: 10, allocatedBytes: 8192, mode: '640', owner: 'mysql', group: 'mysql',
      filesystem: { mount: '/var/lib/mysql', usagePercent: 40, inodeUsagePercent: 20 },
    });
    expect(buildPhysicalFileCommand('/var/lib/mysql/ibdata1')).toContain('STAT|%F|%s');
  });
});

describe('LinuxHostEvidenceService lifecycle', () => {
  it('validates uname first and releases an unsupported host without collecting evidence', async () => {
    const client = {} as any;
    const execCommands = vi.fn().mockResolvedValue([{
      stdout: 'AIX\n', stderr: '', exitCode: 0, signal: null, truncated: false,
    }]);
    const releaseConnection = vi.fn();
    const closeConnection = vi.fn();
    const service = new LinuxHostEvidenceService({
      serverDatabaseService: {
        getServerById: vi.fn().mockResolvedValue({
          id: 9, host: 'db.internal', port: 22, credential_type: 'password',
          host_key_fingerprint: 'SHA256:test', os_type: 'other',
        }),
        getDecryptedCredentials: vi.fn().mockResolvedValue({ username: 'ops', password: 'secret' }),
      } as any,
      sshSessionPool: {
        getConnection: vi.fn().mockResolvedValue(client), execCommands,
        releaseConnection, closeConnection,
      } as any,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    });

    await expect(service.collectHostEvidence(9, {
      databaseType: 'mysql', services: ['mysqld'], paths: [],
    })).rejects.toThrow('HOST_OS_UNSUPPORTED');
    expect(execCommands).toHaveBeenCalledTimes(1);
    expect(execCommands.mock.calls[0][1]).toEqual(['LC_ALL=C LANG=C uname -s']);
    expect(releaseConnection).toHaveBeenCalledWith(client);
    expect(closeConnection).not.toHaveBeenCalled();
  });

  it('returns good bounded evidence when every fixed Linux source succeeds', async () => {
    const client = {} as any;
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null, truncated: false });
    const execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map((command) => {
      if (command.includes('uname -s')) return ok('Linux\n');
      if (command.includes('systemctl list-unit-files')) return ok('mysqld.service enabled\n');
      if (command === 'LC_ALL=C LANG=C df -P -B1') {
        return ok('Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\n');
      }
      if (command === 'LC_ALL=C LANG=C df -Pi') {
        return ok('Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 100 20 80 20% /\n');
      }
      if (command.includes('findmnt -rn')) return ok('/dev/sda1 / xfs\n');
      if (command.includes('journalctl')) return ok();
      return ok('1\n');
    }));
    const releaseConnection = vi.fn();
    const service = new LinuxHostEvidenceService({
      serverDatabaseService: {
        getServerById: vi.fn().mockResolvedValue({
          id: 9, host: 'db.internal', port: 22, credential_type: 'password',
          host_key_fingerprint: 'SHA256:test', os_type: 'RHEL 8',
        }),
        getDecryptedCredentials: vi.fn().mockResolvedValue({ username: 'ops', password: 'secret' }),
      } as any,
      sshSessionPool: {
        getConnection: vi.fn().mockResolvedValue(client), execCommands,
        releaseConnection, closeConnection: vi.fn(),
      } as any,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    });

    const evidence = await service.collectHostEvidence(9, {
      databaseType: 'mysql', services: ['mysqld'], paths: [],
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      serverId: 9,
      collectedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      quality: 'good',
      truncated: false,
      systemLogs: { quality: 'good', entries: [] },
      physicalFiles: { quality: 'good', items: [] },
      gaps: [],
    });
    expect(evidence.filesystems.items[0]).toMatchObject({ mount: '/', fsType: 'xfs' });
    expect(releaseConnection).toHaveBeenCalledWith(client);
  });
});
