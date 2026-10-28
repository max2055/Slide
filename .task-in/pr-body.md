草稿 PR，用于让 MAX-238 的代码具备可审阅的发布历史。**R3 公开 keyed 授权/协议与 R5 fixture 清理判定为有界接受；R4 未被接受且已被 R5 取代；MAX-238 整单未完成**，请勿据此合并或部署。

## 内容

从 `origin/main`（`e11f6ba2e`）干净基线构造的独立提交链，包含任务分支 `agent/15coder1/max-238` 上已交付的 MAX-238 内部模块、键控应用/操作协议、迁移、测试与证据文档。

- 提交 1（`665bd7e8a`）：干净基线的完整 MAX-238 能力。
- 提交 2（`c811e5939`）：R3 修正——公开 policy 入口锁后实时授权、fixture 所有权清理、conflict-cas 测试定位修复与证据。
- 提交 3（`0bbdeaf4d`）：R4 修正——清理失败不再假报成功：`present / 证明不存在 / 未知` 三态、运行期句柄文件、API 只做核对、API `shutdown` 与 `afterAll` 共用同一清理（该契约未被接受）。
- 提交 4（`74115f22f`）：R5 修正——`docker info` 成功后的 `inspect` 报错不再等于“容器不存在”；只有 Docker 自己的 not-found 答复才允许报成功，其余为 UNKNOWN（非零、保留句柄与处置文件）；四条独立反例进受控回归，并把该回归接入现有 frontend CI job。
- 提交 5（`a8d89698a`）：ROLLOUT-CONTRACT-REGRESSION——`coordinator.mysql.test.ts` / `portfolio.mysql.test.ts` 的稀疏 binding fixture 改为真实 resolver 产出的完整 `Published` 经真实 store 写入，观察值使用真实 pin，portfolio 应用状态走 `reportApplied`；新增一次性库契约回归，证明 legacy 无 envelope、显式 `package-v1`、applied/effective 快照可由同一严格读者读回，损坏/拼接/未知 envelope/模板行仍被拒。未改生产 codec、路由、调度器、worker 或迁移。
- 排除 `CLAUDE.md`（工作区运行规则）与 `attachments/`（协调交接材料），不含任何 qualification 运行快照或原分支风险祖先。

## 主要能力（均为内部/未挂载或已受控挂载，不等于生产验收）

- 固定模板绑定预检、release 编译、事务守卫、多模板参数/策略解析、原子事务适配核心、严格 payload codec、共享读者 fence、离线 v2 trial receipt。
- 客户端 operation key：意图摘要、`pending`/`committed` 生命周期、同事务提交、丢失响应恢复、未知结果保守保留。
- 授权边界：admission/连接/行锁等待后重新读取实时主体并再次授权；R3 起覆盖全部公开 policy 路由（binding/effective/audit/preview/publish 与 group 入口），会话撤销为 401、权限撤销为 403，且不产生任何写入或试采。
- 浏览器 fixture：每次运行唯一 nonce + 所有权标签，只删除自己确切句柄；其他同前缀运行仅记录，不扫描删除。清理只有在 daemon 明确答复“该确切句柄不存在”时才报成功。

## 验证（详见 `docs/slide/development/MAX-238/` 下 R3/R5 与 `rollout-contract-20261029` 证据；R4 证据文档只在任务分支，不在本 PR 树内）

- R3 聚焦：policy 路由 13 passed（含公开 publish 锁后撤权反例）；R3 一次性 MySQL 4 passed。
- 模块：`metrics/config` + `metrics/policy`（真实迁移、一次性 MySQL）212 passed / 12 skipped；bulk/rollout 33 passed / 36 skipped。
- API/前端 typecheck、`contracts:check` 均通过（公开契约未变）。
- Playwright MAX-238：4 passed（其中 2 项为真实组件 + 真实 Fastify API + 一次性 MySQL journal），容器按所有权标签清理。
- 受控清理回归：`bash frontend/e2e/max238-fixture-cleanup.test.sh` → 47 passed / 0 failed（假 docker/curl，不连接真实 daemon），覆盖正常删除、真实不存在幂等、错误 owner、daemon 不可达、删除失败、删除后核验失败、`info` 成功但 `inspect` 报错（初查/删除后/删除失败后/handle 文件）、同前缀并行邻居、handle 文件缺失/损坏/一致/不一致。该步骤已接入现有 `frontend` CI job。
- 真实 Docker：不存在句柄 `--cleanup` → exit 0 `verified absent`；错误 owner → exit 1 且容器存活；正确 owner → 删除确切 ID；再次清理 → exit 0；无残留。真实 daemon 的 not-found 文本已核对为 `Error response from daemon: No such container: <name>`。
- ROLLOUT-CONTRACT-REGRESSION（提交 5，一次性 MySQL 8.4.10，非 3306）：同一命令下 `coordinator` 3 项与 `portfolio` 1 项由红转绿，合计 3 files / 6 tests passed。真实 `PolicyService.changeBinding` 写出的行被同一 codec 接受，证明原失败是测试造了不存在的存储形态。`metrics/rollout` + `metrics/bindings` + `metrics/policy` 回归 425 passed / 1 skipped；唯一失败是 `policy/store.mysql.test.ts` 首例并行负载下 5 秒超时，单独重跑 9 passed，与本包无关。`tsc --noEmit` 无输出。

- ROLLOUT-CONTRACT-REGRESSION-R1（提交 6）：公开路径静态 manifest 补上已注册的 `GET /api/metrics/config/resources/{type}/{id}/operations/{key}`（排序位于 `/migration` 与 `/recommendations` 之间），口径 99 条与生成物一致；新增最小断言固定 operationId、bearer security、`type`/`id`/`key` 参数、`MetricOperationState` 响应与 400/401/403/404/503 文档集合。`public-api.test.ts` 由 9 passed / 1 failed 转为 10 passed / 0 failed；`contracts:check`、`tsc --noEmit` exit 0；相关 `metrics/config` routes、metrics contracts、status、idempotency-R2 87 passed。本提交只改测试，生成物无漂移。

## 已知未通过/未解决

- 提交 5 的 CI 结果未采集（本包未重跑或 watch CI，不把旧的 4 项失败当作已全绿）；本地一次性库证据见 `docs/slide/development/MAX-238/rollout-contract-20261029.json`。
- 受控替身不是真实 daemon 故障：真实断连/超时/服务端错误未在本机复现（未操作本机 daemon）。

## 边界与未完成

- 试采边界在浏览器/HTTP 测试中是受控 fixture；认证为固定 fixture admin，不连接真实目标，不证明真实采集、正式历史、告警或生产发布。
- “等待锁”由 store admission gate 模拟，未做生产规模并发压测；未在提交瞬间 kill 进程，不声称远程 exactly-once。
- 真实消费者依赖、最终整合 gate、真机闭环与生产操作限制仍未关闭；`activate` 原谓词与必要项名单未变。
- 未改激活谓词、必要项名单、调度器、worker 与部署；未合并、未部署。

🤖 Generated with [Claude Code](https://claude.com/claude-code)

