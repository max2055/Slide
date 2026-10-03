#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-audit-browser-$$-$RANDOM"
directory="$(mktemp -d "${TMPDIR:-/tmp}/slide-audit-browser.XXXXXX")"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$directory"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
export DB_HOST=127.0.0.1 DB_PORT="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')" DB_USER=root DB_PASSWORD=''
stable=0
for _ in $(seq 1 60); do
  if pnpm --filter slide-api exec node -e '
    import("mysql2/promise").then(async ({default:mysql}) => {
      const c = await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.DB_PORT),user:"root",password:""});
      await c.query("SELECT 1"); await c.end();
    }).catch(() => process.exit(1));' >/dev/null 2>&1; then
    stable=$((stable + 1))
    if [[ "$stable" -ge 3 ]]; then break; fi
  else stable=0; fi
  sleep 1
done
if [[ "$stable" -lt 3 ]]; then echo 'isolated audit browser MySQL unavailable' >&2; exit 1; fi
free_port() {
  node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}
export QUALIFICATION_API_PORT="$(free_port)" QUALIFICATION_WS_PORT="$(free_port)"
export QUALIFICATION_FRONTEND_PORT="$(free_port)" QUALIFICATION_CANCELLABLE_LLM_PORT="$(free_port)"
export QUALIFICATION_ADMIN_PASSWORD=Tpam1234 QUALIFICATION_CANCELLATION_E2E=1 QUALIFICATION_CRON_E2E=1 PLAYWRIGHT_MANAGED_ENV=1
export AGENT_WORKSPACE="$directory/workspace" PROMPT_VERSIONS_DIR="$directory/prompts" PROMPT_HOT_RELOAD=false
unset QUALIFICATION_DEEPSEEK_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
echo "W14 browser: isolated MySQL=$DB_PORT API=$QUALIFICATION_API_PORT WS=$QUALIFICATION_WS_PORT frontend=$QUALIFICATION_FRONTEND_PORT fake-provider=$QUALIFICATION_CANCELLABLE_LLM_PORT"
CRON_TEST_MYSQL_PORT="$DB_PORT" pnpm --filter slide-api exec vitest run src/cron/cron-mysql.integration.test.ts src/cron/cron-run-upgrade.mysql.test.ts
bash scripts/qualification/run-agent-runtime.sh --mode mysql
pnpm --filter slide-frontend exec playwright test cron-live.spec.ts --workers=1
