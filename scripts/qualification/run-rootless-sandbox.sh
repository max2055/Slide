#!/usr/bin/env bash
# Only for a disposable GitHub-hosted Linux runner, never a deployment host.
set -euo pipefail
# Standalone runs retain the complete gate. CI supplies source scans separately.
security_commands=(release:security-gate)
if [[ "${1:-}" == --runtime-only && "$#" == 1 ]]; then
  security_commands=(security:test security:deployment security:sandbox)
elif [[ "$#" != 0 ]]; then
  echo 'Use no arguments or --runtime-only' >&2; exit 64
fi
cd "$(dirname "$0")/../.."
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux ]] || {
  echo 'Requires a disposable GitHub-hosted Linux runner' >&2; exit 1;
}
[[ "$(id -u)" != 0 ]] || { echo 'Runner user must be non-root' >&2; exit 1; }
out="$PWD/.qualification/rootless-sandbox"
mkdir -p "$out"
printf 'uid=%s\nhost=%s\n' "$(id -u)" "$(uname -s)" > "$out/setup-environment.txt"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
controller_pid=''
mysql_container="slide-t12-nonce-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
# The SQL fixture uses the runner's separate stock daemon. Only sandbox jobs
# use DOCKER_HOST/rootless; neither daemon socket is mounted into those jobs.
fixture_docker=(docker --host unix:///var/run/docker.sock)
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [[ -n "$controller_pid" ]]; then kill -TERM "$controller_pid" 2>/dev/null || true; wait "$controller_pid" || true; fi
  docker ps -aq --filter name=slide-sandbox- | xargs -r docker rm -f > "$out/job-cleanup.log" 2>&1
  if "${fixture_docker[@]}" inspect "$mysql_container" >/dev/null 2>&1; then
    "${fixture_docker[@]}" stop --timeout 10 "$mysql_container" > "$out/nonce-cleanup.log" 2>&1
    "${fixture_docker[@]}" rm -v "$mysql_container" >> "$out/nonce-cleanup.log" 2>&1
    if [[ $? != 0 ]]; then cat "$out/nonce-cleanup.log"; result=1; fi
  fi
  "${fixture_docker[@]}" ps -a --filter "name=^${mysql_container}$" --format '{{.Names}}' > "$out/nonce-after-cleanup.txt"
  if [[ -s "$out/nonce-after-cleanup.txt" ]]; then cat "$out/nonce-after-cleanup.txt"; result=1; fi
  if docker info >/dev/null 2>&1; then
    docker ps -a --format '{{.Names}}' > "$out/containers-after-cleanup.txt"
    if [[ -s "$out/containers-after-cleanup.txt" ]]; then cat "$out/containers-after-cleanup.txt"; result=1; fi
  fi
  if [[ -d "$SANDBOX_WORKSPACE_ROOT" ]]; then
    find "$SANDBOX_WORKSPACE_ROOT" -mindepth 1 -print > "$out/workspaces-after-cleanup.txt"
    if [[ -s "$out/workspaces-after-cleanup.txt" ]]; then cat "$out/workspaces-after-cleanup.txt"; result=1; fi
  fi
  systemctl --user stop docker.service || true
  exit "$result"
}
export SANDBOX_WORKSPACE_ROOT="$RUNNER_TEMP/slide-t12-sandbox-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sudo apt-get update -qq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl --fail --silent --show-error https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
task_codename="$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")"
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$task_codename" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y uidmap dbus-user-session slirp4netns docker-ce-rootless-extras
sudo loginctl enable-linger "$(id -un)"
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=yes\n' | sudo tee /etc/systemd/system/user@.service.d/slide-qualification.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart "user@$(id -u).service"
sudo systemctl show "user@$(id -u).service" -p Delegate -p ControlGroup > "$out/user-manager.txt"
# Ubuntu 24.04 restricts unprivileged user namespaces. This isolated runner is
# discarded after the job; no production host setting is changed.
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
dockerd-rootless-setuptool.sh install --force
mkdir -p "$HOME/.config/systemd/user/docker.service.d"
printf '[Service]\nDelegate=yes\n' > "$HOME/.config/systemd/user/docker.service.d/delegate.conf"
systemctl --user daemon-reload
systemctl --user restart docker.service
docker info --format '{{json .}}' > "$out/docker-info.json"
systemctl --user show docker.service -p Delegate -p ControlGroup > "$out/docker-service.txt"
stat -fc %T /sys/fs/cgroup > "$out/cgroup-filesystem.txt"
docker info --format '{{json .SecurityOptions}}' | tee "$out/security-options.json"
docker info --format '{{json .SecurityOptions}}' | grep -q rootless

for image in node:24-alpine python:3.12-alpine; do docker pull "$image"; done
"${fixture_docker[@]}" pull mysql:8.4
"${fixture_docker[@]}" info --format '{{json .SecurityOptions}}' > "$out/nonce-daemon-security-options.json"
node_image="$(docker image inspect node:24-alpine --format '{{index .RepoDigests 0}}')"
python_image="$(docker image inspect python:3.12-alpine --format '{{index .RepoDigests 0}}')"
export SANDBOX_IMAGES="$(node -e 'process.stdout.write(JSON.stringify({node:process.argv[1],shell:process.argv[1],python:process.argv[2]}))' "$node_image" "$python_image")"
printf '%s\n' "$SANDBOX_IMAGES" > "$out/runtime-images.json"
export SANDBOX_CONTROLLER_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export SANDBOX_NONCE_DB_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export SANDBOX_NONCE_DB_HOST=127.0.0.1 SANDBOX_NONCE_DB_NAME=t12_nonce SANDBOX_NONCE_DB_USER=t12_controller
"${fixture_docker[@]}" run -d --name "$mysql_container" -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1::3306 mysql:8.4 >/dev/null
export SANDBOX_NONCE_DB_PORT="$("${fixture_docker[@]}" port "$mysql_container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
ready=0
for _ in $(seq 1 90); do
  if "${fixture_docker[@]}" exec "$mysql_container" mysqladmin ping --protocol=tcp --host=127.0.0.1 --silent >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'Isolated nonce MySQL unavailable' >&2; exit 1; }
pnpm --filter slide-sandbox-controller exec node --input-type=module <<'JS'
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
const c = await mysql.createConnection({host:'127.0.0.1',port:Number(process.env.SANDBOX_NONCE_DB_PORT),user:'root',password:'',multipleStatements:true});
await c.query('CREATE DATABASE t12_nonce');
await c.query('USE t12_nonce');
for (const file of ['096_sandbox_request_nonces.sql','097_sandbox_request_nonce_comments.sql']) {
  await c.query(await readFile(`../db-ops-api/sql/migrations/${file}`,'utf8'));
}
await c.query("CREATE USER 't12_controller'@'%' IDENTIFIED BY ?",[process.env.SANDBOX_NONCE_DB_PASSWORD]);
await c.query("GRANT SELECT, INSERT, DELETE ON t12_nonce.sandbox_request_nonces TO 't12_controller'@'%'");
await c.end();
JS
export SANDBOX_CONTROLLER_PORT=3010 SANDBOX_CONTROLLER_URL=http://127.0.0.1:3010
export SANDBOX_EXECUTION_PROFILES='{}' SANDBOX_RESTRICTED_NETWORK='' SANDBOX_NETWORK_IMAGE=''
node --import ./apps/sandbox-controller/node_modules/tsx/dist/loader.mjs apps/sandbox-controller/src/server.ts > "$out/controller.log" 2>&1 &
controller_pid=$!
ready=0
for _ in $(seq 1 30); do
  if curl --fail --silent "$SANDBOX_CONTROLLER_URL/health" > "$out/health.json"; then ready=1; break; fi
  kill -0 "$controller_pid" || { cat "$out/controller.log"; exit 1; }
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'Isolated controller unavailable' >&2; exit 1; }
export SANDBOX_QUALIFICATION_OUTPUT="$out/qualification.json"
for security_command in "${security_commands[@]}"; do
  pnpm "$security_command" 2>&1 | tee -a "$out/release-security.log"
done
