## MAX238-NATIVE-CONFIGURATION-FLOW-R3 — 探测可恢复、证据收尾授权、不可恢复写拒绝

**状态**：R1/R2 **未整体接受**；本轮修正 R2 复审列出的五条真实缺陷，并有真实 MySQL / Fastify / Chromium 证据。已接受的原生模板真实采集展示（78602 s）与 R2 安全证据保留、不重跑。MAX238 整单保持 `in_progress`，`done` 留成员。

### 提交与发布边界

- 任务分支 `agent/15coder1/max-238`（只追加，起点 `634e67a94`）：实现提交 **`5bb64673c`**。
- 本 PR 从安全头 `6aa984f22`（parent `61ef21989`）独立追加为 **`eb28fd0b7`**，fast-forward；未推送任务历史或风险祖先，未改写任务分支，未 watch/merge/deploy。
- 差异：**17 路径（8 新增 / 9 修改）**，全部属于 MAX238 配置链。新增对象：`bindings/target-identity.ts`、`testing/owned-fixture{,.test}.ts`、`r3-20261030/evidence.md`、`r3-browser/{flow.mjs,browser-evidence.json,2 png}`。**无新增迁移、无新增依赖、无新增路由/公开契约**。对新增/修改文本做了常见秘密模式（private key、GitHub/AWS/OpenAI token、password/secret/token 字面量、Bearer）扫描，0 命中；这是模式扫描，不宣称绝对无秘密。

### 本轮五条修正

1. **显式探测不再被旧证据挡住**：`probe` 以 recover 模式读证据，过期/损坏视为“重新真实探测”，存储错误仍然失败；随后重新执行有界只读读取并原子 upsert 同一身份。消费路径继续拒绝过期/损坏证据（503）。不改日期、不当 supported、不让用户改草稿绕过 key。
2. **证据事务收尾授权**：admission、连接/事务开始、UPSERT 行锁等待、SELECT 读回之后都在同一连接上重新读取 live 授权与资源关系，最后一读在 COMMIT 之前；拒绝即回滚、零行变化；COMMIT 失败是显式 `CAPABILITY_EVIDENCE_COMMIT_UNKNOWN`，不混成成功。
3. **证据复用身份**：key 现在包含精确目标 + 加密凭据版本指纹（`target_identity`）与探测主体（`actor_id`）；目标改写、凭据轮换、换主体都不能复用旧事实。`dependencyDigest` 同样纳入目标身份，trial→apply 之间依赖变化会被 receipt 拒绝。
4. **无持久意图不发写**：前端先把“主体 + 资源 + 意图 + key + 草稿版本”写入 sessionStorage，写成功才发 `/apply`；QuotaExceeded 等失败直接拒绝并保留草稿；任一坏条目整体判为损坏（不再静默过滤）；主体不可读时按本页隔离。内存只辅助当前 tab 查询，不冒充刷新恢复。
5. **旧意图查询不清新草稿**：`lookup` 以 intent 记录自身的草稿版本比较，查询前/查询中的新编辑都保留；旧 committed 只结算旧 key，不清 settings/parameters/dirty/preview，不把旧 revision 投影成新意图成功。另加测试资源所有权：run 随机 nonce + 先写 handle + 核验后 DROP，`first-binding.real.test.ts`/`seed.ts` 不再 DROP 固定/PID 名。

### 真实证据

- **真实 MySQL 8.4（非 3306，容器按 nonce 标签 + 精确 ID 管理）+ 真实 Fastify**：`first-binding.real.test.ts` **6 passed** —— 首次绑定全链；并发首绑 1 committed/1 409；失败探测 0 证据；**过期证据被重新探测替换**（preview 503 → probe 200 → 同一行替换 → executable）；**同一资源改写加密凭据后旧证据不被消费**（preview executable=false → 再探测 2 行）；**读回后撤权零行落库**（真实 writer：拒绝后 evidence_key 0 行，正常写 1 行）。
- **真实 Chromium 1440×900 → Vite → Fastify → 一次性库**（`docs/slide/development/MAX-238/r3-browser/`）：A. `/apply` 已到达服务器但响应被丢弃、恢复查询也不可用；写前 sessionStorage 已有 pending 意图（含 draft），**完整页面刷新**后 `unresolved=0`、binding `template/revision=1`、operations=1/audits=1（无重复）。B. `sessionStorage.setItem` 抛 QuotaExceeded：`/apply` 请求 **0**、页面显示拒绝、草稿保留；operations/audits 不增加。截图 `a-durable-refresh-1440.png`、`b-storage-refusal-1440.png`，机器证据 `browser-evidence.json`；复现脚本 `flow.mjs`。

### 门禁

- API `tsc --noEmit`：通过；后端 `src/metrics/{templates,bindings,policy}`：**495 passed / 47 skipped**
- 前端 `tsc --noEmit`：通过；受影响组件 `native-template-configuration.test.ts`：**22 passed**；全量 vitest：1351 passed / 1 failed（`metric-configuration.test.ts` 并发负载下 5s 超时，单跑 4/4 通过，未改该文件、未删断言/skip）
- `contracts:check`：通过；前端 build + CSP：通过

### CI 事实与限制

- 本次推送后一次快照：仅 `plan` pending（新 run 刚创建），**不声称全绿**；未 watch/merge/deploy。
- 一次性真实 API 会启动其内部指标调度器（一次性库、只读目标、未部署）；不构成生产 worker。
- 未启动正式采集调度、未做 24h 历史/容量/迁移演练、未写共享 3306；MAX240 query/storage/formal-store 未触碰。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
