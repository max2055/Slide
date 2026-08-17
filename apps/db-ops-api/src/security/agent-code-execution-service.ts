import type { ToolResult } from '../tools/types.js';
import { agentSandboxConfigService } from './agent-sandbox-config-service.js';
import { sandboxClient, type SandboxExecutionRequest } from './sandbox-client.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_FILES = 64;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export type AgentCodeRuntime = 'shell' | 'python' | 'node';

export interface AgentCodeExecutionInput {
  runtime: string;
  code: string;
  files?: Array<{ path: string; content: string }>;
  timeoutMs?: number;
}

interface ConfigReader {
  get(): Promise<{ enabled: boolean; reasonCode: string }>;
}

interface SandboxExecutor {
  configured(): boolean;
  status(signal?: AbortSignal): Promise<unknown>;
  execute(request: SandboxExecutionRequest, signal?: AbortSignal): Promise<unknown>;
}

const runtimeCommand: Record<AgentCodeRuntime, { file: string; command: string[] }> = {
  shell: { file: 'main.sh', command: ['sh', 'main.sh'] },
  python: { file: 'main.py', command: ['python3', 'main.py'] },
  node: { file: 'main.mjs', command: ['node', 'main.mjs'] },
};

function validRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 240
    && !value.includes('\0')
    && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function readyForRuntime(status: unknown, runtime: AgentCodeRuntime): boolean {
  if (!status || typeof status !== 'object') return false;
  const value = status as Record<string, any>;
  return value.status === 'ok'
    && value.daemon?.reachable === true
    && value.daemon?.rootless === true
    && Array.isArray(value.policy?.runtimes)
    && value.policy.runtimes.includes(runtime);
}

function validResult(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.jobId === 'string'
    && (typeof result.exitCode === 'number' || result.exitCode === null)
    && typeof result.timedOut === 'boolean'
    && typeof result.stdout === 'string'
    && typeof result.stderr === 'string'
    && typeof result.outputTruncated === 'boolean';
}

function failure(errorCode: string): ToolResult<Record<string, unknown>> {
  return { success: false, errorCode, error: 'Sandbox code execution denied' };
}

export class AgentCodeExecutionService {
  constructor(
    private readonly config: ConfigReader = agentSandboxConfigService,
    private readonly sandbox: SandboxExecutor = sandboxClient,
  ) {}

  async execute(input: AgentCodeExecutionInput): Promise<ToolResult<Record<string, unknown>>> {
    const state = await this.config.get();
    if (!state.enabled) return failure(state.reasonCode);

    if (!input || !Object.hasOwn(runtimeCommand, input.runtime) || typeof input.code !== 'string') {
      return failure('SANDBOX_RUNTIME_UNAVAILABLE');
    }
    const runtime = input.runtime as AgentCodeRuntime;
    const runtimeSpec = runtimeCommand[runtime];
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS
      || !Array.isArray(input.files ?? []) || (input.files?.length ?? 0) > MAX_FILES) {
      return failure('SANDBOX_INPUT_INVALID');
    }

    const sourceBytes = Buffer.byteLength(input.code, 'utf8');
    let totalBytes = sourceBytes;
    const paths = new Set([runtimeSpec.file]);
    const supportingFiles: Array<{ path: string; contentBase64: string }> = [];
    for (const file of input.files ?? []) {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string'
        || !validRelativePath(file.path) || paths.has(file.path)) {
        return failure('SANDBOX_INPUT_INVALID');
      }
      paths.add(file.path);
      totalBytes += Buffer.byteLength(file.content, 'utf8');
      supportingFiles.push({ path: file.path, contentBase64: Buffer.from(file.content, 'utf8').toString('base64') });
    }
    if (sourceBytes === 0 || totalBytes > MAX_INPUT_BYTES) return failure('SANDBOX_INPUT_INVALID');
    if (!this.sandbox.configured()) return failure('SANDBOX_UNAVAILABLE');

    try {
      const status = await this.sandbox.status(AbortSignal.timeout(4000));
      if (!readyForRuntime(status, runtime)) return failure('SANDBOX_UNAVAILABLE');
      const request: SandboxExecutionRequest = {
        runtime,
        command: runtimeSpec.command,
        files: [
          { path: runtimeSpec.file, contentBase64: Buffer.from(input.code, 'utf8').toString('base64') },
          ...supportingFiles,
        ],
        timeoutMs,
      };
      const result = await this.sandbox.execute(request, AbortSignal.timeout(timeoutMs + 5000));
      if (!validResult(result)) return failure('SANDBOX_EXECUTION_FAILED');
      return { success: true, data: result };
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return failure('SANDBOX_TIMEOUT');
      }
      return failure('SANDBOX_UNAVAILABLE');
    }
  }
}

export const agentCodeExecutionService = new AgentCodeExecutionService();
