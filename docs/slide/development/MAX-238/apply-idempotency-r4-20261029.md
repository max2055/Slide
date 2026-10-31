# MAX238-APPLY-IDEMPOTENCY-R4：fixture 清理失败不再假报成功

本包只修同一个 harness 生命周期缺陷：Docker daemon 不可访问、删除失败或删除后无法核验时，清理不能再报“already removed”并 exit 0。R3 的公开 keyed 入口授权修正与既有操作协议证据保持不动，本包不重做生产协议、业务实现或完整协议验证。整单 MAX238/MAX235 仍未完成。

- 任务分支：`agent/15coder1/max-238`（只在 R3 `4fe1e9b18` 上追加，未切换/重置/改写已接受提交）
- 基点：`4fe1e9b1800e119cb4182ac7b60cba8c06b99b57`（R3 交付）
- 实现提交：`0e08cdc47`；证据提交：本文件所在提交
- 范围：`frontend/e2e/max238-real-api.sh`、真实 API spec、`playwright.MAX-238.config.ts`、同 fixture server、最小回归与本文档
- 未改：`apps/db-ops-api/src/metrics/` 下任何生产代码与测试、MAX240 的文件（`metrics/query.ts`、`storage.ts` 读方法、`rollout/formal-store.ts` 读方法、`consumers/*`）、policy/config/谓词/必要项名单

## 1. 清理判定：只有 daemon 确认不存在才算成功

R3 的 `remove_owned` 用 `docker inspect` 的退出码判断存在性，Docker daemon 不可访问时 inspect 同样返回非零，于是打印 “already removed” 并 exit 0。删除后的复核也有同样问题，API `shutdown` 的 `catch` 则直接吞掉 Docker 错误。

- 新增 `ref_state <ref>`：先 `docker info` 确认 daemon 可应答；应答后 `docker inspect --type container` 才作为存在性判据。三种结果显式区分：present / 证明不存在 / **查询不可用（未知）**。
- `remove_owned` 只有在 ① daemon 应答且句柄不存在，或 ② 精确句柄删除后再次核验不存在 时返回 0。
- 删除绑定到 `docker inspect --format '{{.Id}} {{index .Config.Labels "slide.max238.owner"}}'` 得到的**确切容器 ID**，标签不等于本次 nonce 即拒绝；`docker rm -f` 作用在该 ID 上，不会误删同前缀的并行资源。
- 删除命令失败后再查一次：仅当 daemon 应答且该 ID 已不存在（并发删除）才视为成功，否则打印 `FAILED to remove` 并返回非零。
- 删除后核验无法完成（daemon 又不可达）→ `FAILED to verify removal`，非零。
- 启动阶段的同名检查与残留列表同样经过 `ref_state`/显式失败，不按前缀清扫。

## 2. 运行期句柄：不再从端口上的 API 猜身份

- launcher 在 `docker run` **之前**写 handle 文件（默认 `frontend/e2e/.max238-handle-<api_port>.json`，可由 `MAX238_HANDLE_FILE` 覆盖），记录 nonce、容器名、owner 标签、API/MySQL 端口、launcher PID、cwd、命令、harness 路径、仓库 SHA、句柄文件路径与日志归属；拿到 MySQL 端口后再补写一次。
- 启动 stderr 同步输出 `handle=… nonce=… container=… pid=… cwd=… command=… sha=… api=… logs=…`，形成 PID→端口→cwd→命令→SHA→日志/句柄的可追溯链。
- `--cleanup-handle <file> [--api-url <url>]` 用 handle 文件定位本次资源；API 可达时读取 `/__test/handle` 只做**核对**，不一致打印 `ANOMALY` 并仍只清理 handle 文件里的确切句柄，退出非零。API 不可达时记录并继续用 handle 文件。文件缺失/不可读 → 非零，不猜。
- 浏览器 spec 的 `afterAll` 改为调用 `--cleanup-handle`，不再从当前端口的 API 取 nonce；失败会抛出，套件失败而不是静默通过。
- API server 的 `shutdown` 不再自己 `inspect`/`rm` 后吞异常，而是调用同一个 `--cleanup`，失败时打印精确处置命令并 `process.exit(1)`。
- 正常退出路径：删除成功后删除 handle 文件；失败路径保留 handle 文件作为可执行处置句柄。

## 3. 验证

### 受控故障注入（不碰真实外部容器）

`bash frontend/e2e/max238-fixture-cleanup.test.sh`：用临时目录里的假 `docker`（和假 `curl`）替换真实命令，**31 项断言全部通过、0 失败**。覆盖：

| 场景 | 期望 | 结果 |
| --- | --- | --- |
| 正常删除自有句柄 | exit 0，容器消失 | 通过 |
| 已删除句柄再次清理（真实不存在幂等） | exit 0，`verified absent` | 通过 |
| 错误 owner | exit 1，容器存活 | 通过 |
| daemon 不可达 | exit 1，`docker daemon unavailable`，容器存活 | 通过 |
| 删除命令失败 | exit 1，`FAILED to remove`，容器存活 | 通过 |
| 删除后核验失败 | exit 1，`FAILED to verify removal` | 通过 |
| 同前缀并行资源 | 只删自己的，邻居存活 | 通过 |
| handle 文件 + API 不可达 | exit 0，按运行期句柄删除，文件删除 | 通过 |
| handle 文件 + API 一致 | exit 0 | 通过 |
| handle 文件 + API 报告别的句柄 | exit 1，`ANOMALY`，仍只删自己的 | 通过 |
| handle 文件缺失/损坏 | exit 1，不猜 | 通过 |

### 真实 Docker（本运行自己的 `mysql:8.4`，非 3306）

- 完整浏览器套件：`npx playwright test --config playwright.MAX-238.config.ts` → **4 passed**（chromium，真实组件→Vite 代理→真实 Fastify→一次性 MySQL journal）。启动容器 `max238-e2e-20261028T170419Z-65773-1692911137`，MySQL `127.0.0.1:59540`；`afterAll` 输出删除的确切 ID 与 owner；结束后无残留容器、无 handle 文件。
- 真实不存在幂等：套件结束后用同一句柄执行 `--cleanup` → exit 0，`verified absent`。
- 真实错误 owner：`docker create` 两个带标签容器，用错误 nonce 清理 → exit 1，`refusing to remove`，两者均存活；用正确 nonce 清理 → exit 0，删除的是上一步 inspect 得到的 ID；同前缀邻居存活，随后按自身 nonce 删除；最终无残留。
- API `shutdown` 正常路径：独立启动 launcher（API `51849`，MySQL `59712`），向 fixture server 发 SIGTERM → server 调用 `--cleanup` 输出 `removed … (id … owner …)` 并 exit 0；launcher trap 随后 `verified absent`，launcher exit 0，handle 文件删除，无残留。
- API `shutdown` 失败事实：用受控 `docker` 包装器（先委托真实 docker，出现标记后模拟 daemon 不可达）启动同一 launcher（API `51850`，MySQL `59736`），就绪后创建标记再 SIGTERM server → server 记录 `cleanup … failed with 1` 并 exit 1，launcher exit 1，handle 文件保留，真实容器仍在（随后用真实 docker 按句柄删除）。证明“未知”不会被当成已删除。

### 门禁

| 检查 | 结果 |
| --- | --- |
| `bash -n`（harness 与回归脚本） | 退出 0 |
| `frontend/e2e/max238-fixture-cleanup.test.sh` | 31 passed / 0 failed |
| API `tsc --noEmit` | 退出 0 |
| 前端 `tsc --noEmit` | 退出 0 |
| `pnpm contracts:check` | 退出 0（公开契约未变） |
| Playwright MAX-238 | 4 passed |

R3 已接受的 vitest 结果、公开入口撤权、policy/config 模块与 bulk/rollout 结果未变，本包不重跑全量。

## 4. 未覆盖与限制

- 只改 fixture/harness 生命周期与证据；生产协议、DB、模块与前端行为未变，不重新声明 R3 已接受的生产结论。
- 试采边界仍是受控 fixture，认证是固定 fixture admin；不证明真实登录、真实目标、真实采集或正式 history/event 链。
- 受控故障注入证明的是脚本判定与退出码；真实 daemon 不可达、删除失败、删除后核验失败使用同一代码路径，但未通过真实停止 Docker 服务复现（不操作本机 daemon）。
- 未在提交瞬间 kill 进程；不声称远程 exactly-once。
- 未合并、未部署；整单未验收。

## 5. 安全 PR

草稿 PR：https://github.com/max2055/Slide/pull/567，发布分支 `agent/15coder1/max-238-release`，从已审干净 head `c811e593966d63550e93552f2e93c5db19654c1d` 追加本包最小差异（排除 `CLAUDE.md` 与 `attachments/`）。未合并、未部署。
