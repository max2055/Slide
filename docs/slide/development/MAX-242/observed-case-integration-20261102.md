# 实际观测到案例授权检索：集成验收

本阶段接续已接受的原记录提醒，不重做原型。工作分支 `agent/15coder1/max-242` 保留起点 `fcdd368880e18409f0a8e83bdfc53a53810fa3f7`，只追加提交。候选源码 `b7e9c89b7c4184c706ce67f25aef8ee90e2ee0f6`。本轮仅调整集成测试及契约断言，未放宽任何生产来源资格、恢复窗口、权限或独立审核规则。

## 原两项 gate 失败的根因

1. `operations/baselines/baselines.mysql.test.ts`：实际测试服务器为 MySQL 8.4，绑定的 `mysql-basic@2.0.0` 只审定 9.6。调度正确拒绝不适用来源，所以 SQL 读取为 0。仓库现有 `scripts/qualification/run-investigation-rollout.sh` 已为 Operations 单独启动 9.6；本轮复用它，没有扩大采集包适用版本、伪造 VERSION 或改低读取断言。测试新增实际服务器版本前置断言，真实 9.6.0 上固定 SQL 读取 4 次、正式发布 3 条。短观测仍为 `unknown/long_gap`，不冒充长周期基线资格。
2. `operations/composition.mysql.test.ts`：夹具只 UPDATE 调查为 `closed/resolved`，未留下关闭反馈及验证。B1 后的生产适配器正确返回 422。保留该来源拒绝并验证没有案例入库；之后通过真实 JWT/HTTP 关闭接口绑定确切结果、验证窗口及证据，再创建候选、提交、由不同成员审核和授权读取。合成结果及人工核对记录不计真实 Provider 资格。

完整后端回归另外暴露同项契约测试漏列四个已实现接口：`retest`、`scope`、`workflow`、`knowledge/prepare`。补齐固定路径清单，仍使用完整精确相等断言；生成文件与生产接口均不变。修订后 12 项契约测试及 `contracts:check` 通过。

## 完整本地业务流程

使用本任务独占 MySQL 8.4、隔离 schema、实际生产 `server.ts`、密码登录/JWT、HTTP/WS 与 Chromium。显式开启 35 个本地客户端，实际读取 `Threads_connected` 并正式发布观测；原规则开事件，进入原调查确认范围。后续实际读数分别支持未改善、证据不足、恢复，保留关联范围缺口及 B1 新旧窗口拒绝。

人工选择当前恢复证据关闭调查，核对原交接摘要，从确切结果整理并脱敏案例，作者自审被拒。独立成员登录后审核发布，使用产品列表搜索同一案例。检索和正文均不含合成敏感标记；移除来源调查成员后计数从 1 变 0，详情只剩 `source_unavailable` 元数据；恢复原授权后重新可见。当前恢复证据过期同样清除检索结果和正文，恢复有效证据后仅同一原案例重新可用。案例保持 `referenceOnly`，质量资格仍是 `not_qualified`。

这是真实自有数据库观测和正式持久化/权限/界面集成；基结果为明确声明的夹具，Provider 调用为 0，不代替固定受信目标行动效果或真实模型判断。

浏览器夹具修正两处并发问题：客户端 COM_QUIT 后等待实际连接数降到原阈值以下再读取恢复样本；撤权前按实时鉴权的 user-first 顺序持锁，避免夹具反序 JOIN DELETE 死锁。没有调整原恢复阈值、关闭订阅、重试业务提交或隐藏失败。最终整套 9/9 通过，保留此前失败的诊断记录。

## 验证

最终候选完整后端 gate 已通过：630 文件中 590 通过、40 按条件跳过；6,179 项通过、212 跳过、0 失败。使用现有 `run-investigation-rollout.sh --api`，953.76 秒，两个脚本自有 MySQL 8.4/9.6 均由退出清理销毁。原两项失败在完整候选中均通过。跳过专项不计为已验证能力，交付摘要逐文件保留跳过项；独立端口的 B1/反馈等受影响检查由下述 focused 验证补充。

已完成：相关后端 94 项（66 项 Operations + 28 项反馈/恢复；不重复累计 focused 子集）；前端 1,498 项；Agent Core 774 项；浏览器 9 场景；两端 typecheck、契约生成一致性、前端 build/CSP、秘密扫描。浏览器覆盖 1440×900、1366×768、1920×1080、键盘焦点、保存竞态、范围提交未知核对、原记录刷新、独立审核、撤权和证据过期。原提醒独立审批浏览器 1 项源码未变，复用上一已接受阶段证据，不计为本轮新跑。

复现使用仓库声明的 pnpm 11.19.0，禁止把下列端口变量指向共享 3306：

```bash
# 脚本自建并销毁隔离 MySQL 8.4 / Operations 9.6，启用完整后端回归。
T12_OUTPUT_DIR=<统一outputs下的独立目录> bash scripts/qualification/run-investigation-rollout.sh --api

# 自有 MySQL 9.6；P04_REAL_REPORT 可输出实际 VERSION/4 次 SQL/3 条发布。
OPERATIONS_TEST_MYSQL_PORT=<自有9.6端口> pnpm --filter slide-api exec vitest run \
  src/operations/baselines/baselines.mysql.test.ts src/operations/composition.mysql.test.ts \
  src/operations/knowledge --maxWorkers=1

# 自有数据库与空闲 API/WS 端口；spec 自建 schema、真实服务和 Vite 并收尾。
MAX242_TEST_MYSQL_PORT=<自有8.4端口> MAX242_TEST_API_PORT=<空闲端口> \
MAX242_TEST_WS_PORT=<空闲端口> MAX242_BROWSER_OUTPUT=<统一outputs下的独立目录> \
  pnpm --filter slide-frontend exec playwright test --config playwright.max242.config.ts
```

历史首轮全量：6,178 通过、1 失败、212 跳过（630 文件：589 通过、1 失败、40 跳过）。唯一失败就是本记录说明的四接口契约清单遗漏，已定位并通过 12 项 focused 回归；本轮保留原失败统计，不把它覆盖为通过。最终候选另行启动同一完整 gate，结果独立记录。

原业务验收独占数据库 `127.0.0.1:58071`（8.4）、`58236`（9.6），真实 API/WS `64526/64527` 均已收尾；先核对任务标签和端口后停止并删除两个自建容器。未停止其他任务或共享服务。原运行时 `AGENTS.md` 修改保留，未纳入提交。

## 完整范围与未完成项

本记录追加在既有 `original-attention-20261102.md`、`original-record-workflow-20261102.md`、`b1-recovery-chronology-20261102.md` 和 `acceptance-matrix.md` 之后。原六项验收、四标准和 A01–A22 全部保留，整单不标 done。本阶段补齐无行动实际观测→关闭→案例独立审核/授权检索证据，不宣称真实 Provider→独立审批→固定目标执行→实际效果三结论及完整失败链已通过。

模型发送仍由 Chief 协调 Max/计量 owner 恢复权威累计账本、预留及未知结算、发送者授权和 Provider/场景路由；实际遥测不可用，不编造 token/费用，不重置 1,000 万累计授权。受信目标行动仍由 Chief 协调 Max/环境 owner 完成 `192.168.49.130` 的签名试点、SSH、verifier、health 接线。发布祖先安全例外仍待 Max；未 push，未另建分支或 PR。

PR #572 仍 OPEN，头 `f505474bd810f8a1f0ae696e051d4a06d2f0ea9f`，不是本轮候选，无当前源码远端 CI。所有发布包及校验和存放于统一 outputs 目录，通过 Multica 附件交付；不把本机路径作为可访问交付物。未写共享 3306、部署、实际解绑、外发通知、启动子代理或新增回调/巡检。原唯一终态订阅保留。
