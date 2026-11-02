# MAX-237 原范围联合验收覆盖表

Chief复核后的默认入口、精确权限和真实页面补验见[复核接续](vendor-default-entry-20261102.md)；此前证据仍按各阶段边界复用。

2026-11-02 接续：Oracle19.19 / 达梦8.1.3.62真实查询、映射、正式样本及最新/历史已补验，准确源码、权限边界及原19.3未覆盖项见 [资格记录](vendor-qualification-20261102.md)。下文原阶段证据保留，不将本次兼容版本或DBA账号冒充准确19.3/最小权限验收。

基线：`81ebf83e32cddf0ca4db8384619ee6d131fa7d0c`。本表沿用原任务范围：固定模板应用到资源，经真实采集进入最新值、历史及事件触发、保持、恢复；不重建编辑、绑定、存储、历史或事件引擎。受控 SNMP 证据不代表设备实机。

## 接受的集成来源

| 工作 | 当前已接受源码 | 安全 PR 候选 | 本次处理 |
| --- | --- | --- | --- |
| MAX-238 配置、应用及历史契约 | `2cfd3a47d93356491548a25986ec884002202fc2` | #567 `888e36be4834bcddca97b8e8495dd2bd8ef0b5e6` | 核对现有实现；只修集成断言和证据输出缺陷 |
| MAX-239 正常 writer、事件、历史链路 | `82d0743206487fc7987ea8ebc45ca0f36284fca6` | #570 `a1f63ceae59a86689c786747a451c63f008abd31` | 复用已接受实采；补 PG 联合证据 |
| MAX-240 维护消费契约 | `2fe2a510221d853d5709e45c0368f1ff48a2bdea` | #568 同 SHA | 核对消费接口，不执行实际解绑或外部通知 |

## 原验收覆盖及缺口

“已接受”指 Chief 已接受的历史证据，不表示本次重新实跑；“待补”不得用于宣称验收完成。

| 验收对象/语义 | 模板应用、真实采集 | 最新/历史 | 事件触发/保持/恢复 | 证据与剩余工作 |
| --- | --- | --- | --- | --- |
| MySQL 基础模板 | 已接受 | 已接受 | 已接受，同一 episode | MAX-239 MySQL 附件 `01a1928b-26fb-7410-9d7c-d088c39f5874`；本次自有 MySQL 8.4 补齐同快照 current/limit×100、COMMIT/ROLLBACK 速率、首样本/reset/凭据失效未知 |
| Linux VM 固定 SSH 模板 | 已接受，只读 VM | 已接受 | 已接受，同一 episode | 附件 `01a19476-c15e-7c75-8deb-8dff3a2dd0d1`；本次只读 VM 补齐 MemAvailable 正常及真实 SSH 命令不可用未知；缺字段为受控解析验证 |
| 受控 SNMP v2c/v3 authPriv | 已接受，真实 UDP | 已接受 | 已接受，同一 episode | 附件 `01a194d3-61f2-7946-92a1-a3e9fc1f1026`；明确为受控端点 |
| PostgreSQL 16.4 固定 SQL 模板 | 已接受；双次正常采集、只读拒写、超时、权限失败、reset/首样本未知 | 本次真实最新/历史 API 通过 | 本次真实 open/hold/recover，同一 episode 恢复一次 | 基线附件 `01a197a0-872e-7e91-ba87-f907706a6f0f`；本次补正常 writer 到历史与事件消费，样本及配置/规则快照可追溯 |
| Oracle 19.3 / 达梦 8.1 | 候选，未实采 | 未验收 | 未验收 | Chief/Max 提供已授权目标、凭据引用及只读窗口；不猜目标、不安装产品 |
| 原生模板配置 UI 与资源固定模板入口 | 已接受原生流程 | 复用已接受契约 | 复用事件入口 | 本次旧目录/维护入口回归 19 项通过；真实 HTTP/MySQL 配置流程 5 项通过 |

## 本次验证边界

仅对自有隔离 MySQL 8.4 / PostgreSQL 16.4 写入及清理；现有 VM 只读。禁止共享 3306 写入、生产操作、实际解绑、部署、通知及模型调用。不等待或轮询 CI；本地必要验证后，仅作一次远端快照交接。独立复核由 Chief 接收本次源码及证据。

CI `41318880479`：已完成日志定位。MAX-238 JSON 为测试输出，缺失的是输出目录；审计断言存在“发布操作数”和“操作加快照行数”混用。浏览器失败须按实际入口核对。本次修复输出目录与操作数断言；保留原 helper 对每次发布恰有一份完整快照及 hash 的校验。浏览器按当前详情折叠区和维护契约定位，mock 补齐原生库接口并限定 API 路径，未放宽产品断言。release-artifact 失败为上游门禁失败的传递结果，未改 gate、未盲目重跑。


## 六条原验收标准对应证据

| 原验收 | 对应证据/边界 |
| --- | --- |
| 名称修改不丢历史，单位/口径不兼容拒绝 | 复用 `native-template-workflow-20261101.md` 的真实 JWT/Fastify/Lit 改名、稳定 item ID、旧快照深比较和语义变化 422；本次集成未改编辑/身份逻辑 |
| 原始字段→语义→item→序列→规则逐项追踪 | 原 PG5项映射证据继续有效；本次 PG 原始/规范化15样本、配置 revision、规则 snapshot、同一 episode、历史 API sources/configurations 联查；MySQL 新映射通过注册选择断言及实际原始值计算 |
| 注册选择自动填充及非法配置阻断 | 复用已接受的完整原生流程负例；本次新增 `%`/used_percent/固定 implementation 自动填充回归；指标模块完整 gate 通过 |
| MySQL 使用率/速率、Linux MemAvailable、SNMP 速率边界 | MySQL 使用真实 SQL 快照与 uint64 delta/观测时间校验，真实 FLUSH STATUS/reset、凭据撤销；VM 真实 /proc/meminfo 与进程内命令不可用故障；SNMP 复用已接受真实 UDP 证据。零分母/缺字段采用受控边界，不冒充目标实际发生 |
| 数据库/服务器/网络三类采集→最新/历史→事件 | 复用已接受 MySQL、VM、受控 SNMP 正常 writer/历史事件证据；本次 PG 再补真实条件 open/hold/recover 及最新/历史 API。按父项最新成员决定，受控 SNMP 足够，不列物理硬件阻塞；Oracle/达梦不计通过 |
| 共享读取、凭据隔离、只读/超时/限额/脱敏 | 模块 gate 包含实现共享读取与凭据指纹隔离回归；PG 真实 25006/57014/撤销 CONNECT，私有 session 清理；MySQL 独占用户凭据撤销；安全测试 35文件336项及 secret scan 通过。不将 mock 权限测试当成实际目标验证 |

## 本次具体改动与复现

- `mysql-diagnostics@1.2.0` 增加固定 SQL 快照，输出 `mysql.connections.current` 与 `mysql.connections.used_percent`。后者为 Threads_connected/max_connections×100，不用 PROCESSLIST 背景线程充作客户连接；缺失或零分母保持 NULL。1.0.0/1.1.0 的 collector、定义和 digest 未改变。
- Linux memory_usage 固定读取 `/proc/meminfo`，按 (MemTotal−MemAvailable)/MemTotal×100；缺字段、重复、非法单位/范围返回未知，不回退到 MemFree 或补零。已有 package 定义的 MemAvailable 口径得到落实。
- `max237-database-templates.ts`：新建隔离 PG 资源没有历史源，使用既有 `RolloutControl.initialize` 为所选序列注册 semantic gate，随后由正常 worker 发布。未插入观测、publication 或 episode，未给生产资源开 gate；第一次试验未注册 gate 时最新/历史正确无样本，未绕过该保护。
- `max237-metric-semantics.ts`：要求明确自有容器 ID/端口，并核对 Docker 标签/映射；仅对该容器创建/撤销/清理临时 MySQL 用户。VM 使用既有服务器3的加密凭据引用，源库在 `START TRANSACTION READ ONLY` 中仅 SELECT，目标只读；命令不可用故障仅改变本次进程 PATH。日志及附件不含凭据。

仓库根目录入口：

```bash
pnpm --filter slide-api exec tsx e2e/max237-database-templates.ts
MAX237_OWNED_MYSQL_PORT=<自有动态端口> MAX237_OWNED_MYSQL_CONTAINER=<自有容器ID> SLIDE_DEBUG_ENV_FILE=<已授权引用文件> pnpm --filter slide-api exec tsx e2e/max237-metric-semantics.ts
```

第二个入口核验容器标签 `slide.task=MAX-237-52329`，拒绝3306；没有授权 VM 引用时只暂停 VM 部分并记录 owner/恢复条件，不换目标。实际命令、源码 SHA、图像/容器标识、样本和清理在本次 Issue 证据附件，运行时目录不作为交付链接。

## 集成核对及剩余项

本分支在起点已包含接受的消费树：与 `2fe2a510221d853d5709e45c0368f1ff48a2bdea` 比较，bindings/policy/config、triggers/scheduler、consumers/maintenance 生产文件一致；MAX-239 writer/trigger 与 `82d0743206487fc7987ea8ebc45ca0f36284fca6` 一致。238 到 239 的 applied-envelope/history 兼容差异来自已接受集成。本次没有合并其他分支或引入其祖先。

- Oracle19.3、达梦8.1：Chief/Max 协调已授权目标、凭据引用、只读窗口；恢复后 15coder1 补真实采集及连续性接线。当前仅草稿候选，不能应用为已验证模板。
- 当前 VM 存在 MemAvailable。真实未知证据是只读命令不可用；缺 MemAvailable 的自然环境未声称存在，受控解析负例已通过。
- 未执行部署、外部通知、实际解绑、生产 gate 激活、共享3306写入、模型调用或子代理。
- 本次交付等待 Chief 独立复核，整单不标 done。CI 保留合并门禁，推送后只交接一次快照，不等待/轮询。


## 当前候选验证记录

源码与真实验收 SHA：`524cca44b364c129bd1cc1a1aa08aee92b410476`。其后仅补本文验收记录，不改变已测代码。

| 检查 | 当前结果 |
| --- | --- |
| 最终集成：`vitest run src/metrics src/contracts/metrics src/server-metric-provider.test.ts src/alert-event-access.test.ts src/security/server-instance-authorization.test.ts --maxWorkers=2` | 自有 MySQL 8.4，METRICS_TEST_MYSQL_PORT 与 MAX238_HISTORY_MYSQL_PORT 指向动态端口；124文件、1308项通过；23文件/72项环境门控跳过，未计通过 |
| 浏览器：`playwright test e2e/metric-settings.spec.ts e2e/audit-dialog.spec.ts --workers=2` | 同一源码下19项通过；保留原矩阵，不新增移动/暗色验收范围 |
| PG 真实联合脚本 | 同一源码下通过；PG16.4，自有 MySQL8.4平台库；3次采集15个规范化样本；open/hold/recover，最新值/历史/配置/事件联查 |
| MySQL/VM 真实语义脚本 | 同一源码下通过；使用率严格比对快照、速率严格比对 uint64 delta/真实时间、重置和凭据失效；VM 正常及真实 SSH 只读故障未知 |
| 既有不可变发布兼容 | 从起点加载原诊断发布构造器，与当前8份原 release 完整深比较相等，含 digest；仅新增 MySQL1.2.0 |
| 安全 | secret scan通过；35文件336项安全测试通过；无共享库写入及目标 VM 修改 |
| 静态/契约/构建 | API/frontend typecheck、两个 e2e 脚本单独 bundler 模式 typecheck、contracts:check、frontend build/CSP 均通过 |

最初单独检查 e2e 时误用了 NodeNext 模式，与仓库 bundler 配置不一致；改用仓库模式后通过。没有为该工具参数问题改动旧模块。初次 PG 清理曾遇 Docker `--rm` 的完成可见性时序；补前台有界确认后重跑，最终容器及 schema 清理全部确认。日志保留准确退出状态，不以完成标志替代实际清理。

CI `41318880479` 的已读取失败分类：browser(1)旧维护入口；browser(2)旧目录折叠区及缺原生库 fixture；API(1)/(3)/(5)/(7)发布操作计数混用，API(5)/(6)/(7)证据目录缺失；release-artifact由上游失败传递。均由本次相关回归覆盖；未修改合并 gate。推送后的 CI 另作一次快照，不能把本地通过写成 CI 已绿。
