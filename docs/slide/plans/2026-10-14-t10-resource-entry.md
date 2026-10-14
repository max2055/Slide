# T10 资源调查入口实施计划

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 数据库、服务器、网络告警共享唯一调查，携带原指标与时间窗口，并可从业务资源往返。

**Architecture:** 复用 T08 的持久 alert owner、T09 的 Event/Runtime 和实时全部 scope 授权。扩展 alert bridge 的资源判别及独立默认关闭的服务器/网络白名单；观测上下文留在持久快照和首条消息。业务页通过已有调查列表按资源过滤，打开已存在调查，不产生重复执行。

**Tech Stack:** Fastify / TypeScript / MySQL / Lit / Vitest / Playwright。

## 1. 有界基线修复

- 网络 evaluator 的 error 为采集失败，不是不可达；只有 online/unreachable 且 last_check_at 在五分钟内才能生成状态证据，保留原采集时间。缺失/过期状态不生成正常或宕机结论。
- 在 network-device-alert-evaluator.test.ts 加入 error、无时间、过期和真实不可达四个回归；先 RED，再最小修复 GREEN。
- 运行该 evaluator 与 collector 测试；提交独立基线修复 PR，准确 head CI 一次前台收集后交由父 Review。

## 2. 统一资源告警桥接

- resource-event-bridge.ts 判别唯一 instance/server/network_device；拒绝混合 ID、非法 ID 和不匹配 target_type。
- alert-bridge.ts 复用单 owner/锁/历史选择，扩展三类资源实时授权及自动服务边界；bridge-flags.ts 为 server/network 单独解析白名单，默认不开自动调查。
- alert-rca-service.ts 查询 network_device_id/tags，将三类资源送入同一桥接；ai-agent-bridge.ts 保留三类旧 RCA subject。
- evaluator 创建成功告警后仅在 opsAuto 开关启用时提交持久 admission；传递 collected_at/from/to/quality/reason/dimensions，不调用 Provider。
- resource-event-bridge.test.ts 用正式隔离 SQL/JWT/HTTP验证三类来源、重复 owner、撤权、白名单及网络缺指标；新功能先 RED 后 GREEN。

## 3. 资源导航及真实验收

- 共享 resource-investigation-links.ts / Lit 组件使用已有 investigation list resource 查询；资源页放置查看关联调查入口；investigation-detail.ts 给出原资源链接。旧诊断按钮保留。
- investigation-resource-links.spec.ts 使用隔离 MySQL、正式JWT/HTTP/WS/Worker/Chromium，三类持久夹具告警→调查→证据→追问→原资源，实时撤权和全部资源 scope 拒绝。
- 真实 Provider 只按唯一 T09-System-V1 持久账本链式恢复，原子预留与实测结算；先核验177603/129、停止/无pending与hash。没有可靠计量或配置时停止模型发送，明确阻塞，其余检查继续。

## 4. 交付

- focused/module：evaluator/bridge/authorization/legacy、frontend typecheck/build/contracts、安全门禁和浏览器。
- 完整 V1 总 gate 归 T12；CI 强制门禁不绕过。
- 独立功能 PR、准确 head CI 一次前台 collect、附件证据；in_review 给父独立验收，普通 merge/main 出口。
- 停止条件：未知模型发送、预算上限、生产环境误用或明确越权；保留检查点，不重放、不清账本。
