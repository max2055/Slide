import type { Client } from 'ssh2';
import type { HostEvidenceRequest } from './instance-diagnostic-context-service.js';
import { redactSensitiveText } from './security/log-redaction.js';
import { serverDatabaseService, type DecryptedCredentials, type ServerRow } from './server-database-service.js';
import serverMetricProvider from './server-metric-provider.js';
import sshSessionPool, { type ExecCommandOptions, type ExecCommandResult } from './ssh-session-pool.js';

export type EvidenceQuality = 'good' | 'partial' | 'unknown' | 'unsupported';

export interface EvidenceGap {
  section: 'metrics' | 'filesystems' | 'systemLogs' | 'physicalFiles';
  reason: string;
}

interface EvidenceSection {
  source: string[];
  collectedAt: string;
  quality: EvidenceQuality;
  reason?: string;
}

export interface FilesystemEvidence {
  mount: string;
  device: string;
  fsType: string | null;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  inodeTotal: number | null;
  inodeUsed: number | null;
  inodeAvailable: number | null;
  inodeUsagePercent: number | null;
}

export interface SystemLogEvidence {
  timestamp: string | null;
  severity: string;
  unit: string | null;
  identifier: string | null;
  pid: string | null;
  message: string;
}

export interface PhysicalFileEvidence {
  path: string;
  quality: EvidenceQuality;
  reason?: string;
  type?: string;
  sizeBytes?: number;
  allocatedBytes?: number;
  modifiedAt?: string;
  mode?: string;
  owner?: string;
  group?: string;
  filesystem?: FilesystemEvidence;
}

export interface LinuxHostEvidence extends Record<string, unknown> {
  schemaVersion: 1;
  serverId: number;
  collectedAt: string;
  expiresAt: string;
  quality: EvidenceQuality;
  truncated: boolean;
  metrics: EvidenceSection & { values: Record<string, number> };
  filesystems: EvidenceSection & { items: FilesystemEvidence[] };
  systemLogs: EvidenceSection & { entries: SystemLogEvidence[] };
  physicalFiles: EvidenceSection & { items: PhysicalFileEvidence[] };
  gaps: EvidenceGap[];
}

interface ServerDatabaseDependency {
  getServerById(id: number): Promise<ServerRow | null>;
  getDecryptedCredentials(id: number): Promise<DecryptedCredentials | null>;
}

interface SshPoolDependency {
  getConnection(
    host: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint?: string | null,
  ): Promise<Client>;
  execCommands(client: Client, commands: string[], options?: ExecCommandOptions): Promise<ExecCommandResult[]>;
  releaseConnection(client: Client): void;
  closeConnection(client: Client): void;
}

export interface LinuxHostEvidenceDependencies {
  serverDatabaseService: ServerDatabaseDependency;
  sshSessionPool: SshPoolDependency;
  now?: () => Date;
}

const MAX_FILESYSTEMS = 256;
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_BYTES = 4096;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_PHYSICAL_PATHS = 128;
const EVIDENCE_TTL_MS = 5 * 60 * 1000;
const POSIX_CONTROL = /[\x00-\x1f\x7f]/;
const FATAL_SSH_CODES = new Set([
  'SSH_COMMAND_TIMEOUT',
  'SSH_COMMAND_OUTPUT_LIMIT',
  'SSH_COMMAND_PROTOCOL_ERROR',
]);

export function decodeGnuPath(value: string): string {
  const replacements: Record<string, string> = {
    '040': ' ',
    '011': '\t',
    '012': '\n',
    '134': '\\',
  };
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => replacements[code]);
}

interface DfBytesRow {
  mount: string;
  device: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

interface DfInodeRow {
  mount: string;
  inodeTotal: number;
  inodeUsed: number;
  inodeAvailable: number;
  inodeUsagePercent: number;
}

function finiteInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseDfBytes(stdout: string): DfBytesRow[] {
  const rows: DfBytesRow[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1, MAX_FILESYSTEMS + 1)) {
    const match = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const values = match.slice(2, 6).map(finiteInteger);
    if (values.some((value) => value === null)) continue;
    rows.push({
      device: decodeGnuPath(match[1]),
      sizeBytes: values[0]!,
      usedBytes: values[1]!,
      availableBytes: values[2]!,
      usagePercent: values[3]!,
      mount: decodeGnuPath(match[6]),
    });
  }
  return rows;
}

function parseDfInodes(stdout: string): DfInodeRow[] {
  const rows: DfInodeRow[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1, MAX_FILESYSTEMS + 1)) {
    const match = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const values = match.slice(2, 6).map(finiteInteger);
    if (values.some((value) => value === null)) continue;
    rows.push({
      mount: decodeGnuPath(match[6]),
      inodeTotal: values[0]!,
      inodeUsed: values[1]!,
      inodeAvailable: values[2]!,
      inodeUsagePercent: values[3]!,
    });
  }
  return rows;
}

function parseFindmnt(stdout: string): Map<string, { device: string; fsType: string }> {
  const rows = new Map<string, { device: string; fsType: string }>();
  for (const line of stdout.split(/\r?\n/).slice(0, MAX_FILESYSTEMS)) {
    const match = /^(\S+)\s+(\S+)\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    rows.set(decodeGnuPath(match[2]), {
      device: decodeGnuPath(match[1]),
      fsType: match[3],
    });
  }
  return rows;
}

export function parseFilesystemEvidence(
  bytesOutput: string,
  inodeOutput: string,
  findmntOutput = '',
): FilesystemEvidence[] {
  const inodeByMount = new Map(parseDfInodes(inodeOutput).map((row) => [row.mount, row]));
  const findmntByMount = parseFindmnt(findmntOutput);
  return parseDfBytes(bytesOutput).map((row) => {
    const inode = inodeByMount.get(row.mount);
    const mounted = findmntByMount.get(row.mount);
    return {
      ...row,
      device: mounted?.device ?? row.device,
      fsType: mounted?.fsType ?? null,
      inodeTotal: inode?.inodeTotal ?? null,
      inodeUsed: inode?.inodeUsed ?? null,
      inodeAvailable: inode?.inodeAvailable ?? null,
      inodeUsagePercent: inode?.inodeUsagePercent ?? null,
    };
  });
}

const PRIORITY_NAMES: Record<string, string> = {
  '0': 'emergency', '1': 'alert', '2': 'critical', '3': 'error',
  '4': 'warning', '5': 'notice', '6': 'info', '7': 'debug',
};

function journalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{10,20}$/.test(value)) return null;
  const milliseconds = Number(BigInt(value) / 1000n);
  if (!Number.isFinite(milliseconds)) return null;
  const timestamp = new Date(milliseconds);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export function parseJournalJson(stdout: string): {
  entries: SystemLogEvidence[];
  malformedLines: number;
  truncated: boolean;
} {
  const bounded = Buffer.from(stdout).subarray(0, MAX_LOG_BYTES).toString('utf8');
  const allLines = bounded.split(/\r?\n/);
  const entries: SystemLogEvidence[] = [];
  let malformedLines = 0;
  for (const line of allLines.slice(0, MAX_LOG_LINES)) {
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES) {
      malformedLines++;
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformedLines++;
      continue;
    }
    if (typeof parsed.MESSAGE !== 'string') continue;
    const priority = typeof parsed.PRIORITY === 'string' ? parsed.PRIORITY : '';
    entries.push({
      timestamp: journalTimestamp(parsed.__REALTIME_TIMESTAMP),
      severity: PRIORITY_NAMES[priority] ?? 'unknown',
      unit: typeof parsed._SYSTEMD_UNIT === 'string' ? parsed._SYSTEMD_UNIT.slice(0, 256) : null,
      identifier: typeof parsed.SYSLOG_IDENTIFIER === 'string' ? parsed.SYSLOG_IDENTIFIER.slice(0, 256) : null,
      pid: typeof parsed._PID === 'string' ? parsed._PID.slice(0, 32) : null,
      message: redactSensitiveText(parsed.MESSAGE).slice(0, MAX_LOG_LINE_BYTES),
    });
  }
  return {
    entries,
    malformedLines,
    truncated: Buffer.byteLength(stdout) > MAX_LOG_BYTES || allLines.length > MAX_LOG_LINES,
  };
}

function normalizeUnit(unit: string): string {
  return unit.endsWith('.service') ? unit : `${unit}.service`;
}

function unitValidator(databaseType: string): RegExp | undefined {
  const validators: Record<string, RegExp> = {
    mysql: /^(?:mysqld|mariadb|mysql)(?:\.service)?$/,
    postgresql: /^postgresql(?:-[A-Za-z0-9_.@-]+)?(?:\.service)?$/,
    oracle: /^oracle[A-Za-z0-9_.@-]*(?:\.service)?$/,
    dameng: /^(?:DmService|dmserver)[A-Za-z0-9_.@-]*(?:\.service)?$/,
  };
  return validators[databaseType.toLowerCase().trim()];
}

export function resolveJournalUnits(databaseType: string, requestedUnits: string[]): string[] {
  if (requestedUnits.length > 16) throw new Error('HOST_LOG_UNIT_LIMIT');
  const validator = unitValidator(databaseType);
  const result: string[] = [];
  for (const unit of requestedUnits) {
    if (typeof unit !== 'string' || POSIX_CONTROL.test(unit) || /[;&|`$(){}<>\\/\s]/.test(unit)) {
      throw new Error('HOST_LOG_UNIT_INVALID');
    }
    if (!validator || !validator.test(unit)) throw new Error('HOST_LOG_UNIT_NOT_ALLOWED');
    const normalized = normalizeUnit(unit);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

export function discoverJournalUnits(databaseType: string, stdout: string): string[] {
  const validator = unitValidator(databaseType);
  if (!validator) return [];
  const result: string[] = [];
  const bounded = Buffer.from(stdout).subarray(0, 32 * 1024).toString('utf8');
  for (const line of bounded.split(/\r?\n/).slice(0, 256)) {
    const unit = line.trim().split(/\s+/, 1)[0];
    if (!unit || POSIX_CONTROL.test(unit) || !validator.test(unit)) continue;
    const normalized = normalizeUnit(unit);
    if (!result.includes(normalized)) result.push(normalized);
    if (result.length === 16) break;
  }
  return result;
}

export function validatePhysicalPaths(paths: string[]): {
  paths: string[];
  rejected: Array<{ index: number; reason: string }>;
  truncated: boolean;
} {
  const accepted: string[] = [];
  const seen = new Set<string>();
  const rejected: Array<{ index: number; reason: string }> = [];
  let truncated = false;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (typeof path !== 'string' || !path.startsWith('/')) {
      rejected.push({ index, reason: 'PHYSICAL_PATH_NOT_POSIX' });
      continue;
    }
    if (Buffer.byteLength(path) > 4096 || POSIX_CONTROL.test(path) || path.split('/').includes('..')) {
      rejected.push({ index, reason: 'PHYSICAL_PATH_INVALID' });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (accepted.length === MAX_PHYSICAL_PATHS) {
      truncated = true;
      continue;
    }
    accepted.push(path);
  }
  return { paths: accepted, rejected, truncated };
}

const PHYSICAL_FILE_SCRIPT = [
  'p=$(printf "%s" "$1" | base64 -d) || exit 64',
  '[ -e "$p" ] || exit 44',
  '[ -r "$p" ] || exit 45',
  'stat -Lc "STAT|%F|%s|%b|%B|%Y|%a|%U|%G" -- "$p" || exit 46',
  'printf "DF_BYTES\\n"',
  'df -P -B1 -- "$p" || exit 47',
  'printf "DF_INODES\\n"',
  'df -Pi -- "$p" || exit 48',
].join('; ');

export function buildPhysicalFileCommand(path: string): string {
  const encoded = Buffer.from(path, 'utf8').toString('base64');
  return `LC_ALL=C LANG=C sh -c '${PHYSICAL_FILE_SCRIPT}' sh '${encoded}'`;
}

export function parsePhysicalFileOutput(path: string, stdout: string): PhysicalFileEvidence | null {
  const bytesMarker = stdout.indexOf('\nDF_BYTES\n');
  const inodeMarker = stdout.indexOf('\nDF_INODES\n');
  if (bytesMarker < 0 || inodeMarker < bytesMarker) return null;
  const stat = stdout.slice(0, bytesMarker).split('|');
  if (stat.length !== 9 || stat[0] !== 'STAT') return null;
  const sizeBytes = finiteInteger(stat[2]);
  const blocks = finiteInteger(stat[3]);
  const blockSize = finiteInteger(stat[4]);
  const modifiedSeconds = finiteInteger(stat[5]);
  if (sizeBytes === null || blocks === null || blockSize === null || modifiedSeconds === null) return null;
  const modifiedAt = new Date(modifiedSeconds * 1000);
  if (Number.isNaN(modifiedAt.getTime())) return null;
  const filesystems = parseFilesystemEvidence(
    stdout.slice(bytesMarker + '\nDF_BYTES\n'.length, inodeMarker),
    stdout.slice(inodeMarker + '\nDF_INODES\n'.length),
  );
  return {
    path,
    quality: filesystems.length > 0 ? 'good' : 'partial',
    ...(filesystems.length === 0 ? { reason: 'PHYSICAL_FILESYSTEM_UNKNOWN' } : {}),
    type: stat[1],
    sizeBytes,
    allocatedBytes: blocks * blockSize,
    modifiedAt: modifiedAt.toISOString(),
    mode: stat[6],
    owner: stat[7],
    group: stat[8],
    filesystem: filesystems[0],
  };
}

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'SSH_COMMAND_FAILED';
}

function sectionQuality(hasData: boolean, hasGap: boolean): EvidenceQuality {
  if (!hasData) return 'unknown';
  return hasGap ? 'partial' : 'good';
}

function buildJournalCommand(units: string[], sinceEpoch: number, untilEpoch: number, dmesg: boolean): string {
  const filters = units.map((unit) => `--unit=${unit}`).join(' ');
  return [
    'LC_ALL=C LANG=C journalctl', '--no-pager', '--quiet', '--output=json',
    `--since=@${sinceEpoch}`, `--until=@${untilEpoch}`, '--priority=warning',
    '--lines=200', dmesg ? '--dmesg' : filters,
  ].filter(Boolean).join(' ');
}

export class LinuxHostEvidenceService {
  private readonly dependencies: Required<LinuxHostEvidenceDependencies>;

  constructor(dependencies: LinuxHostEvidenceDependencies = {
    serverDatabaseService,
    sshSessionPool,
  }) {
    this.dependencies = {
      ...dependencies,
      now: dependencies.now ?? (() => new Date()),
    };
  }

  async collectHostEvidence(serverId: number, request: HostEvidenceRequest): Promise<LinuxHostEvidence> {
    if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new Error('SERVER_ID_INVALID');
    const journalUnits = resolveJournalUnits(request.databaseType, request.services);
    const validatedPaths = validatePhysicalPaths(request.paths);
    const server = await this.dependencies.serverDatabaseService.getServerById(serverId);
    if (!server) throw new Error('SERVER_NOT_FOUND');
    const credentials = await this.dependencies.serverDatabaseService.getDecryptedCredentials(serverId);
    if (!credentials) throw new Error('SERVER_CREDENTIALS_UNAVAILABLE');
    const credentialValue = server.credential_type === 'password'
      ? credentials.password
      : credentials.privateKey;
    if (!credentialValue) throw new Error('SERVER_CREDENTIALS_UNAVAILABLE');

    const client = await this.dependencies.sshSessionPool.getConnection(
      server.host,
      server.port,
      credentials.username,
      server.credential_type,
      credentialValue,
      server.host_key_fingerprint,
    );
    let connectionFatal = false;
    try {
      const osResult = (await this.dependencies.sshSessionPool.execCommands(
        client,
        ['LC_ALL=C LANG=C uname -s'],
      ))[0];
      if (osResult.exitCode !== 0 || osResult.stdout.trim() !== 'Linux') {
        throw new Error('HOST_OS_UNSUPPORTED');
      }

      const now = this.dependencies.now();
      const collectedAt = now.toISOString();
      const gaps: EvidenceGap[] = [];
      let discoveryGap = false;
      let effectiveJournalUnits = journalUnits;
      if (unitValidator(request.databaseType)) {
        const discovery = (await this.dependencies.sshSessionPool.execCommands(
          client,
          ['LC_ALL=C LANG=C systemctl list-unit-files --type=service --no-legend --no-pager'],
          { maxOutputBytes: 32 * 1024 },
        ))[0];
        if (discovery.exitCode === 0) {
          effectiveJournalUnits = [...new Set([
            ...journalUnits,
            ...discoverJournalUnits(request.databaseType, discovery.stdout),
          ])].slice(0, 16);
        } else {
          discoveryGap = true;
          gaps.push({ section: 'systemLogs', reason: 'SERVICE_DISCOVERY_UNAVAILABLE' });
        }
      }
      let truncated = validatedPaths.truncated;
      if (validatedPaths.rejected.length > 0) gaps.push({ section: 'physicalFiles', reason: 'PHYSICAL_PATH_REJECTED' });
      if (validatedPaths.truncated) gaps.push({ section: 'physicalFiles', reason: 'PHYSICAL_PATH_LIMIT' });

      const metricValues: Record<string, number> = {};
      const metricDefinitions = serverMetricProvider.getDefinitions('linux')
        .filter((definition) => definition.name !== 'disk_usage' && definition.name !== 'disk_detail');
      let metricGap = false;
      for (const definition of metricDefinitions) {
        const result = (await this.dependencies.sshSessionPool.execCommands(client, [definition.command]))[0];
        if (result.exitCode !== 0) {
          metricGap = true;
          gaps.push({ section: 'metrics', reason: 'METRIC_COMMAND_FAILED' });
          continue;
        }
        const value = definition.parse(result.stdout.trim());
        if (value === null) {
          metricGap = true;
          gaps.push({ section: 'metrics', reason: 'METRIC_PARSE_FAILED' });
        } else {
          metricValues[definition.name] = value;
        }
      }

      const dfBytes = (await this.dependencies.sshSessionPool.execCommands(
        client, ['LC_ALL=C LANG=C df -P -B1'],
      ))[0];
      const dfInodes = (await this.dependencies.sshSessionPool.execCommands(
        client, ['LC_ALL=C LANG=C df -Pi'],
      ))[0];
      let findmntOutput = '';
      let filesystemGap = dfBytes.exitCode !== 0 || dfInodes.exitCode !== 0;
      const findmnt = (await this.dependencies.sshSessionPool.execCommands(
        client, ['LC_ALL=C LANG=C findmnt -rn -o SOURCE,TARGET,FSTYPE'],
      ))[0];
      if (findmnt.exitCode === 0) findmntOutput = findmnt.stdout;
      else {
        filesystemGap = true;
        gaps.push({ section: 'filesystems', reason: 'FINDMNT_UNAVAILABLE' });
      }
      const filesystems = filesystemGap && (dfBytes.exitCode !== 0 || dfInodes.exitCode !== 0)
        ? []
        : parseFilesystemEvidence(dfBytes.stdout, dfInodes.stdout, findmntOutput).slice(0, MAX_FILESYSTEMS);
      if (filesystems.length === MAX_FILESYSTEMS) {
        truncated = true;
        gaps.push({ section: 'filesystems', reason: 'FILESYSTEM_LIMIT' });
      }
      if (filesystems.length === 0) {
        filesystemGap = true;
        gaps.push({ section: 'filesystems', reason: 'FILESYSTEM_EVIDENCE_UNAVAILABLE' });
      }

      const untilEpoch = Math.floor(now.getTime() / 1000);
      const sinceEpoch = untilEpoch - 60 * 60;
      const logEntries: SystemLogEvidence[] = [];
      let logEvidenceBytes = 0;
      let logGap = discoveryGap;
      for (const command of [
        ...(effectiveJournalUnits.length > 0 ? [buildJournalCommand(effectiveJournalUnits, sinceEpoch, untilEpoch, false)] : []),
        buildJournalCommand([], sinceEpoch, untilEpoch, true),
      ]) {
        const result = (await this.dependencies.sshSessionPool.execCommands(
          client, [command], { maxOutputBytes: MAX_LOG_BYTES },
        ))[0];
        if (result.exitCode !== 0) {
          logGap = true;
          continue;
        }
        const parsed = parseJournalJson(result.stdout);
        for (const entry of parsed.entries) {
          const entryBytes = Buffer.byteLength(JSON.stringify(entry));
          if (logEntries.length === MAX_LOG_LINES || logEvidenceBytes + entryBytes > MAX_LOG_BYTES) {
            truncated = true;
            break;
          }
          logEntries.push(entry);
          logEvidenceBytes += entryBytes;
        }
        if (parsed.malformedLines > 0) {
          logGap = true;
          gaps.push({ section: 'systemLogs', reason: 'JOURNAL_JSON_MALFORMED' });
        }
        if (parsed.truncated) truncated = true;
      }
      if (logGap && logEntries.length === 0) {
        const fallback = (await this.dependencies.sshSessionPool.execCommands(
          client, ['LC_ALL=C LANG=C tail -n 200 -- /var/log/messages'], { maxOutputBytes: MAX_LOG_BYTES },
        ))[0];
        if (fallback.exitCode === 0) {
          for (const line of fallback.stdout.split(/\r?\n/).slice(-MAX_LOG_LINES)) {
            if (!line) continue;
            const entry = {
              timestamp: null, severity: 'unknown', unit: null, identifier: null, pid: null,
              message: redactSensitiveText(Buffer.from(line).subarray(0, MAX_LOG_LINE_BYTES).toString('utf8')),
            };
            const entryBytes = Buffer.byteLength(JSON.stringify(entry));
            if (logEvidenceBytes + entryBytes > MAX_LOG_BYTES) {
              truncated = true;
              break;
            }
            logEntries.push(entry);
            logEvidenceBytes += entryBytes;
          }
          gaps.push({ section: 'systemLogs', reason: 'JOURNAL_FALLBACK_MESSAGES' });
        } else {
          gaps.push({ section: 'systemLogs', reason: 'SYSTEM_LOGS_UNAVAILABLE' });
        }
      }
      if (logGap && logEntries.length > 0 && !gaps.some((gap) => gap.section === 'systemLogs')) {
        gaps.push({ section: 'systemLogs', reason: 'SYSTEM_LOG_SOURCE_PARTIAL' });
      }

      const physicalFiles: PhysicalFileEvidence[] = [];
      let physicalGap = validatedPaths.rejected.length > 0 || validatedPaths.truncated;
      for (const path of validatedPaths.paths) {
        try {
          const result = (await this.dependencies.sshSessionPool.execCommands(
            client, [buildPhysicalFileCommand(path)], { maxOutputBytes: 32 * 1024 },
          ))[0];
          if (result.exitCode !== 0) {
            physicalGap = true;
            const reason = result.exitCode === 44
              ? 'PHYSICAL_FILE_MISSING'
              : result.exitCode === 45 ? 'PHYSICAL_FILE_PERMISSION_DENIED' : 'PHYSICAL_FILE_UNAVAILABLE';
            physicalFiles.push({ path, quality: 'unknown', reason });
            continue;
          }
          const parsed = parsePhysicalFileOutput(path, result.stdout);
          if (!parsed) {
            physicalGap = true;
            physicalFiles.push({ path, quality: 'unknown', reason: 'PHYSICAL_FILE_PARSE_FAILED' });
          } else {
            physicalFiles.push(parsed);
            if (parsed.quality !== 'good') physicalGap = true;
          }
        } catch (error) {
          const code = stableErrorCode(error);
          physicalGap = true;
          physicalFiles.push({
            path,
            quality: 'unknown',
            reason: code === 'SSH_COMMAND_TIMEOUT' ? 'PHYSICAL_FILE_TIMEOUT' : 'PHYSICAL_FILE_COLLECTION_FAILED',
          });
          if (FATAL_SSH_CODES.has(code)) {
            connectionFatal = true;
            gaps.push({ section: 'physicalFiles', reason: code });
            break;
          }
        }
      }

      const quality = gaps.length === 0 && !metricGap && !filesystemGap && !logGap && !physicalGap
        ? 'good'
        : Object.keys(metricValues).length > 0 || filesystems.length > 0 || logEntries.length > 0 || physicalFiles.length > 0
          ? 'partial'
          : 'unknown';

      return {
        schemaVersion: 1,
        serverId,
        collectedAt,
        expiresAt: new Date(now.getTime() + EVIDENCE_TTL_MS).toISOString(),
        quality,
        truncated,
        metrics: {
          source: ['procfs', 'top', 'free'], collectedAt,
          quality: sectionQuality(Object.keys(metricValues).length > 0, metricGap),
          ...(Object.keys(metricValues).length === 0 ? { reason: 'METRICS_UNAVAILABLE' } : {}),
          values: metricValues,
        },
        filesystems: {
          source: ['df', 'findmnt'], collectedAt,
          quality: sectionQuality(filesystems.length > 0, filesystemGap),
          ...(filesystems.length === 0 ? { reason: 'FILESYSTEM_EVIDENCE_UNAVAILABLE' } : {}),
          items: filesystems,
        },
        systemLogs: {
          source: ['journald', 'messages'], collectedAt,
          quality: logGap ? sectionQuality(logEntries.length > 0, true) : 'good',
          ...(logGap && logEntries.length === 0 ? { reason: 'SYSTEM_LOGS_UNAVAILABLE' } : {}),
          entries: logEntries.slice(0, MAX_LOG_LINES),
        },
        physicalFiles: {
          source: ['stat', 'df'], collectedAt,
          quality: validatedPaths.paths.length === 0 && !physicalGap
            ? 'good'
            : sectionQuality(physicalFiles.some((file) => file.quality !== 'unknown'), physicalGap),
          ...(physicalGap && physicalFiles.length === 0 ? { reason: 'PHYSICAL_FILES_UNAVAILABLE' } : {}),
          items: physicalFiles,
        },
        gaps,
      };
    } catch (error) {
      const code = stableErrorCode(error);
      if (FATAL_SSH_CODES.has(code)) connectionFatal = true;
      throw error;
    } finally {
      if (connectionFatal) this.dependencies.sshSessionPool.closeConnection(client);
      else this.dependencies.sshSessionPool.releaseConnection(client);
    }
  }
}

export const linuxHostEvidenceService = new LinuxHostEvidenceService();
export default linuxHostEvidenceService;
