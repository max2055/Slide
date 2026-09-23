import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const requireFromApi = createRequire(path.join(root, 'apps/db-ops-api/package.json'));
const YAML = requireFromApi('yaml') as { parse(input: string): Record<string, any> };
const composePath = path.join(root, 'compose.production.yaml');
const compose = YAML.parse(await fs.readFile(composePath, 'utf8')) as Record<string, any>;
const services = compose.services ?? {};
const failures: string[] = [];

function requireInvariant(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function environment(service: Record<string, any>): Record<string, string> {
  if (Array.isArray(service.environment)) {
    return Object.fromEntries(service.environment.map((entry: string) => {
      const separator = entry.indexOf('=');
      return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  return service.environment ?? {};
}

function volumeSources(service: Record<string, any>): string[] {
  return list(service.volumes).map((volume) => volume.split(':', 1)[0]);
}

for (const required of ['tls-edge', 'frontend', 'api', 'prompt-storage-init', 'sandbox-controller', 'mysql']) {
  requireInvariant(Boolean(services[required]), `missing service ${required}`);
}

const api = services.api ?? {};
const promptStorageInit = services['prompt-storage-init'] ?? {};
const controller = services['sandbox-controller'] ?? {};
const frontend = services.frontend ?? {};
const tlsEdge = services['tls-edge'] ?? {};
const declaredVolumes = new Set(Object.keys(compose.volumes ?? {}));
const socketOwners = Object.entries(services)
  .filter(([, service]) => JSON.stringify((service as any).volumes ?? []).includes('docker.sock'))
  .map(([name]) => name);

requireInvariant(socketOwners.length === 1 && socketOwners[0] === 'sandbox-controller', 'only sandbox-controller may mount docker.sock');
requireInvariant(!JSON.stringify(api).includes('docker.sock'), 'api must not reference docker.sock');
requireInvariant(api.read_only === true, 'api root filesystem must be read-only');
requireInvariant(controller.read_only === true, 'sandbox-controller root filesystem must be read-only');
for (const [name, service] of [['api', api], ['sandbox-controller', controller], ['frontend', frontend], ['tls-edge', tlsEdge]] as const) {
  requireInvariant(list(service.cap_drop).includes('ALL'), `${name} must drop all capabilities`);
  requireInvariant(list(service.security_opt).includes('no-new-privileges:true'), `${name} must set no-new-privileges`);
  requireInvariant(service.privileged !== true, `${name} must not be privileged`);
}
requireInvariant(!controller.ports, 'sandbox-controller must not publish a host port');
requireInvariant(!api.ports, 'api and raw Agent WebSocket ports must remain internal');
requireInvariant(Boolean(frontend.ports), 'frontend must retain a loopback-only diagnostic listener');
requireInvariant(list(frontend.ports).every((entry) => entry.includes('SLIDE_HTTP_BIND:-127.0.0.1')), 'frontend port 8080 must default to loopback');
requireInvariant(Boolean(tlsEdge.ports), 'TLS edge must publish HTTPS and the HTTP redirect');
requireInvariant(list(tlsEdge.ports).some((entry) => entry.includes('SLIDE_HTTPS_PORT:-443')), 'TLS edge must publish HTTPS');
requireInvariant(list(tlsEdge.ports).some((entry) => entry.includes('SLIDE_HTTP_REDIRECT_PORT:-80')), 'TLS edge must publish the HTTP redirect');
requireInvariant(list(tlsEdge.volumes).some((entry) => entry.includes('SLIDE_TLS_CERT') && entry.endsWith(':ro')), 'TLS certificate must be an operator-managed read-only mount');
requireInvariant(list(tlsEdge.volumes).some((entry) => entry.includes('SLIDE_TLS_KEY') && entry.endsWith(':ro')), 'TLS private key must be an operator-managed read-only mount');
requireInvariant(String(api.user) === '10001:10001', 'api must run as the dedicated non-root UID');
requireInvariant(String(promptStorageInit.user) === '0:0', 'prompt storage initializer must explicitly run as root');
requireInvariant(promptStorageInit.read_only === true, 'prompt storage initializer root filesystem must be read-only');
requireInvariant(list(promptStorageInit.cap_drop).includes('ALL'), 'prompt storage initializer must drop all capabilities first');
requireInvariant(
  ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'].every((capability) => list(promptStorageInit.cap_add).includes(capability))
    && list(promptStorageInit.cap_add).length === 3,
  'prompt storage initializer must receive only the capabilities needed to repair volume ownership',
);
requireInvariant(list(promptStorageInit.security_opt).includes('no-new-privileges:true'), 'prompt storage initializer must set no-new-privileges');
requireInvariant(promptStorageInit.network_mode === 'none', 'prompt storage initializer must not have network access');
requireInvariant(promptStorageInit.privileged !== true, 'prompt storage initializer must not be privileged');
requireInvariant(!promptStorageInit.ports && !promptStorageInit.expose, 'prompt storage initializer must not expose ports');
requireInvariant(
  api.depends_on?.['prompt-storage-init']?.condition === 'service_completed_successfully',
  'api must wait for prompt storage initialization',
);
requireInvariant(String(controller.user).includes('ROOTLESS_DOCKER_UID'), 'controller UID must match the rootless Docker owner');

for (const source of volumeSources(api)) {
  requireInvariant(declaredVolumes.has(source), `api volume ${source} must be a named volume, not a host bind`);
}
requireInvariant(volumeSources(api).every((source) => source !== '.' && source !== root), 'api must not mount the repository');
requireInvariant(environment(api).AGENT_WORKSPACE === '/var/lib/slide-agent', 'api must use the dedicated Agent state volume');
requireInvariant(environment(api).PROMPT_VERSIONS_DIR === '/var/lib/slide-agent/prompts', 'api must persist prompts in the Agent state volume');
requireInvariant(environment(api).SLIDE_SOURCE_ROOT === '/var/lib/slide-agent/source-snapshots', 'source sync must use the writable Agent state volume');
requireInvariant(String(environment(api).SLIDE_GITLAB_ORIGINS).includes('SLIDE_GITLAB_ORIGINS'), 'api must receive operator-approved GitLab origins');
requireInvariant(String(environment(api).SLIDE_SOURCE_SIGNING_KEY).includes('SLIDE_SOURCE_SIGNING_KEY'), 'api must receive the optional source signing key');
const apiDockerfile = await fs.readFile(path.join(root, 'apps/db-ops-api/Dockerfile'), 'utf8');
requireInvariant(/apt-get install[^\n]*\bgit\b/.test(apiDockerfile.split('AS production')[1] ?? ''), 'production source connector requires Git in the API image');
requireInvariant(
  list(promptStorageInit.volumes).includes('agent-state:/var/lib/slide-agent'),
  'prompt storage initializer and api must share the Agent state volume',
);
const promptStorageCommand = JSON.stringify(promptStorageInit.command ?? '');
requireInvariant(
  promptStorageCommand.includes('/var/lib/slide-agent/prompts') && promptStorageCommand.includes('10001:10001'),
  'prompt storage initializer must repair the configured prompt directory for the api UID',
);
requireInvariant(environment(api).SANDBOX_CONTROLLER_URL === 'http://sandbox-controller:3010', 'api must call the internal sandbox controller');
requireInvariant(!('DOCKER_HOST' in environment(api)), 'api must not receive DOCKER_HOST');
requireInvariant(environment(controller).DOCKER_HOST === 'unix:///run/docker.sock', 'controller must use the mounted rootless socket');
requireInvariant(String(environment(controller).SANDBOX_IMAGES).includes(':?'), 'SANDBOX_IMAGES must be required at deployment');
requireInvariant(list(controller.volumes).some((volume) =>
  volume.includes('${SANDBOX_WORKSPACE_ROOT:?SANDBOX_WORKSPACE_ROOT is required}:${SANDBOX_WORKSPACE_ROOT:?SANDBOX_WORKSPACE_ROOT is required}:rw')
), 'controller and rootless daemon must see the same sandbox workspace path');
requireInvariant(compose.networks?.control?.internal === true && compose.networks?.data?.internal === true, 'control and data networks must be internal');

for (const [name, service] of Object.entries(services) as Array<[string, any]>) {
  if (service.image) requireInvariant(String(service.image).includes('@sha256:'), `${name} image must be digest-pinned`);
}
for (const dockerfile of ['apps/db-ops-api/Dockerfile', 'apps/sandbox-controller/Dockerfile', 'frontend/Dockerfile']) {
  const content = await fs.readFile(path.join(root, dockerfile), 'utf8');
  const fromLines = content.split('\n').filter((line) => line.trim().startsWith('FROM '));
  requireInvariant(fromLines.length > 0 && fromLines.every((line) => line.includes('@sha256:')), `${dockerfile} base images must be digest-pinned`);
}

const envText = await fs.readFile(path.join(root, 'deploy/.env.production.example'), 'utf8');
const env = Object.fromEntries(envText.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
  const separator = line.indexOf('=');
  return [line.slice(0, separator), line.slice(separator + 1)];
}));
try {
  const images = JSON.parse(env.SANDBOX_IMAGES ?? '{}') as Record<string, string>;
  requireInvariant(Object.keys(images).length > 0, 'deployment example must allow at least one sandbox runtime');
  requireInvariant(Object.values(images).every((image) => image.includes('@sha256:')), 'sandbox runtime images must be digest-pinned');
} catch {
  failures.push('deployment SANDBOX_IMAGES must be valid JSON');
}

const frontendNginx = await fs.readFile(path.join(root, 'frontend/nginx.conf'), 'utf8');
const edgeNginx = await fs.readFile(path.join(root, 'deploy/nginx-tls.conf'), 'utf8');
for (const [name, config] of [['frontend nginx', frontendNginx], ['TLS edge nginx', edgeNginx]] as const) {
  requireInvariant(/location = \/agent-ws/.test(config), `${name} must define the exact /agent-ws route`);
  requireInvariant(/proxy_http_version 1\.1/.test(config), `${name} must proxy WebSocket over HTTP/1.1`);
  requireInvariant(/proxy_set_header Upgrade \$http_upgrade/.test(config), `${name} must forward Upgrade`);
  requireInvariant(/proxy_set_header Connection/.test(config), `${name} must forward Connection upgrade`);
  requireInvariant(/proxy_set_header Host \$host/.test(config), `${name} must preserve Host`);
  requireInvariant(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for/.test(config), `${name} must append X-Forwarded-For`);
  requireInvariant(/proxy_set_header X-Forwarded-Proto (\$slide_forwarded_proto|https)/.test(config), `${name} must forward the external scheme`);
  requireInvariant(/proxy_read_timeout 3600s/.test(config), `${name} must allow long-lived WebSockets`);
}
requireInvariant(/return 308 https:\/\/\$host\$request_uri/.test(edgeNginx), 'TLS edge HTTP listener must only redirect to HTTPS');
requireInvariant(/ssl_certificate \/etc\/nginx\/tls\/tls\.crt/.test(edgeNginx), 'TLS edge must load the mounted certificate');
requireInvariant(/map \$http_x_forwarded_proto \$slide_forwarded_proto/.test(frontendNginx), 'frontend nginx must preserve the trusted outer proxy scheme');

const qualificationScript = await fs.readFile(path.join(root, 'scripts/qualification/run-sandbox-security.sh'), 'utf8');
const linuxCheckIndex = qualificationScript.indexOf('uname -s');
const composeExecIndex = qualificationScript.indexOf('docker compose');
requireInvariant(linuxCheckIndex >= 0, 'sandbox qualification must reject non-Linux hosts');
requireInvariant(composeExecIndex >= 0 && linuxCheckIndex < composeExecIndex, 'sandbox qualification must check Linux before resolving Compose secrets');
requireInvariant(qualificationScript.includes('SLIDE_ENV_FILE'), 'sandbox qualification must accept an operator-managed Compose env file');

if (failures.length) {
  throw new Error(`deployment security invariants failed:\n- ${failures.join('\n- ')}`);
}
console.log('deployment security invariants passed');
