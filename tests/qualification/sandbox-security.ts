import { execFile as execFileCallback } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const baseUrl = process.env.SANDBOX_CONTROLLER_URL || 'http://127.0.0.1:3010';
const secret = process.env.SANDBOX_CONTROLLER_SECRET || '';
const workspaceRoot = path.resolve(process.env.SANDBOX_WORKSPACE_ROOT || '/var/lib/slide-sandbox');

if (process.platform !== 'linux') throw new Error('sandbox qualification requires a Linux host or the Linux sandbox-controller container');
if (secret.length < 32) throw new Error('SANDBOX_CONTROLLER_SECRET is required');

const dockerInfo = JSON.parse((await execFile('docker', ['info', '--format', '{{json .SecurityOptions}}'])).stdout) as string[];
if (!dockerInfo.some((entry) => entry.includes('rootless'))) throw new Error('sandbox qualification requires rootless Docker');

interface JobResult {
  jobId: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

async function submit(command: string[], timeoutMs = 30_000, runtime = 'node'): Promise<JobResult> {
  const body = Buffer.from(JSON.stringify({ runtime, command, timeoutMs }));
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', secret)
    .update(timestamp).update('.').update(nonce).update('.').update(body).digest('hex');
  const response = await fetch(new URL('/v1/jobs', baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slide-timestamp': timestamp,
      'x-slide-nonce': nonce,
      'x-slide-signature': signature,
    },
    body,
  });
  const result = await response.json() as JobResult & { error?: string };
  if (!response.ok) throw new Error(`sandbox request failed (${response.status}): ${result.error ?? 'unknown'}`);
  return result;
}

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

const childLimitProbe = String.raw`
const { spawn } = require('node:child_process');
const children = [];
let denied = false;
let settled = 0;
const finish = () => {
  for (const child of children) child.kill('SIGKILL');
  setTimeout(() => process.exit(denied ? 0 : 31), 100);
};
for (let i = 0; i < 80; i += 1) {
  const child = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  children.push(child);
  child.once('spawn', () => { settled += 1; });
  child.once('error', (error) => { settled += 1; if (error.code === 'EAGAIN') denied = true; });
}
setTimeout(finish, 1000);
`;

const probe = await submit(['/bin/sh', '-ceu', `
  test "$(id -u)" = "65532"
  printf UID_OK\\n
  test "$(awk '/^CapEff:/ { print $2 }' /proc/self/status)" = "0000000000000000"
  printf CAPS_OK\\n
  if touch /slide-root-write-test 2>/dev/null; then exit 11; fi
  printf ROOTFS_OK\\n
  touch /workspace/qualification-write-ok
  printf WORKSPACE_OK\\n
  test ! -S /var/run/docker.sock
  test ! -S /run/docker.sock
  printf SOCKET_OK\\n
  awk '$5 == "/etc/shadow" { mounted=1 } END { exit mounted ? 1 : 0 }' /proc/self/mountinfo
  printf MOUNTS_OK\\n
  if wget -T 2 -q -O /tmp/network-probe http://1.1.1.1 2>/dev/null; then exit 12; fi
  printf NETWORK_OK\\n
  test "$(cat /sys/fs/cgroup/memory.max)" = "268435456"
  printf MEMORY_OK\\n
  test "$(cat /sys/fs/cgroup/pids.max)" = "64"
  printf PIDS_OK\\n
  printf SANDBOX_QUALIFICATION_OK
`], 20_000);

const shellProbe = await submit(['sh', '-ceu', 'printf SHELL_RUNTIME_OK'], 10_000, 'shell');
if (shellProbe.exitCode !== 0 || shellProbe.stdout !== 'SHELL_RUNTIME_OK') {
  throw new Error(`sandbox Shell runtime failed: exit=${shellProbe.exitCode} stderr=${shellProbe.stderr}`);
}
const pythonProbe = await submit(['python3', '-c', 'print("PYTHON_RUNTIME_OK", end="")'], 10_000, 'python');
if (pythonProbe.exitCode !== 0 || pythonProbe.stdout !== 'PYTHON_RUNTIME_OK') {
  throw new Error(`sandbox Python runtime failed: exit=${pythonProbe.exitCode} stderr=${pythonProbe.stderr}`);
}
const nodeProbe = await submit(['node', '-e', 'process.stdout.write("NODE_RUNTIME_OK")'], 10_000, 'node');
if (nodeProbe.exitCode !== 0 || nodeProbe.stdout !== 'NODE_RUNTIME_OK') {
  throw new Error(`sandbox Node runtime failed: exit=${nodeProbe.exitCode} stderr=${nodeProbe.stderr}`);
}

// The environment is separately validated by policy; use a file to avoid quoting executable JavaScript.
const pidProbe = await submit(['/bin/sh', '-ceu', `cat > /workspace/pid-probe.cjs <<'EOF'\n${childLimitProbe}\nEOF\nnode /workspace/pid-probe.cjs`], 10_000);
if (probe.exitCode !== 0 || !probe.stdout.includes('SANDBOX_QUALIFICATION_OK')) {
  throw new Error(`sandbox baseline failed: exit=${probe.exitCode} stdout=${probe.stdout} stderr=${probe.stderr}`);
}
if (pidProbe.exitCode !== 0) throw new Error(`sandbox PID limit was not enforced: ${pidProbe.stderr}`);

const timeout = await submit(['/bin/sh', '-c', 'sleep 30'], 1_000);
if (!timeout.timedOut) throw new Error('sandbox timeout was not enforced');

await eventually(async () => {
  const { stdout } = await execFile('docker', ['ps', '-a', '--filter', `name=slide-sandbox-${timeout.jobId}`, '--format', '{{.ID}}']);
  return stdout.trim() === '';
}, 'timed-out sandbox container was not removed');
await eventually(async () => {
  try {
    await fs.access(path.join(workspaceRoot, timeout.jobId));
    return false;
  } catch {
    return true;
  }
}, 'timed-out sandbox workspace was not removed');

console.log('Linux rootless sandbox qualification passed');
