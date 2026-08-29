import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { authenticateRequest } from './request-auth.js';
import { SandboxJobHistory } from './job-history.js';
import { JobConcurrencyLimiter } from './job-concurrency.js';
import {
  buildDockerRunArgs,
  DEFAULT_SANDBOX_LIMITS,
  parseExecutionProfiles,
  parseImageAllowlist,
  validateRelativeFilePath,
  validateWorkspacePath,
  type SandboxJob,
} from './sandbox-policy.js';
import { buildDatabaseScanJob, parseDatabaseScanRequest } from './network-scan.js';

interface JobRequest extends SandboxJob {
  files?: Array<{ path: string; contentBase64: string }>;
}

const port = Number(process.env.SANDBOX_CONTROLLER_PORT || 3010);
const secret = process.env.SANDBOX_CONTROLLER_SECRET || '';
const configuredWorkspaceRoot = process.env.SANDBOX_WORKSPACE_ROOT || '/var/lib/slide-sandbox';
if (!path.isAbsolute(configuredWorkspaceRoot) || configuredWorkspaceRoot === '/') {
  throw new Error('SANDBOX_WORKSPACE_ROOT must be a dedicated absolute path');
}
const workspaceRoot = path.resolve(configuredWorkspaceRoot);
const images = parseImageAllowlist();
const executionProfiles = parseExecutionProfiles();
const restrictedNetwork = process.env.SANDBOX_RESTRICTED_NETWORK || '';
const networkImage = process.env.SANDBOX_NETWORK_IMAGE || '';
const maxBodyBytes = 2 * 1024 * 1024;
const maxConcurrentJobs = Math.min(Math.max(Number(process.env.SANDBOX_MAX_CONCURRENT_JOBS || 4), 1), 32);
const concurrencyLimiter = new JobConcurrencyLimiter(maxConcurrentJobs);
const jobHistory = new SandboxJobHistory(50);
const execFile = promisify(execFileCallback);
let daemonStatusCache: { checkedAt: number; reachable: boolean; rootless: boolean } | undefined;

if (secret.length < 32) throw new Error('SANDBOX_CONTROLLER_SECRET must be at least 32 characters');
if (Object.keys(images).length === 0) throw new Error('SANDBOX_IMAGES must contain at least one digest-pinned image');
await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
const workspaceStat = await fs.lstat(workspaceRoot);
if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() || await fs.realpath(workspaceRoot) !== workspaceRoot) {
  throw new Error('SANDBOX_WORKSPACE_ROOT must be a real directory');
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBodyBytes) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function prepareWorkspace(jobId: string, files: JobRequest['files']): Promise<string> {
  if (files !== undefined && (!Array.isArray(files) || files.length > 128)) {
    throw new Error('SANDBOX_FILES_INVALID');
  }
  const workspace = validateWorkspacePath(workspaceRoot, jobId);
  await fs.mkdir(workspace, { recursive: false, mode: 0o700 });
  let total = 0;
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.contentBase64 !== 'string'
      || file.contentBase64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) {
      throw new Error('SANDBOX_FILE_CONTENT_INVALID');
    }
    const relative = validateRelativeFilePath(file.path);
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.toString('base64') !== file.contentBase64) throw new Error('SANDBOX_FILE_CONTENT_INVALID');
    total += content.length;
    if (total > DEFAULT_SANDBOX_LIMITS.maxFilesBytes) throw new Error('SANDBOX_FILES_TOO_LARGE');
    const target = path.join(workspace, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await fs.writeFile(target, content, { flag: 'wx', mode: 0o644 });
  }
  await fs.chmod(workspace, 0o777);
  return workspace;
}

async function runDocker(jobId: string, workspace: string, job: JobRequest): Promise<unknown> {
  const args = buildDockerRunArgs({ jobId, workspace, job, images, executionProfiles, restrictedNetwork, networkImage });
  const timeoutMs = Math.min(Math.max(Number(job.timeoutMs || DEFAULT_SANDBOX_LIMITS.timeoutMs), 1000), 120_000);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const append = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = DEFAULT_SANDBOX_LIMITS.outputBytes - current;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return current + chunk.length;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes); });
    let timedOut = false;
    let timeoutCleanup: Promise<void> | undefined;
    const removeContainer = () => new Promise<void>((done) => {
      const cleanup = spawn('docker', ['rm', '-f', `slide-sandbox-${jobId}`], { stdio: 'ignore' });
      cleanup.once('error', () => done());
      cleanup.once('close', () => done());
    });
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutCleanup = removeContainer();
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await timeoutCleanup;
      resolve({
        exitCode: code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        outputTruncated: stdoutBytes > DEFAULT_SANDBOX_LIMITS.outputBytes || stderrBytes > DEFAULT_SANDBOX_LIMITS.outputBytes,
      });
    });
  });
}

async function dockerDaemonStatus(): Promise<{ checkedAt: string; reachable: boolean; rootless: boolean }> {
  const now = Date.now();
  if (!daemonStatusCache || now - daemonStatusCache.checkedAt > 30_000) {
    try {
      const { stdout } = await execFile('docker', ['info', '--format', '{{json .SecurityOptions}}'], { timeout: 3000 });
      const options = JSON.parse(stdout) as unknown;
      daemonStatusCache = {
        checkedAt: now,
        reachable: true,
        rootless: Array.isArray(options) && options.some((entry) => String(entry).toLowerCase().includes('rootless')),
      };
    } catch {
      daemonStatusCache = { checkedAt: now, reachable: false, rootless: false };
    }
  }
  return { ...daemonStatusCache, checkedAt: new Date(daemonStatusCache.checkedAt).toISOString() };
}

async function restrictedNetworkAvailable(): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(restrictedNetwork)) return false;
  try {
    await execFile('docker', ['network', 'inspect', restrictedNetwork], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'ok', activeJobs: concurrencyLimiter.active });
  if (request.method === 'GET' && request.url === '/v1/status') {
    const body = Buffer.alloc(0);
    const authenticated = authenticateRequest({
      secret,
      timestamp: request.headers['x-slide-timestamp'] as string | undefined,
      nonce: request.headers['x-slide-nonce'] as string | undefined,
      signature: request.headers['x-slide-signature'] as string | undefined,
      body,
    });
    if (!authenticated) return send(response, 401, { error: 'Unauthorized' });
    const restrictedNetworkReady = await restrictedNetworkAvailable();
    return send(response, 200, {
      status: 'ok',
      activeJobs: concurrencyLimiter.active,
      maxConcurrentJobs,
      daemon: await dockerDaemonStatus(),
      policy: {
        network: restrictedNetworkReady && (/@sha256:[a-f0-9]{64}$/.test(networkImage) || Object.keys(executionProfiles).length > 0) ? 'restricted' : 'none',
        restrictedNetworkConfigured: restrictedNetworkReady && (/@sha256:[a-f0-9]{64}$/.test(networkImage) || Object.keys(executionProfiles).length > 0),
        rootFilesystem: 'read-only',
        user: '65532:65532',
        capabilities: 'none',
        noNewPrivileges: true,
        runtimes: Object.keys(images).sort(),
        limits: DEFAULT_SANDBOX_LIMITS,
      },
      recentJobs: jobHistory.list(),
    });
  }
  const networkScanRequest = request.method === 'POST' && request.url === '/v1/network-scans';
  if (request.method !== 'POST' || (request.url !== '/v1/jobs' && !networkScanRequest)) return send(response, 404, { error: 'Not found' });
  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (error) {
    return send(response, 413, { error: error instanceof Error ? error.message : 'REQUEST_INVALID' });
  }
  const authenticated = authenticateRequest({
    secret,
    timestamp: request.headers['x-slide-timestamp'] as string | undefined,
    nonce: request.headers['x-slide-nonce'] as string | undefined,
    signature: request.headers['x-slide-signature'] as string | undefined,
    body,
  });
  if (!authenticated) return send(response, 401, { error: 'Unauthorized' });
  const concurrencyLease = concurrencyLimiter.tryAcquire();
  if (!concurrencyLease) return send(response, 429, { error: 'SANDBOX_CONCURRENCY_LIMIT' });

  const jobId = randomUUID();
  const startedAt = Date.now();
  let workspace: string | undefined;
  let runtime = 'unknown';
  try {
    const raw = JSON.parse(body.toString('utf8')) as unknown;
    const job = networkScanRequest
      ? buildDatabaseScanJob(parseDatabaseScanRequest(raw))
      : raw as JobRequest;
    if (!networkScanRequest && job.executionProfile) throw new Error('SANDBOX_PROFILE_NOT_ALLOWED');
    runtime = typeof job.runtime === 'string' ? job.runtime : 'unknown';
    workspace = await prepareWorkspace(jobId, networkScanRequest ? undefined : (job as JobRequest).files);
    const result = await runDocker(jobId, workspace, job) as {
      exitCode: number | null; timedOut: boolean; outputTruncated: boolean;
    };
    const completedAt = Date.now();
    jobHistory.add({
      jobId,
      runtime,
      status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      createdAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
    });
    return send(response, 200, { jobId, ...result as Record<string, unknown> });
  } catch (error) {
    const completedAt = Date.now();
    jobHistory.add({
      jobId,
      runtime,
      status: 'failed',
      exitCode: null,
      timedOut: false,
      outputTruncated: false,
      createdAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
    });
    return send(response, 400, { jobId, error: error instanceof Error ? error.message : 'SANDBOX_JOB_FAILED' });
  } finally {
    concurrencyLease.release();
    if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
});

server.listen(port, '0.0.0.0', () => console.log(`[SandboxController] listening on ${port}`));
