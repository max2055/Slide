import type { ToolResult } from '../tools/types.js';
import { authorizeDatabaseScanTarget, type DatabaseScanRequest } from './database-network-scan-policy.js';
import { agentSandboxConfigService } from './agent-sandbox-config-service.js';
import { agentExecutionConfigService } from './agent-execution-config-service.js';
import { sandboxClient } from './sandbox-client.js';

interface SandboxScanClient {
  configured(): boolean;
  status(signal?: AbortSignal): Promise<unknown>;
  scanDatabaseEndpoints(request: DatabaseScanRequest, signal?: AbortSignal): Promise<unknown>;
}

interface SandboxConfigReader { get(): Promise<{ enabled: boolean; reasonCode: string }> }
interface ExecutionConfigReader { get(): Promise<{ restrictedNetworkEnabled: boolean; reasonCode: string }> }

interface ScanResult {
  jobId: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
}

function failure(errorCode: string): ToolResult<Record<string, unknown>> {
  return { success: false, errorCode, error: 'Database network scan denied' };
}

function parseEndpoints(stdout: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^Host:\s+(\S+).*?Ports:\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    for (const entry of match[2].split(/,\s*/)) {
      const fields = entry.split('/');
      const port = Number(fields[0]);
      if (!Number.isInteger(port) || fields[1] !== 'open') continue;
      results.push({
        host: match[1],
        port,
        databaseType: fields[4] || 'unknown',
        state: 'open',
      });
    }
  }
  return results;
}

function validScanResult(value: unknown): value is ScanResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.jobId === 'string'
    && (typeof result.exitCode === 'number' || result.exitCode === null)
    && typeof result.timedOut === 'boolean'
    && typeof result.outputTruncated === 'boolean'
    && typeof result.stdout === 'string'
    && typeof result.stderr === 'string';
}

export class DatabaseNetworkScanService {
  constructor(
    private readonly sandboxConfig: SandboxConfigReader,
    private readonly sandbox: SandboxScanClient,
    private readonly executionConfig: ExecutionConfigReader,
    private readonly policyOptions: { allowedCidrs?: readonly string[]; production?: boolean } = {},
  ) {}

  async scan(input: DatabaseScanRequest): Promise<ToolResult<Record<string, unknown>>> {
    const target = (() => {
      try { return authorizeDatabaseScanTarget(input, this.policyOptions); } catch (error) {
        return error instanceof Error ? error : new Error('SCAN_INPUT_INVALID');
      }
    })();
    if (target instanceof Error) return failure(target.message);

    const sandboxState = await this.sandboxConfig.get();
    if (!sandboxState.enabled) return failure(sandboxState.reasonCode);
    const executionState = await this.executionConfig.get();
    if (!executionState.restrictedNetworkEnabled) return failure('SANDBOX_NETWORK_DISABLED');
    if (!this.sandbox.configured()) return failure('SANDBOX_UNAVAILABLE');

    try {
      const status = await this.sandbox.status(AbortSignal.timeout(4000)) as Record<string, any>;
      if (status?.status !== 'ok' || status.daemon?.reachable !== true || status.daemon?.rootless !== true
        || status.policy?.network !== 'restricted') return failure('SANDBOX_NETWORK_NOT_READY');
      const result = await this.sandbox.scanDatabaseEndpoints(
        { cidr: target.cidr, profile: target.profile },
        AbortSignal.timeout(125_000),
      );
      if (!validScanResult(result)) return failure('NETWORK_SCAN_FAILED');
      if (result.timedOut) return failure('NETWORK_SCAN_TIMEOUT');
      if (result.exitCode !== 0) return failure('NETWORK_SCAN_FAILED');
      const endpoints = parseEndpoints(result.stdout);
      return {
        success: true,
        data: {
          scanId: result.jobId,
          status: 'completed',
          cidr: target.cidr,
          profile: target.profile,
          hostsWithOpenPorts: new Set(endpoints.map((entry) => entry.host)).size,
          openPorts: endpoints.length,
          results: endpoints,
          outputTruncated: result.outputTruncated,
        },
      };
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return failure('NETWORK_SCAN_TIMEOUT');
      return failure('SANDBOX_UNAVAILABLE');
    }
  }
}

export const databaseNetworkScanService = new DatabaseNetworkScanService(
  agentSandboxConfigService,
  sandboxClient,
  agentExecutionConfigService,
);
