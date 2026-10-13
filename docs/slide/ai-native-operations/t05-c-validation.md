# T05-C 观察幂等与失败分类验收

2026-10-13，MAX-147。仅修复父确认的 T06 观察阻塞；PR153/158 及其已合并验收历史不变。无生产操作、迁移、外部模型请求、前端产品修改或子代理。

## 行为与边界

- `appendObservation` 的内容身份仅排除服务分配的外层 `sequence` 与 Parts 内层 `payload.sequence`。A→B→A 回到原 source/hash 时返回原持久序号，零新增；实际 Parts/时间/内容变化仍拒绝并回滚。未重写历史事件或 source checkpoint。
- Watch 初次建立及 live tick 的授权拒绝与基础设施错误分开处理：真实撤权继续 4001；存储失败清除 watch、关闭为 1011并记录无敏感内容的诊断，重连从持久快照恢复。没有放宽实时主体、成员、Profile或全资源权限；连接断开不取消 Run。
- 同秒多个 Run 的最新状态按原 request 的 `accepted_version` 排序，再取 Run 时刻/ID。原 HTTP 派生段继续消费 snapshot 顺序；无需修改 routes，也不使用最新成果版本推导 Run 状态。
- 唯一 Run/执行 owner、锁序、事务、取消/unknown、预算收据与公开事件 schema 不变。暂借 DirectAdapter 的观察关闭接入点已归还。

## RED/GREEN

使用独立 loopback mysql:8.4（本次端口52742）、随机 test schema、正式 MigrationRunner、真实授权/事务及实际JWT/HTTP/WS，Provider/工具均为现有本地合成夹具。

三个正式反例在修复前均失败：

1. 原 production captureCanonicalDocument A→B→A：`IDEMPOTENCY_PAYLOAD_MISMATCH`。
2. 两个同秒 Run、反向字典序ID：HTTP显示旧 `failed`，应为新 `cancelled`。
3. SQL trigger 注入观察写入失败：授权有效的实际 WS 关闭4001，应为1011。

同一 focused 目标修复后3/3通过。RED/GREEN 的27个未选中测试仅是 focused 选择，不是完整验收skip。后续正式观察模块30/30、0skip，补充覆盖初次watch存储失败零敏感帧/无404伪撤权、移除SQL故障后重连恢复、再次真实资源撤权4001及Run仍running。

原序号重放零新增、非序号payload拒绝、重复snapshot/replay、重建store、retention source tombstone、未授权/read-share、多资源/成员/主体撤权、结果/引用与完成恢复沿既有模块验收。

## 模块与门禁

- 8文件真实MySQL/JWT/HTTP/WS/Chromium/SIGKILL完成恢复模块：237 passed、0 skipped。最后仅增强观察测试，重新运行其30/30；其余207项源码/配置未变，复用同次模块证据。集合重叠，不累加。
- `security:agent`：17文件187 passed、0 skipped；API typecheck、contracts:check、qualification:matrix（37/37）、秘密扫描、diff check通过；改动文件lint 2 warnings、0 errors。
- 独立 PR159 archive候选：完整前端/夹具/spec均与 `796af46c49dd0ef35c80bf0a11613fc3f556d258` 一致，只覆盖当前3个后端修复源码，使用相同lockfile/node_modules；关闭候选路径差异导致的pnpm自动重装检查，未安装或改依赖。原Chromium spec完整12项通过、0skip、无observationErrors，涵盖创建/取消/新Run/版本、普通Chat与转换、撤权清缓存、unknown零重发、分页/刷新/重连、1600/1024/390布局与键盘。
- 浏览器首次11/12通过：分页HTTP实际200并返回6个旧文档/nextBefore=null；初始快照与loadHistory竞态使前端contentEpoch变化，旧页响应被丢弃，游标仍21:0:21。完整原spec复测12/12通过，断言未改。此现有T06时序风险仍交父/T06，不能解释为稳定性缺口已关闭。初次失败日志保留，不隐藏。合成目标不能替代真实设备/付费Provider验收；原T04 5/6成功停发不变。
- 无前端或公开契约变更；完整V1 gate仍归T12。实测token/费用遥测不可用。

## 执行命令

```bash
AGENT_RUN_TEST_MYSQL_PORT=52742 AUTH_TEST_MYSQL_PORT=52742 T04_BROWSER_TEST=1 \
JWT_SECRET_KEY=<本地非生产夹具值> pnpm --filter slide-api exec vitest run \
  src/investigations/observation.mysql.test.ts src/investigations/routes.test.ts \
  src/adapter/__tests__/investigation-canonical.mysql.test.ts \
  src/investigations/execution-recovery.mysql.test.ts src/investigations/stream.test.ts \
  src/investigations/evidence-store.test.ts src/investigations/result-schema.test.ts \
  src/analysis/analysis-evidence-binding.test.ts
T06_TEST_MYSQL_PORT=52742 pnpm --config.verifyDepsBeforeRun=false \
  --filter slide-frontend exec playwright test e2e/investigation-workspace.spec.ts \
  --workers=1 --reporter=line
pnpm security:agent
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm qualification:matrix
pnpm security:scan
```

## 交付门禁

托管分支 `agent/15astra/max-147` 保留启动提交2668c8c7及历史，已普通merge最新main，未switch/reset/force。历史中含私有.multica材料及旧非产品产物，不能随新PR发布；从最新main的tree构建仅含本次4个源码/测试文件和本报告的交付commit，逐文件SHA-256必须与托管源码相同。此方法不切换当前托管分支、不重写原历史。父独立Review、准确head CI、普通merge/main核验齐备前保持in_review，不释放T06或后续stage。
