# MAX-243 平台异常到原记录复测

本次复用已有 System composition、持久事件、唯一 Investigation/Session/Run 和环境开关，补齐显式只读草稿及无行动复测。不是整单验收通过声明。

## 依赖与交付边界

- 工作分支保留起点 `f85634140ea454c8826027bfb0f6cba02f4fe7fa`。
- 指定 MAX242 源码 `fbc3db9a9b00a2612234d97c1d6cd30d6ca9d89b` 经 `9932670a7` 合并；指定 MAX239 `82d0743206487fc7987ea8ebc45ca0f36284fca6` 经 `bea18cd76` 对齐。冲突保留242树中已集成245的发现、维护、通知和依赖处理，不覆盖为239旧树。
- 本项增量基线为 `bea18cd76`，只审阅其后的 allowlist patch；依赖合并不等于全部生产模块重新验收。AGENTS.md 既有本地改动不纳入提交。
- 未 push、未另建父链、未部署、未使用共享3306、未执行真实解绑或发送外部通知、无子代理。安全发布祖先例外仍交 Chief/Max 协调。

## 用户路径与契约

1. 平台状态 → 平台观测：读取已有运行信号、队列快照和部署版本。`system` 返回同一 composition 的异常采集/自动分析配置值、当前实例安装生效值、进程 publisher 统计和历史持久事件/派发/Run 时间。正式采集器已有 `metrics` 信号也纳入展示。
2. 两个开关仍来自 `INVESTIGATION_SYSTEM_EVENTS_ENABLED` / `INVESTIGATION_SYSTEM_AUTO_ENABLED`；保存部署环境后重启实例才生效。不增加配置写入口、第二套开关或热应用承诺。采集关闭、缺信号、读取失败均未知；历史成功和自检不证明当前健康。
3. 事件中心 → 平台异常：GET 只读原始持久事实。显式 POST `system-events/:id/investigation` 复用现有 create-key 与唯一事件关联，创建用户自己的 System 草稿及 Session；不创建请求/Run、不入调查队列、不调用模型。已有调查须原 ACL 允许读取，否则404；不自动分享服务身份调查、不复制一个平行调查绕过权限。
4. 工作空间 → 原平台异常与恢复验证：GET `investigations/:id/platform-events` 返回原事件、故障部署、固定返回位置和最近20次不可变复测。原始事件的自动派发决策保持不变；草稿关联通过现有 event link 可回到事件中心。
5. 显式 POST `system-events/:id/verifications` 只接收 Investigation ID、expectedVersion 与幂等键。服务端读取故障之后的安全观测，不重放 URL、不执行修复、不调用模型。允许在没有分析结果、没有行动的情况下验证。
6. 同调用位置、同原部署、同原请求范围、故障之后且五分钟内的成功信号，在日志窗口完整时支持恢复；后续失败为未改善。请求范围仅支持已匹配路由、无请求体的 GET/HEAD，使用当前进程随机密钥对方法、原请求目标、全部请求头和已解析用户标识计算 HMAC；只保留摘要，不记录原始 URL、参数或凭据。复测通过原事件 correlationId 定位唯一失败日志的摘要，再匹配后续观测；不同对象、查询或调用身份不得交叉恢复。请求头变化也会保守地不匹配。旧记录缺原请求日志/摘要、非只读请求、关闭、缺版本、版本变化、未知结果、读取异常、重启缺口、截断或超过一小时保留均为证据不足。当前 collector/queue/agent 无此请求范围证据，只能不足，不能用一般成功或启动事件代替。
7. 新迁移148只增加不可变复测证据表，保存原异常/hash、部署、窗口、观测、操作者与回执。复测、原 Investigation problem_status/revision 和 stream 审计同事务；不修改机器结果或原故障事实。调查 lifecycle 与 Run 状态保持各自所有者。

## 安全与一致性

- 每次读取/写入实时验证 JWT、System profile、chat/config 权限与成员角色。复测额外要求 operator、精确原事件链接、当前 revision、无活动请求和开放调查；资源 profile/跨域证据不得转入平台取证。
- 原持久事实的 hash/source/sourceEventId 必须匹配；VARBINARY 按 UTF-8 值比较。真实 SQL 链路曾发现 Buffer/字符串直接比较问题，已修复并固化回归。
- 源码工具保持原实现：只检查故障部署签名快照，缺版本/不一致保留 gap，不读取 main 代替。
- 同键同命令回读原回执；同键异命令或旧版本409；网络未知保留原键重试。异常原记录和历次分析不因恢复删除。
- 页面断线禁用复测；权限撤回/会话失效清除已显示事实并丢弃迟到响应。GET 不创建记录或模型调用。
- R2：调查切换、卸载或权限失效会使旧请求代次失效；复测成功、拒绝、网络失败及 finally 均核对所属调查和代次。新调查重新加载会释放旧忙碌状态；旧回执不能清空新事实、重试键或新复测的忙碌状态。同调查未知回执仍用原键重试。

## 可复现验证入口

```bash
# 自有 Docker MySQL，正式迁移执行两次，JWT/真实HTTP/Chromium，无外部模型
bash scripts/qualification/run-investigation-system.sh --platform
# 原有自动事件/预算/执行器/签名源码路径；Provider 为受控实现
bash scripts/qualification/run-investigation-system.sh
# System持久化、恢复、权限与版本工具原有真实MySQL回归；自行创建/清理容器
pnpm --filter slide-api exec vitest run src/investigations/system-event-bridge.mysql.test.ts
# 新增恢复判定与VARBINARY/权限回归
pnpm --filter slide-api exec vitest run src/platform/platform-recovery.test.ts src/investigations/system-event-workflow.test.ts
# Chief R1真实HTTP对象/查询/调用身份边界与R2组件迟到回执矩阵
pnpm --filter slide-api exec vitest run src/platform/chief-recovery.test.ts
pnpm --filter slide-frontend exec vitest run src/app/ui/components/system-investigation-facts.test.ts
```

浏览器新链路覆盖503→持久异常→键盘打开草稿→无模型读事实→未改善/不足/恢复→原记录状态与历史→重载/返回→撤权；包含浏览器连接中断后原幂等键重试、版本冲突、他人调查不可访问、资源域拒绝、viewer 禁止复测、三桌面尺寸和零产品 Provider 发送断言。运行证据、日志、截图、命令与哈希随任务附件交付；单测和受控 Provider 结果不冒称生产验收。

## 未完成与恢复条件

- 真实产品模型发送维持0；依 MAX235/MAX243 当前 handoff，等 Chief 协调权威累计10M账本、预留与未知发送结算、发送者和指定 Provider 现状后继续。不会重置预算或借用其他任务额度。
- 真实 Provider、受信主机行动/独立审批执行、生产开关保存/重启、故障部署源码真实环境、全平台宕机的外部探针均未在本机新演练。部分属于MAX242剩余范围/外部输入；保留原A01–A22及A17/A18最终集成要求。
- 新源码须 Chief 独立复核、当前SHA完整集成/安全发布门禁；局部链路通过不标整单done。外部探针另行评估，不能承诺平台宕机时自报。
