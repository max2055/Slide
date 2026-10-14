# T10 资源告警与业务入口实施计划

> **Execution:** 在已批准 V1.1 / MAX-152 范围内继续实施；无子代理。

**Goal:** 三类资源从告警进入同一调查并保留观测事实与实时权限边界。

**Architecture:** 扩展 T08 已接受的持久 alert owner 桥，不另建执行栈。服务器和网络沿相同锁、lane、admission 与旧 Analysis 兼容边界；业务页按 ResourceRef 筛选已有调查，调查可返回原资源。

**Tech Stack:** Fastify、TypeScript、MySQL、Lit、JWT、WebSocket、Playwright Chromium。

## 已接受基线与范围

main 16c9b572；PR166 的网络质量/this 基线修复已父独立验收。保留 AGENTS/private 文件；不改 T09/source、T11 评估功能，不启用生产触发。

## 1. 统一资源桥

修改 alert-bridge.ts、bridge-flags.ts、alert-rca-service.ts、ai-agent-bridge.ts；新增 investigations/resource-event-bridge.ts 和 resource-event-bridge.test.ts。验证 exactly-one ResourceRef、SQL 历史复用、flag rollback 不换 owner、网络旧分析主体正确、服务权限撤销拒绝且不 fallback。沿正式隔离 MySQL 迁移两次运行，0 skip。

## 2. 观测事实

server-alert-evaluator.ts / network-devices/network-device-alert-evaluator.ts 持久原采集时间、窗口、质量、dimensions；没有采集时间保持 unknown，不补当前 good。消息冻结 metric/value/threshold/window/quality，缺指标不等于正常/宕机。自动事件使用可信观测上下文，通用事件默认行为不变。focused 验证未来/缺时间/无值/未知质量与网络 unreachable 的区别。

## 3. 资源 UI 与往返

复用 sharedBtnStyles / app-card，新增共享 resource-investigation-links，接入 instance-overview-tab/server-detail/network-device-detail；查询现有调查列表，不隐式调用模型。investigations 接收 resource 查询，investigation-detail 提供原资源链接。保留旧诊断入口。前端 typecheck/build，三类真实 JWT/HTTP/WS/Chromium 夹具逐类告警→调查→证据→新 Run→返回资源；同 JWT 撤权/全部 scope/深链拒绝。

## 4. 验收与交付

复用既有隔离 fixture/executor 和配置 Provider。实际模型发送前只读核验唯一 T09-System-V1 stopped 链及 ledger/claim/hash；通过 initializeSystemJournal 恢复，预留/实测结算，50/80/100 门禁。没有可靠计量不发送。运行受影响模块/security:agent/contracts 与 CI 最小装配；独立功能 PR，一次前台收集当前 head CI，产物输出至固定 outputs。完整 V1 gate 归 T12。完整验收后 in_review 交父独立 Review/普通 merge/main；中间交接明确 fullIssueDelivered=false 与实际接续谓词。
