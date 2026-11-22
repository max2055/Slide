# Production Security Gate

Slide's production topology requires Linux and a dedicated rootless Docker daemon. The API never receives a Docker socket. Only `sandbox-controller` can access the rootless socket, on an internal Compose network.

## Host preparation

1. Create a dedicated non-root service account and enable rootless Docker for it.
2. Create `SANDBOX_WORKSPACE_ROOT` outside the repository, owned by that account and mode `0700`.
3. Copy `deploy/.env.production.example` to an operator-managed secret location and replace every placeholder. Keep JWT, encryption, approval HMAC, controller, database, and initial-admin secrets independent.
4. Set `SLIDE_PUBLIC_ORIGIN` to the HTTPS DNS name covered by the trusted certificate and set `SLIDE_TLS_CERT` / `SLIDE_TLS_KEY` to operator-managed PEM files. Do not use an IP URL unless the certificate contains that IP SAN.
5. Pre-pull every digest-pinned image listed in `SANDBOX_IMAGES` with the rootless daemon.

The Compose TLS edge publishes 443 and an HTTP redirect on 80. The application
frontend remains bound to loopback on 8080 only for local diagnostics; clients
must use the HTTPS origin. Both proxy hops preserve `Host`, append
`X-Forwarded-For`, set the real external `X-Forwarded-Proto`, and carry the
HTTP/1.1 WebSocket upgrade for `/agent-ws`.

### Client addresses for login rate limiting

For a direct API deployment, leave `API_TRUSTED_PROXY_IPS` unset or empty. The
API identifies clients by the TCP peer address. For a custom reverse proxy
deployment, set `API_TRUSTED_PROXY_IPS` to the exact proxy IP addresses, ordered
from the peer nearest the API toward the public edge. Each trusted proxy must
append its actual TCP peer to `X-Forwarded-For` or set the header from a verified
source. Reserve those addresses for the proxies and keep the API private.

Production Compose sets the list to the frontend nginx address followed by the
TLS edge address. If the default edge subnet overlaps an existing network,
set `SLIDE_EDGE_SUBNET`, `SLIDE_EDGE_DYNAMIC_RANGE`, `SLIDE_FRONTEND_PROXY_IPV4`,
and `SLIDE_TLS_EDGE_IPV4` together. Choose distinct proxy IPs inside the new
subnet and outside its dynamic allocation range. For an existing stack,
plan a maintenance window to recreate the edge network with the new IPAM
settings and leave the persistent volumes intact.

The TLS edge must receive each client's source address. Use a rootless port
driver that preserves it and verify that the edge sees distinct addresses
from two external clients after changing the driver or routing. See the
[Docker rootless source IP guidance](https://docs.docker.com/engine/security/rootless/troubleshoot/#docker-run--p-does-not-propagate-source-ip-addresses).

For an existing HTTP deployment, follow [HTTPS / WSS cutover and rollback](HTTPS.md)
to configure certificate trust, switch only affected services, and verify the
real Edge chat connection. The guide also includes a local two-proxy transport check.

Do not mount the repository, the rootful `/var/run/docker.sock`, or arbitrary host directories into the API or sandbox jobs.

Oracle 11g requires node-oracledb Thick mode. If Oracle 11g support is needed,
install a compatible Oracle Instant Client on the target host and use the
documented `deploy/oracle-client.compose.example.yaml` override. Do not copy
Oracle client binaries into the application image or repository.

## Provider configuration backup

LLM provider API keys are stored encrypted in the platform database. The
operator backup flow exports only non-secret provider fields and scene
bindings; it never includes `api_key_encrypted`, plaintext keys, DB passwords
or URL credentials. Follow
[Provider 配置备份、恢复与脱敏流程](../docs/slide/development/provider-config-backup.md)
for the checklist and commands. Keep artifacts outside every Git worktree with
mode `0600`, verify the sibling SHA-256 before restore, and re-enter
credentials after a cross-environment restore. Run the disposable MySQL drill
before relying on the procedure:

```bash
pnpm --filter slide-api exec tsx tests/provider-config-backup.mysql.ts
```

## Database network discovery

Database discovery is exposed only through the `discover_database_endpoints`
tool. The controller resolves its logical `database-network-scan` execution
profile to the digest-pinned `slide-network-tools` image; callers cannot pass a
command, port list, image, or Docker network. Keep the following values
operator-managed and restrict them to approved IPv4 networks:

```dotenv
SANDBOX_EXECUTION_PROFILES={"database-network-scan":"slide-network-tools@sha256:<digest>"}
```

The profile image must contain `nmap` and run as the sandbox's unprivileged
UID. The restricted network is intentionally separate from ordinary sandbox
jobs; changing `SANDBOX_RESTRICTED_NETWORK` or the profile mapping requires a
deployment review.

## Release checks

Run static and unit security checks before deployment:

```bash
pnpm security:audit
pnpm security:scan
pnpm security:test
pnpm security:deployment
docker compose --env-file /secure/path/slide.env -f compose.production.yaml config
```

Run the production-equivalent browser qualification from a Microsoft Edge host
that trusts the deployed certificate. This performs at least 30 history/new
session send cycles and a five-second offline durable-send recovery; it rejects
certificate errors and non-same-origin WebSockets:

```bash
SLIDE_EDGE_BASE_URL=https://slide.example.com \
SLIDE_EDGE_USERNAME='<operator test user>' \
SLIDE_EDGE_PASSWORD='<operator-managed secret>' \
pnpm --filter slide-frontend test:edge-recovery
```

After the stack is healthy, run the Linux/rootless sandbox qualification from inside the controller:

```bash
SLIDE_ENV_FILE=/secure/path/slide.env pnpm release:security-gate
```

The qualification verifies non-root UID, zero effective capabilities, read-only root, writable job workspace, no outbound network, cgroup memory/PID limits, absent Docker socket, timeout termination, and container/workspace cleanup.
