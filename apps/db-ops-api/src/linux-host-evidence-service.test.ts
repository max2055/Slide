import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LinuxHostEvidenceService,
  buildPhysicalFileCommand,
  decodeGnuPath,
  discoverJournalUnits,
  parseFilesystemEvidence,
  parseJournalJson,
  parsePhysicalFileOutput,
  resolveJournalUnits,
  validatePhysicalPaths,
} from './linux-host-evidence-service.js';

import serverMetricProvider from './server-metric-provider.js';

describe('Linux host evidence parsers', () => {
  it('merges RHEL 7/8 byte, inode and findmnt output by decoded mount', () => {
    const bytes = `Filesystem 1-blocks Used Available Capacity Mounted on
/dev/mapper/rhel-root 53660876800 21464350720 32196526080 40% /
/dev/sdb1 107374182400 53687091200 53687091200 50% /var/lib/mysql data`;
    const inodes = `Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/mapper/rhel-root 26214400 110000 26104400 1% /
/dev/sdb1 52428800 1000 52427800 1% /var/lib/mysql data`;
    const findmnt = `/dev/mapper/rhel-root / xfs
/dev/sdb1 /var/lib/mysql\\x20data ext4`;

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

  it('decodes util-linux hex escapes while preserving GNU octal escapes', () => {
    expect(decodeGnuPath(String.raw`space\x20tab\x09line\x0aslash\x5c`)).toBe(
      'space tab\tline\nslash\\',
    );
    expect(decodeGnuPath(String.raw`space\040tab\011line\012slash\134`)).toBe(
      'space tab\tline\nslash\\',
    );
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
      message: 'password=[REDACTED]',
    }]);
    expect(result.malformedLines).toBe(1);
  });

  it('recursively redacts every projected journal field and keeps fields bounded', () => {
    const result = parseJournalJson(JSON.stringify({
      MESSAGE: 'password=message-secret failed',
      _SYSTEMD_UNIT: `password=unit-secret-${'u'.repeat(300)}`,
      SYSLOG_IDENTIFIER: `token=identifier-secret-${'i'.repeat(300)}`,
      _PID: `api_key=pid-secret-${'p'.repeat(100)}`,
    }));

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(JSON.stringify(entry)).not.toMatch(/message-secret|unit-secret|identifier-secret|pid-secret/);
    expect(entry.unit).toContain('[REDACTED]');
    expect(entry.identifier).toContain('[REDACTED]');
    expect(entry.pid).toContain('[REDACTED]');
    expect(entry.unit!.length).toBeLessThanOrEqual(256);
    expect(entry.identifier!.length).toBeLessThanOrEqual(256);
    expect(entry.pid!.length).toBeLessThanOrEqual(32);
  });

  it('redacts projected journal fields before truncating them', () => {
    const secret = 'sk-ABCDEFGHSECRET';
    const result = parseJournalJson(JSON.stringify({
      MESSAGE: 'kept',
      SYSLOG_IDENTIFIER: `${'x'.repeat(247)} ${secret}`,
      _PID: `${'x'.repeat(23)} ${secret}`,
    }));

    const entry = result.entries[0];
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(entry.identifier).not.toContain('sk-ABCDE');
    expect(entry.pid).not.toContain('sk-ABCDE');
    expect(entry.identifier!.length).toBeLessThanOrEqual(256);
    expect(entry.pid!.length).toBeLessThanOrEqual(32);
  });

  it('treats valid JSON non-objects as malformed entries instead of throwing', () => {
    const result = parseJournalJson([
      'null', '[]', '42', '"string"', JSON.stringify({ MESSAGE: 'kept' }),
    ].join('\n'));

    expect(result.entries).toEqual([expect.objectContaining({ message: 'kept' })]);
    expect(result.malformedLines).toBe(4);
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
  afterEach(() => vi.restoreAllMocks());
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null, truncated: false });
  const failed = () => ({ stdout: '', stderr: 'unavailable', exitCode: 1, signal: null, truncated: false });

  function createService(execCommands: ReturnType<typeof vi.fn>, osType = 'RHEL 8') {
    const client = {} as any;
    const releaseConnection = vi.fn();
    const closeConnection = vi.fn();
    const service = new LinuxHostEvidenceService({
      serverDatabaseService: {
        getServerById: vi.fn().mockResolvedValue({
          id: 9, host: 'db.internal', port: 22, credential_type: 'password',
          host_key_fingerprint: 'SHA256:test', os_type: osType,
        }),
        getDecryptedCredentials: vi.fn().mockResolvedValue({ username: 'ops', password: 'secret' }),
      } as any,
      sshSessionPool: {
        getConnection: vi.fn().mockResolvedValue(client), execCommands,
        releaseConnection, closeConnection,
      } as any,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    });
    return { service, client, releaseConnection, closeConnection };
  }

  function successfulCommand(command: string) {
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
    if (command.includes('/proc/meminfo')) return ok('MemTotal: 1000 kB\nMemAvailable: 250 kB\n');
    if (command.includes('/proc/net/dev')) return ok('eth0: 100 0 2 3 0 0 0 0 200 0 4 5 0 0 0 0\neth1: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n');
    if (command.includes('/proc/diskstats')) return ok('8 0 sda 1 0 2 0 1 0 3 0 0 4 0\n');
    if (command.includes('ps -eo')) return ok('42 mysqld 12.5 3.5\n');
    return ok('1\n');
  }

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

  // GitHub #277 / MAX-393: the real provider returns fresh definition objects.
  it.each(['RHEL 8', 'CentOS 7', 'Kylin V10'])('collects concrete metric values and commands for %s', async (osType) => {
    const execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map(successfulCommand));
    const { service, client, releaseConnection } = createService(execCommands, osType);

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
    expect(evidence.metrics).toMatchObject({ quality: 'good', values: {
      cpu_usage: 1, memory_usage: 75, memory_used: 1, memory_total: 1, swap_usage: 1,
      load_1min: 1, load_5min: 1, load_15min: 1, uptime: 1,
      network_rx_bytes: 110, network_tx_bytes: 220, network_rx_errors: 2,
      network_tx_errors: 4, network_rx_drops: 3, network_tx_drops: 5,
      disk_read_bytes: 1024, disk_write_bytes: 1536, disk_io_time_ms: 4,
      process_count: 1, top_processes_cpu: 12.5, top_processes_memory: 3.5,
    } });
    expect(Object.keys(evidence.metrics.values)).toHaveLength(21);
    expect(evidence.metrics.values).not.toHaveProperty('disk_usage');
    expect(evidence.metrics.values).not.toHaveProperty('disk_detail');
    const commands = execCommands.mock.calls.flatMap((call) => call[1] as string[]);
    for (const batch of serverMetricProvider.getCollectionBatches(osType)) {
      if (batch.definitions.every((definition) => definition.name === 'disk_usage' || definition.name === 'disk_detail')) continue;
      expect(commands.filter((command) => command === batch.command)).toHaveLength(1);
    }
    expect(commands.filter((command) => command === 'LC_ALL=C LANG=C df -P -B1')).toHaveLength(1);
    expect(commands).not.toContain(serverMetricProvider.getDefinitions(osType).find((definition) => definition.name === 'disk_usage')!.command);
    expect(evidence.filesystems.items[0]).toMatchObject({ mount: '/', fsType: 'xfs' });
    expect(releaseConnection).toHaveBeenCalledWith(client);
  });

  it.each([
    ['command failure', failed(), 'METRIC_COMMAND_FAILED'],
    ['missing rows', ok('malformed'), 'METRIC_PARSE_FAILED'],
  ])('retains valid metrics and reports partial evidence on %s', async (_case, result, reason) => {
    const execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map((command) =>
      command.includes('/proc/net/dev') ? result : successfulCommand(command)
    ));
    const { service } = createService(execCommands);
    const evidence = await service.collectHostEvidence(9, { databaseType: 'mysql', services: [], paths: [] });
    expect(evidence.metrics.values.memory_usage).toBe(75);
    expect(evidence.metrics.values).not.toHaveProperty('network_rx_bytes');
    expect(evidence.metrics.quality).toBe('partial');
    expect(evidence.quality).toBe('partial');
    expect(evidence.gaps).toContainEqual({ section: 'metrics', reason });
    expect(execCommands.mock.calls.some((call) => call[1].includes('LC_ALL=C LANG=C cat /proc/net/dev'))).toBe(true);
  });

  it.each([
    ['9007199254740991', '0', 9007199254740991],
    ['9007199254740991', '1', '9007199254740992'],
    ['9007199254740993', '0', '9007199254740993'],
    ['100', '10', 110],
  ])('MAX-400 sums counters exactly across interfaces: %s + %s', async (rx, second, expected) => {
    const execCommands = vi.fn(async (_client, commands: string[]) => commands.map(command => {
      if (command.includes('/proc/net/dev')) return ok(
        `eth0: ${rx} 0 2 3 0 0 0 0 9007199254740994 0 4 5 0 0 0 0\n` +
        `eth1: ${second} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
      if (command.includes('/proc/diskstats')) return ok('8 0 sda 1 0 17592186044417 0 1 0 3 0 0 4 0\n');
      return successfulCommand(command);
    }));
    const { service } = createService(execCommands);
    const evidence = await service.collectHostEvidence(9, { databaseType: 'mysql', services: [], paths: [] });
    expect(evidence.metrics.values).toMatchObject({ network_rx_bytes: expected,
      network_tx_bytes: '9007199254740994', disk_read_bytes: '9007199254741504', disk_write_bytes: 1536 });
    expect(evidence.metrics.quality).toBe('good');
    expect(JSON.parse(JSON.stringify(evidence)).metrics.values.network_rx_bytes).toBe(expected);
  });

  it.each([
    ['17592186044415', 9007199254740480],
    ['17592186044416', '9007199254740992'],
    ['3', 1536],
  ])('MAX-400 converts sectors exactly at the safe integer boundary: %s', async (sectors, expected) => {
    const execCommands = vi.fn(async (_client, commands: string[]) => commands.map(command =>
      command.includes('/proc/diskstats') ? ok(`8 0 sda 1 0 ${sectors} 0 1 0 3 0 0 4 0\n`) : successfulCommand(command)));
    const { service } = createService(execCommands);
    const evidence = await service.collectHostEvidence(9, { databaseType: 'mysql', services: [], paths: [] });
    expect(evidence.metrics.values.disk_read_bytes).toBe(expected);
    expect(evidence.metrics.quality).toBe('good');
  });

  it('MAX-403 reports malformed process samples instead of a misleading scalar maximum', async () => {
    const execCommands = vi.fn(async (_client, commands: string[]) => commands.map(command =>
      command.includes('ps -eo') ? ok('7 java worker 812.5 10.0\nbroken\n') : successfulCommand(command)));
    const { service } = createService(execCommands);
    const evidence = await service.collectHostEvidence(9, { databaseType: 'mysql', services: [], paths: [] });
    expect(evidence.metrics.quality).toBe('partial');
    expect(evidence.metrics.values).not.toHaveProperty('top_processes_cpu');
    expect(evidence.gaps).toContainEqual({ section: 'metrics', reason: 'METRIC_PARSE_FAILED' });
  });

  it.each(['other', 'empty batches', 'missing batch', 'all commands fail'])('never reports good evidence with unavailable metrics: %s', async (scenario) => {
    const batches = serverMetricProvider.getCollectionBatches('rhel');
    if (scenario === 'empty batches') vi.spyOn(serverMetricProvider, 'getCollectionBatches').mockReturnValue([]);
    if (scenario === 'missing batch') vi.spyOn(serverMetricProvider, 'getCollectionBatches').mockReturnValue(batches.filter((batch) => !batch.command.includes('/proc/meminfo')));
    const metricCommands = new Set(batches.filter((batch) => batch.definitions.some((definition) => !['disk_usage', 'disk_detail'].includes(definition.name))).map((batch) => batch.command));
    const execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map((command) =>
      scenario === 'all commands fail' && metricCommands.has(command) ? failed() : successfulCommand(command)
    ));
    const { service } = createService(execCommands, scenario === 'other' ? 'other' : 'rhel');
    const evidence = await service.collectHostEvidence(9, { databaseType: 'mysql', services: [], paths: [] });
    expect(evidence.quality).toBe('partial');
    expect(evidence.gaps).toContainEqual({ section: 'metrics', reason: 'METRICS_UNAVAILABLE' });
    if (scenario === 'missing batch') {
      expect(evidence.metrics.quality).toBe('partial');
      expect(evidence.metrics.values.cpu_usage).toBe(1);
      expect(evidence.metrics.values).not.toHaveProperty('memory_usage');
    } else {
      expect(evidence.metrics.quality).toBe('unknown');
      expect(evidence.metrics.values).toEqual({});
    }
    expect(evidence.filesystems.items[0].usagePercent).toBe(40);
  });

  it.each([
    ['returns non-zero', failed()],
    ['returns no parseable rows', ok('Filesystem Inodes IUsed IFree IUse% Mounted on\n')],
  ])('keeps byte filesystem evidence and reports a stable inode gap when df -Pi %s', async (_case, inodeResult) => {
    const execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map((command) =>
      command === 'LC_ALL=C LANG=C df -Pi' ? inodeResult : successfulCommand(command)
    ));
    const { service } = createService(execCommands);

    const evidence = await service.collectHostEvidence(9, {
      databaseType: 'mysql', services: ['mysqld'], paths: [],
    });

    expect(evidence.filesystems.items).toEqual([expect.objectContaining({
      mount: '/', sizeBytes: 1000, usedBytes: 400, availableBytes: 600,
      usagePercent: 40, inodeTotal: null, inodeUsed: null,
      inodeAvailable: null, inodeUsagePercent: null,
    })]);
    expect(evidence.filesystems.quality).toBe('partial');
    expect(evidence.gaps).toContainEqual({
      section: 'filesystems', reason: 'FILESYSTEM_INODE_UNAVAILABLE',
    });
    expect(evidence.gaps).not.toContainEqual({
      section: 'filesystems', reason: 'FILESYSTEM_EVIDENCE_UNAVAILABLE',
    });
  });

  it.each([
    {
      name: 'service discovery fails',
      resultFor: (command: string) => command.includes('systemctl list-unit-files')
        ? failed() : successfulCommand(command),
    },
    {
      name: 'journal JSON is malformed',
      resultFor: (command: string) => command.includes('journalctl') && !command.includes('--dmesg')
        ? ok('{malformed-json\n') : successfulCommand(command),
    },
    {
      name: 'journal succeeds with zero entries',
      resultFor: successfulCommand,
    },
    {
      name: 'one journal query is unavailable',
      resultFor: (command: string) => command.includes('journalctl') && !command.includes('--dmesg')
        ? failed() : successfulCommand(command),
    },
  ])('does not read /var/log/messages when $name but journald is readable', async ({ resultFor }) => {
    const execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map(resultFor));
    const { service } = createService(execCommands);

    await service.collectHostEvidence(9, {
      databaseType: 'mysql', services: ['mysqld'], paths: [],
    });

    const commands = execCommands.mock.calls.flatMap((call) => call[1] as string[]);
    expect(commands.filter((command) => command.includes('journalctl'))).toHaveLength(2);
    expect(commands).not.toContain('LC_ALL=C LANG=C tail -n 200 -- /var/log/messages');
  });

  it('falls back to /var/log/messages only after every journald query is unavailable', async () => {
    const execCommands = vi.fn(async (_client: unknown, commands: string[]) => commands.map((command) => {
      if (command.includes('journalctl')) return failed();
      if (command === 'LC_ALL=C LANG=C tail -n 200 -- /var/log/messages') return ok('fallback line\n');
      return successfulCommand(command);
    }));
    const { service } = createService(execCommands);

    const evidence = await service.collectHostEvidence(9, {
      databaseType: 'mysql', services: ['mysqld'], paths: [],
    });

    const commands = execCommands.mock.calls.flatMap((call) => call[1] as string[]);
    const journalIndexes = commands
      .map((command, index) => command.includes('journalctl') ? index : -1)
      .filter((index) => index >= 0);
    const fallbackIndex = commands.indexOf('LC_ALL=C LANG=C tail -n 200 -- /var/log/messages');
    expect(journalIndexes).toHaveLength(2);
    expect(fallbackIndex).toBeGreaterThan(Math.max(...journalIndexes));
    expect(evidence.gaps).toContainEqual({ section: 'systemLogs', reason: 'JOURNAL_FALLBACK_MESSAGES' });
  });
});
