/** Explicit real SSH acceptance. No platform DB writes or default private credentials. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { SshSessionPool } from '../src/ssh-session-pool.js';
import { LinuxHostEvidenceService } from '../src/linux-host-evidence-service.js';
import { ServerDiagnosticService } from '../src/server-diagnostic-service.js';
import { PROCESS_LIST_COMMAND, parseTopProcessesWithDiagnostics } from '../src/server-metric-provider.js';
import { collectFixed } from '../src/metrics/packages/adapters.js';

const host = process.env.SSH_HOST;
const passwordFile = process.env.SSH_PASSWORD_FILE;
const output = process.env.ACCEPTANCE_OUTPUT;
assert(host && passwordFile && output, 'SSH_HOST, SSH_PASSWORD_FILE and ACCEPTANCE_OUTPUT are required');
const password = (await readFile(passwordFile, 'utf8')).trimEnd();
const username = process.env.SSH_USER ?? 'root';
const pool = new SshSessionPool();
let workload: Promise<unknown> | undefined;
let commandsExecuted = 0;
const observedPool = {
  getConnection: pool.getConnection.bind(pool),
  releaseConnection: pool.releaseConnection.bind(pool),
  closeConnection: pool.closeConnection.bind(pool),
  execCommands: async (...args: Parameters<typeof pool.execCommands>) => {
    commandsExecuted += args[1].length;
    return pool.execCommands(...args);
  },
};
try {
  // Password login retains the project's existing optional host pin behavior.
  // Callers can provide an independently verified pin without changing shared config.
  const pin = process.env.SSH_HOST_KEY_FINGERPRINT;
  const client = await pool.getConnection(host, 22, username, 'password', password, pin);
  const [identity] = await pool.execCommands(client, ['hostname; id -u; uname -m; nproc; ip -o -4 addr show']);
  assert.equal(identity.exitCode, 0);
  const cpuCount = Number(identity.stdout.split('\n')[3]);
  assert(cpuCount >= 1, 'CPU inventory must be available');
  console.log(`Real SSH host CPUs: ${cpuCount}`);
  const python = `import ctypes,hashlib,os,threading,time
ctypes.CDLL(None).prctl(15,b'max400 worker',0,0,0)
print(os.getpid(),flush=True)
until=time.monotonic()+10
def work():
 while time.monotonic()<until: hashlib.pbkdf2_hmac('sha256',b'x',b'y',10000)
threads=[threading.Thread(target=work) for _ in range(min(4,os.cpu_count()))]
for t in threads: t.start()
for t in threads: t.join()
`;
  const command = `python3 -c '${python.replace(/'/g, "'\\''")}'`;
  // Keep the workload in a foreground SSH channel and always join it in finally.
  workload = pool.execCommands(client, [command], { timeoutMs: 14_000 }).then(results => {
    assert.equal(results[0].exitCode, 0);
    return results[0].stdout.trim();
  });
  await setTimeout(2000);
  const [ps] = await pool.execCommands(client, [PROCESS_LIST_COMMAND]);
  assert.equal(ps.exitCode, 0);
  const parsed = parseTopProcessesWithDiagnostics(ps.stdout);
  const sample = parsed.items.find(row => row.command === 'max400 worker');
  assert(sample, 'Spaced comm must be visible in real ps');
  if (cpuCount > 1) assert(sample.cpuPercent > 100, 'Real sample must exercise multi-core pcpu');
  assert.equal(parsed.malformedLines, 0);
  pool.releaseConnection(client);

  // Inventory is injected for this test only; transport and commands are real.
  const inventory = {
    getServerById: async () => ({ id: 400, host, port: 22, os_type: 'Kylin V10',
      credential_type: 'password', host_key_fingerprint: pin }),
    getDecryptedCredentials: async () => ({ username, password }),
  };
  const hostEvidence = await new LinuxHostEvidenceService({ serverDatabaseService: inventory as any,
    sshSessionPool: observedPool }).collectHostEvidence(400, { databaseType: 'mysql', services: [], paths: [] });
  assert.equal(hostEvidence.metrics.quality, 'good');
  assert(Number(hostEvidence.metrics.values.top_processes_cpu) > (cpuCount > 1 ? 100 : 0));
  const diagnostics = await new ServerDiagnosticService({ serverDatabaseService: inventory as any,
    sshSessionPool: observedPool }).collectDiagnostics(400);
  const diagnosticSample = diagnostics.topProcesses.items.find(row => row.command === 'max400 worker');
  assert(diagnosticSample && diagnosticSample.cpuPercent > (cpuCount > 1 ? 100 : 0));
  const adapterClient = await pool.getConnection(host, 22, username, 'password', password, pin);
  const adapter = await collectFixed('builtin:linux.diagnostic-gauges.v1', {
    method: 'ssh', client: adapterClient, pool: observedPool,
  }, {}, 5000, 100);
  assert(Number(adapter[0].fields.top_processes_cpu?.value) > (cpuCount > 1 ? 100 : 0));
  pool.releaseConnection(adapterClient);
  const samplePid = await workload;
  const cleanupClient = await pool.getConnection(host, 22, username, 'password', password, pin);
  assert(/^\d+$/.test(String(samplePid)));
  const [cleanup] = await pool.execCommands(cleanupClient, [`test ! -e /proc/${samplePid}`]);
  assert.equal(cleanup.exitCode, 0, 'Bounded workload must have exited');
  pool.releaseConnection(cleanupClient);
  await writeFile(output, JSON.stringify({ host, identity: identity.stdout.trim(), cpuCount, commandsExecuted,
    sample, diagnosticSample, adapterCpu: adapter[0].fields.top_processes_cpu,
    metrics: hostEvidence.metrics, malformedLines: parsed.malformedLines,
    scope: 'Real SSH, injected inventory, no HTTP or platform DB writes; large counters tested separately with fixtures',
    multiCore: cpuCount > 1 ? 'real pcpu >100 exercised' : 'single CPU VM: pcpu >100 covered by fixture only',
    cleanup: { samplePid, exitCode: cleanup.exitCode }, testExitCode: 0 }, null, 2) + '\n');
  console.log('MAX-400 real SSH acceptance passed; evidence written.');
} finally {
  try { await workload; } finally { pool.closeAll(); }
}
