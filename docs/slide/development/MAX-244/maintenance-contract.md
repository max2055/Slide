# MAX244 维护流程与历史消费契约

本次仅交付已授权的维护完整流程。继承、灰度回退、依赖等原 P2 范围仍保留；不宣称整单完成。前置基础修复为 4bda83a3e，集成 239 安全来源 1cbab4dd2、238 安全来源 888e36be4；239 后续 audit/CLAUDE gate 修复已精确合入 owner 安全头 a1f63ceae59a86689c786747a451c63f008abd31，未自行覆盖其测试或修复。

## 实施与验证顺序

1. 复用维护入口与唯一事件 writer，保留未知维护状态下的问题事实。验证非法时区、跨日、排他结束边界、维护查询失败。
2. 事务化有限期限/资源范围与不可变修订。验证锁等待撤权、提交当前权限、revision 冲突、重放/noop 审计不重复及未知结果恢复。
3. Lit 选择授权资源、期限和时区，检查影响、确认保存、取消、核对操作结果；验证主体与组件生命周期隔离。
4. 独占非3306 MySQL + Fastify + Lit 验证上述路径，并使用受控数值/时钟运行现有 evaluator 和唯一事件持久 writer，确认维护不关闭问题、结束不补发、恢复不重复。
5. 运行受影响测试、API/frontend typecheck、contracts、build/CSP；记录准确 source/safe SHA、对象审计、一次 CI 事实，交 Chief 独立安全复核。

不启动模型、生产 worker、外部通知、共享3306写、部署或实际解绑。可恢复失败由当前流程修复；只有具体外部硬阻塞才暂停对应步骤。

## 数据与写入

`maintenance_intervals` 保存当前权威状态；`maintenance_interval_history` 每次实际修改仅追加一个 revision，同时作为维护变更审计。`maintenance_operations` 在同一事务记录主体内操作键、原始意图摘要和原始结果。取消保留原定义、写入取消时刻；重复取消/noop不增加修订审计。

所有读写先取得 `maintenance_scope_lock`，事务为 READ COMMITTED。修改后、提交前重新加载并锁住当前身份/授权，核实原范围与新范围。有限范围逐资源使用既有资源权限和资源存在性检查；全局要求不受资源边界限制的 `*` 权限。操作查询同样经过锁，`absent` 表示没有该主体该键的已提交操作，重试仍必须使用原键及原意图。

维护区间为半开区间。每版历史的有效起点为 max(starts_at, changed_at)，终点为 min(ends_at, 下一版 changed_at, cancelled_at)。修改不回写已经发生的范围、原因和事件关联。重叠定义分别保留；任一命中即可抑制。时间均使用带 UTC 偏移的绝对时间；timezone 是已验证 IANA 时区，用于界面展示，避免夏令时歧义。既有周期维护记录不删除，运行时继续按其时区和周起点判定；有限期限流程不将周期定义伪装成不可变历史。

## HTTP

- GET `/api/maintenance-windows/resources`：只返回当前可管理的三类资源身份和名称。
- GET `/api/maintenance-windows`：只返回当前有权查看整个范围的维护定义；数据库错误为503，不能返回空列表冒充无维护。
- POST `/api/maintenance-windows`；PUT/DELETE `/api/maintenance-windows/:uuid`：正文包含 `operation_key` 和 `expected_revision`；创建/修改另含 `value`，取消另含 `cancel:true`。value为 name/reason/resources/starts_at/ends_at/timezone；resources为明确 Ref数组或全局 null。默认且固定继续采集、记录问题、抑制通知。
- GET `/api/maintenance-windows/operations/:key`：主体内 `committed` 与原结果，或 `absent`。401/403不是无操作证明。
- GET `/api/maintenance-windows/intervals/:type/:id?from=<ISO>&to=<ISO>`：供240消费，按请求资源当前读取权限实时校验。返回 resource/from/to/intervals/event_links。intervals具有稳定 id、revision、name、reason、starts_at、ends_at、timezone、changed_at、cancelled_at、effective_from/effective_to。scope投影为当前请求资源，不能泄露同窗口其他资源身份。event_links冻结 alert_id所关联的event_id/episode_id/resource、发生时at、state及命中的不可变 interval修订。未知 state 不可解释为无维护。客户端展示区间时还须裁剪到请求窗口；空/负长度修订不代表实际维护时间。

## 唯一事件与通知

`AlertEventService.persistTemplateTransition` 沿用现有事件、告警、episode、event log writer；维护状态和发生时区间写入告警 tags及 `maintenance_event_links`，不创建第二事件引擎。维护查询异常记录 state=unknown，继续持久化问题；active/unknown不开启通知投递。既有 alert clock继续以当前采集事实评估，维护退出本身不确认、不恢复原问题。

现有通知轮询与 durable delivery 在发送前使用相同维护判断。维护发生时的历史命中或已记录active/unknown永久阻止该问题开场的补发；当前维护也阻止已有待投递项。抑制投递落为skipped，重放仍复验；查询失败抛错并走既有可重试/未知语义，不能放行发送。外发实际到达门槛继续豁免。

## 可复现验收

`pnpm --filter slide-api exec tsx e2e/max244-maintenance.ts` 创建独占容器（随机nonce标签）、记录确切容器ID/端口/PID/cwd/schema，再运行完整迁移、生产HTTP registrar与真实Lit。输出在 `outputs/max244-<nonce>`，含生命周期、结果、清理确认和三尺寸截图。清理只核验该nonce和确切ID/schema；未知返回非零并保留句柄，不扫描邻居。

数值95/85/缺测/60和时钟由fixture控制，使用现有纯evaluator与唯一事件持久writer、真实MySQL；不声称该fixture测试物理SQL/SSH/SNMP传输、正式scheduler全部链路或外部通知。既有采集链未改动，其已接受证据按准确上游源码复用；本fixture验证维护没有向collector写停用配置。安全权限独立复核由终态Chief完成。


## R1/R2 兼容修复（2026-11-01）

公开告警 tags 中 maintenance 仅保留 state/at；新 writer 不再复制全范围，历史 mapper、通知及 RCA 读取同样裁剪。完整不可变维护关联仍在 maintenance_event_links，授权区间接口继续按请求资源投影。当前 GET /api/alerts 的 items DTO 本来就未包含 tags，真实 JWT 验收也覆盖该生产 registrar；不把 mapper 单测称作 HTTP 验收。

Migration141 保留原 maintenance_windows 每周重复/时区/跨日/抑制配置，新增 revision=0 和升级快照 maintenance_weekly_history，不删除或转换成一次性区间。原入口 GET 同时返回 kind=weekly、数字字符串 ID 的旧窗口，PUT/DELETE 接受旧 ID；新建仍只创建有限期限窗口。周期编辑 value 为 name/reason/resources（单个 instance 或 null 全局）/timezone/day_of_week（1=周日）/start_time/end_time。取消只禁用 enabled，不删除原配置；已取消不可编辑。周期列表保留已取消状态。

周期管理复用 maintenance_scope_lock、maintenance_operations、锁后及提交可信实时权限；修改前后资源均授权，revision 冲突返回409，未知响应按原键查询/重放，noop 不新增审计。完整保留 legacy suppress_evaluation 字段，问题事实记录仍按已有修复继续。历史区间接口仍提供有限期限维护生产契约；旧周期配置由兼容管理和独立周期修订审计保全，不伪造有限期限历史。

新增真实 fixture 先安装截至140的原始迁移，种入 enabled 旧周期，再执行141；经实际 Lit/Fastify/MySQL 查看/修改/取消、响应丢失恢复、撤权锁等待/越权、版本冲突、审计与运行时抑制解除。所有 MySQL 使用 nonce 独占非3306实例；无正式 worker、物理 collector 传输或外部通知。
