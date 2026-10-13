#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-auth-boundary-$$-$RANDOM"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ROOT_PASSWORD=qualification-test-password --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
stable=0
for _ in $(seq 1 60); do
  if AUTH_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec node -e '
    import("mysql2/promise").then(async ({default:mysql}) => {
      const c = await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.AUTH_TEST_MYSQL_PORT),user:"root",password:"qualification-test-password"});
      await c.query("SELECT 1"); await c.end();
    }).catch(() => process.exit(1));' >/dev/null 2>&1; then
    stable=$((stable + 1))
    if [[ "$stable" -ge 3 ]]; then break; fi
  else stable=0; fi
  sleep 1
done
if [[ "$stable" -lt 3 ]]; then echo "isolated authorization MySQL unavailable" >&2; exit 1; fi
AUTH_TEST_MYSQL_PORT="$port" AUTH_TEST_MYSQL_PASSWORD=qualification-test-password \
  pnpm --filter slide-api exec vitest run src/auth/instance-boundary.mysql.test.ts \
    src/auth/require-instance-access.test.ts src/auth/security-boundaries.test.ts src/auth/chat-routes.test.ts \
    src/investigations/authorization.test.ts src/investigations/session-bridge.test.ts src/investigations/routes.test.ts \
    src/investigations/profile-routes.test.ts
