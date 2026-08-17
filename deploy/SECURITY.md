# Production Security Gate

Slide's production topology requires Linux and a dedicated rootless Docker daemon. The API never receives a Docker socket. Only `sandbox-controller` can access the rootless socket, on an internal Compose network.

## Host preparation

1. Create a dedicated non-root service account and enable rootless Docker for it.
2. Create `SANDBOX_WORKSPACE_ROOT` outside the repository, owned by that account and mode `0700`.
3. Copy `deploy/.env.production.example` to an operator-managed secret location and replace every placeholder. Keep JWT, encryption, approval HMAC, controller, database, and initial-admin secrets independent.
4. Put a TLS reverse proxy or load balancer in front of the loopback-bound frontend port.
5. Pre-pull every digest-pinned image listed in `SANDBOX_IMAGES` with the rootless daemon.

Do not mount the repository, the rootful `/var/run/docker.sock`, or arbitrary host directories into the API or sandbox jobs.

## Release checks

Run static and unit security checks before deployment:

```bash
pnpm security:audit
pnpm security:scan
pnpm security:test
pnpm security:deployment
docker compose --env-file /secure/path/slide.env -f compose.production.yaml config
```

After the stack is healthy, run the Linux/rootless sandbox qualification from inside the controller:

```bash
SLIDE_ENV_FILE=/secure/path/slide.env pnpm release:security-gate
```

The qualification verifies non-root UID, zero effective capabilities, read-only root, writable job workspace, no outbound network, cgroup memory/PID limits, absent Docker socket, timeout termination, and container/workspace cleanup.
