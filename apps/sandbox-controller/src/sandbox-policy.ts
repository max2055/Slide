import path from 'node:path';

export interface SandboxJob {
  runtime: string;
  command: string[];
  networkMode?: 'restricted';
  /** Logical server-selected profile; callers never provide an image digest. */
  executionProfile?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  outputBytes: number;
  maxFilesBytes: number;
  timeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  memoryMb: 256,
  cpus: 0.5,
  pids: 64,
  outputBytes: 1024 * 1024,
  maxFilesBytes: 1024 * 1024,
  timeoutMs: 60_000,
});

export function parseImageAllowlist(raw = process.env.SANDBOX_IMAGES || '{}'): Readonly<Record<string, string>> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [runtime, image] of Object.entries(parsed)) {
    if (typeof image !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(image) || !/^[a-z0-9][a-z0-9._-]*$/.test(runtime)) {
      throw new Error('SANDBOX_IMAGE_ALLOWLIST_INVALID');
    }
    result[runtime] = image;
  }
  return Object.freeze(result);
}

export function parseExecutionProfiles(raw = process.env.SANDBOX_EXECUTION_PROFILES || '{}'): Readonly<Record<string, string>> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('SANDBOX_EXECUTION_PROFILES_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SANDBOX_EXECUTION_PROFILES_INVALID');
  const result: Record<string, string> = {};
  for (const [profile, image] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(profile) || typeof image !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error('SANDBOX_EXECUTION_PROFILES_INVALID');
    }
    result[profile] = image;
  }
  return Object.freeze(result);
}

export function validateWorkspacePath(root: string, jobId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('SANDBOX_JOB_ID_INVALID');
  const workspace = path.resolve(root, jobId);
  const relative = path.relative(path.resolve(root), workspace);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SANDBOX_WORKSPACE_INVALID');
  return workspace;
}

export function validateRelativeFilePath(filePath: string): string {
  if (!filePath || filePath.length > 240 || filePath.includes('\0') || path.isAbsolute(filePath)) {
    throw new Error('SANDBOX_FILE_PATH_INVALID');
  }
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('SANDBOX_FILE_PATH_INVALID');
  return normalized;
}

export function buildDockerRunArgs(input: {
  jobId: string;
  workspace: string;
  job: SandboxJob;
  images: Readonly<Record<string, string>>;
  executionProfiles?: Readonly<Record<string, string>>;
  restrictedNetwork?: string;
  networkImage?: string;
  limits?: SandboxLimits;
}): string[] {
  const limits = input.limits ?? DEFAULT_SANDBOX_LIMITS;
  const networkJob = input.job.networkMode === 'restricted';
  const profileImage = input.job.executionProfile ? input.executionProfiles?.[input.job.executionProfile] : undefined;
  if (input.job.executionProfile && !networkJob) throw new Error('SANDBOX_PROFILE_NETWORK_REQUIRED');
  const image = networkJob ? (profileImage ?? input.networkImage) : input.images[input.job.runtime];
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(networkJob ? 'SANDBOX_NETWORK_UNAVAILABLE' : 'SANDBOX_RUNTIME_DENIED');
  }
  if (!Array.isArray(input.job.command) || input.job.command.length === 0 || input.job.command.length > 64
    || input.job.command.some((part) => typeof part !== 'string' || !part || part.length > 4096)) {
    throw new Error('SANDBOX_COMMAND_INVALID');
  }

  const network = networkJob
    ? input.restrictedNetwork
    : 'none';
  if (!network || !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(network)) throw new Error('SANDBOX_NETWORK_UNAVAILABLE');

  const args = [
    'run', '--rm', '--name', `slide-sandbox-${input.jobId}`,
    '--label', 'com.slide.sandbox=true',
    '--network', network,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true',
    '--pids-limit', String(limits.pids),
    '--memory', `${limits.memoryMb}m`,
    '--memory-swap', `${limits.memoryMb}m`,
    '--cpus', String(limits.cpus),
    '--user', '65532:65532',
    '--ulimit', 'nofile=128:128',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
    '--mount', `type=bind,src=${input.workspace},dst=/workspace`,
    '--workdir', '/workspace',
  ];
  const environment = input.job.env ?? {};
  if (typeof environment !== 'object' || Array.isArray(environment) || Object.keys(environment).length > 64) {
    throw new Error('SANDBOX_ENV_INVALID');
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 4096) {
      throw new Error('SANDBOX_ENV_INVALID');
    }
    args.push('--env', `${key}=${value}`);
  }
  args.push(image, ...input.job.command);
  return args;
}
