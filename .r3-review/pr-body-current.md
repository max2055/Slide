## MAX238-NATIVE-CONFIGURATION-FLOW-R2 — 完整首次配置与恢复

**状态**：R1 未整体接受；R2 正常首绑证据保留；Chief独立复核仍有缺陷，完整用户流程尚未接受，继续R3修正。MAX238 整单保持 `in_progress`，`done` 留成员。此前已接受的 78602 s 真实采集/正式历史链未重跑、未改。

### 提交与发布边界

- 任务分支 `agent/15coder1/max-238`（只追加，基点 `61c8c0822`）：
  - `88ba9a61b` 实现 + 测试
  - `634e67a94` 真实证据/文档
- 本 PR 从已审安全头 `61ef21989` 独立追加为 **`6aa984f22`**（parent `61ef21989`，fast-forward）；未推送任务历史或风险祖先，未改写任务分支，未 watch/merge/deploy。
- 变更范围：29 路径（9 新增 / 20 修改）。新增对象：migration 136、能力证据模块与测试、probe 接线测试、真实首绑集成测试、首绑浏览器证据（json/mjs/md/png）。依赖未新增。对新增/修改差异做了常见秘密模式（private key、GitHub/AWS/OpenAI token、JWT）扫描，0 命中；这是模式扫描，不宣称绝对无秘密。

### 首次配置缺口（内部实现，已不再需要成员决策）

R1 的真实缺口是“未绑定资源没有任何 capability 生产者”。现在实现真实只读探测 → 严格可信证据 → 原有 preview/trial → 现有 host 同事务首次绑定 revision 1：

- `POST /api/metrics/template-bindings/:type/:id/probe` 仅对未绑定资源开放；只对固定 pin 中已注册实现、可信适用目标执行有界只读读取，客户端不能自报 supported。
- 新表 `metric_capability_evidence` 一行绑定资源、base revision、固定 pin + content hash、credential reference、候选意图 digest；跨资源/凭据/pin/revision/编辑草稿与过期证据均拒绝复用；损坏证据是拒绝，不当作 absent；全 unknown 不落证据。
- 首绑 INSERT 现在保存本次启用实际使用的可信能力事实（不再写 `[]`）；后续 preview/status/replay 从同一事实解析。
- 显式停用指标不再被当作必要项；停用项的合成时钟 capability 从 resolution identity 排除（不影响可采集/阻塞项），修复 trial→apply 身份漂移。
- 未放松 activate 必要谓词/名单、receipt v2 codec，未新增第二 binding/policy/audit writer。

### 恢复与新意图

- sessionStorage 写入失败（QuotaExceeded）：同一标签页内存副本保留精确 intent key，`reloadAll` 不再被空存储清成 0；界面明确“仅当前标签页可查询、浏览器页面刷新后无法恢复”；存储结构损坏是显式错误并阻止无跟踪写请求。
- preview 在途修改 interval：响应只在原 generation + 原草稿版本成立时投影，旧响应不能清掉失效状态或令 `trialReady=true`；旧 intent 的 journal 结算与当前编辑分开。

### 真实证据

一次性 MySQL 8.4，容器 ID `4f3f4c42a14b2f1369a68eca33a4cf7774facf31c10ad2c9f6f198fb4b99226c`、标签 `max238.r2.run=97ab3159ac67`、`127.0.0.1:13421`（非 3306）；平台库 `max238_flow`，只读目标独立 schema（仅 SELECT + PROCESS）；真实 Fastify 3001 + 真实 Vite 5173。

- **真实浏览器**（Lit → Fastify → DB）：未绑定资源 0 证据/0 binding → 检查配置触发 `/probe` 200（证据 1 行，binding 不变）→ preview `executable=true` revision 0 → 试采通过 → 首次绑定并启用 `committed` revision 1，operation/audit 各 1，读回 pin/version/hash 一致。截图与 JSON 见 `docs/slide/development/MAX-238/first-binding-20261030/`。
- **真实 API 集成**（`first-binding.real.test.ts`，3 passed）：首次绑定全链；并发两次首绑只 1 个 committed、1 个 409、operation/audit 各 +1；错误凭据 probe 422 且 0 证据/0 binding；group + 显式 enable + 指标停用 + 模板参数 + 固定 pin 的无损 roundtrip 与 replay。

### 门禁

- 后端 `src/metrics` 全量：**907 passed / 210 skipped**；`{bindings,templates,config}`：**525 passed / 92 skipped**
- 前端全量：**1348 passed / 150 files**
- 双端 typecheck、`pnpm contracts:check`、前端 build + CSP：通过
- 浏览器 `resource-metrics.spec.ts`（audit config）：**23 passed**；原先 :302 等待旧“检查并启用”超时，按真实 binding-source 契约修正夹具，未删断言/skip
- 测试资源严格生命周期：唯一容器名/标签/nonce + 精确 ID；只 kill 记录的精确 PID；清理前核所有权，删除后 inspect 明确 `no such object`；无按端口/名称批量扫描；临时凭据目录已删除

### CI 事实与限制

- 推送后一次快照：仅 `plan` pending（新 run 刚创建），**不声称全绿**，未 watch。
- 浏览器首绑场景覆盖固定 pin + 默认配置；group/显式启用/指标停用/模板参数的完整无损 roundtrip 由真实 API+DB 集成测试覆盖。
- 未启动正式采集调度/生产 worker，未做 24h 历史、容量/迁移演练、部署或共享 3306 写入；MAX240 query/storage/formal-store 未触碰。

🤖 Generated with [Claude Code](https://claude.com/claude-code)

### Chief准确R2复核

独立后端相关54/54、准确源码双端typecheck/contracts通过；真实MySQL原3项首绑/并发/无损API测试通过。新增反例：过期证据同配置probe返回503；证据读回边界撤权后公开probe仍200且实际存1行；持久意图写失败仍apply；旧committed查询吞新草稿。组件18pass/2fail，真实DB3pass/2fail。R2未整体接受，R3由同15coder1修完整业务链。实际撤权注入的是可信reload边界，DB写入/回读真实；组件反例HTTP受控，不称浏览器/生产故障。浏览器首绑正常证据可保留，故障恢复矩阵待补。

本轮独立核29路径逐blob与634e67a94一致、全部56新增对象，所查秘密模式0命中，无新增依赖，原风险任务源非祖先。准确安全head6aa984f22/draft/main不变。本轮一次CI快照12success16in_progress，非全绿，未watch/merge/deploy。

