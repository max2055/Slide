# MAX-85 第一批接线验证记录

日期：2026-09-23。基线：`2da7b2d`。分支：`feat/max85-production`。

本批实现：应用生命周期、受控资产访问与在途变更检测、SNMP discovery 连续性、逐资源/序列 ticket 快照、Raw 与 Normalized 事务落库、正式消费者 shadow 隔离、迁移 102 及运维清单。完整 MAX-85 尚未交付；详细缺口见 `production.md`。

## 环境与证据

独立 Docker MySQL **8.4.10**、Alpine SSH **3.22.5**、本地模拟 UDP SNMP；Node **24.18.0**。未使用生产数据库、资产凭据或应用 `.env`，未执行生产切换。Linux/数据库/SNMP 既有隔离链路仍使用 fixture CollectorAccess，不能等同于生产 Access 的三类真实目标验证。

| 检查 | 结果 |
| --- | --- |
| 完整后端 `vitest run --maxWorkers=2`，设置隔离 MySQL/SSH 变量 | 290 文件通过、5 文件跳过；2,657 项通过、56 项环境相关跳过 |
| 最后资产/凭据在途校验补丁后的 `src/metrics-v2/config src/metrics-v2/scheduler --maxWorkers=1` | 7 文件、46 项通过；复用未受影响的完整门禁结果，未重复全套 |
| 前端三个指标组件测试 | 3 文件、21 项通过 |
| 实际 MySQL 098–102 全链新建与重复执行 | 通过，包含既有迁移修复测试 |
| 从 101 升级 102：ALTER 后中断、阻止直接重试、checksum-bound repair、回填与历史保持 | 1 项真实 MySQL 专项通过 |
| 桌面/移动端配置 UI + 实际 HTTP/MySQL + Linux SSH fixture | 2 文件、4 项通过；浏览器断言已与当前 main 的中文文案和放弃修改确认一致 |
| 后端类型检查（最后补丁后） | 通过 |
| 前端类型检查 / 构建 / CSP | 通过；2 个生产脚本通过 CSP。存在既有 chunk 大小和静态/动态 import 提示，无构建失败 |
| API contracts | 通过 |
| qualification matrix | 37/37 已映射，通过；映射通过不代表全部生产场景通过 |
| 秘密扫描（含已暂存新增文件） | 通过 |
| 部署安全静态不变量 | 通过，不等同于已部署到生产 |

计数不可相加：focused regression 与完整后端门禁有重叠。没有宣称 56 项跳过通过；没有宣称物理交换机、全部目标版本、生产峰值容量、生产灰度或真实业务回退通过。

## 行为回归覆盖

- 默认关闭、无效激活值拒绝、迁移前置校验、tick 不重叠、错误恢复与脱敏、关闭超时。
- 删除资产、错误凭据引用/资源身份、旧数据库连接目标与密码不一致、远程 IO 期间资产/凭据变化拒绝落库。
- 同一 SNMP 资产连续发现；其他资产、目标/凭据变化、淘汰、进程重启不会复用旧代次。
- 两个资源使用不同来源资格；只有明确登记且匹配 pin/revision 的序列进入正式 publications。
- 采集中 CAS 提升代次后，旧 ticket 不能借用新代次发布；失败事务不留下正式值。
- shadow、pending、legacy 模式不进入正式 V2 查询/维度；unknown 观测保留；回退不删除历史。
- Raw 证据独立 stage 存储并保留 Normalized lineage，Raw 不计作正式序列或 publication。

## 审阅与资源

按实际 diff 完成主线程自审；没有独立子代理审阅。子代理数 0、最大深度 0、代理并发峰值 1。硬预算未设定；raw input、cached input、output 与费用实际遥测不可用，不提供虚构估算。

本批作为 draft PR 交付，不合并、不发布。周期采集缺省关闭。完整生产任务保持进行中，不能因本记录的本地测试结果放量。
