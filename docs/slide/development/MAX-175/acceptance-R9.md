## MAX-175 R9：本地性能分布与人工读屏缺口

沿原 PR189 / codex/max-175-resource-layout 交付。产品基准 head `37d654ee2af34dfd89dfcd4111fa3a3a39c6d831` 的七个产品文件字节完全未变；本轮仅专属测试和报告。测量时测试文件为未提交工作区内容，其精确 SHA256 见 source-manifest.json，与本轮提交测试文件相同。R8 的有效代码审查、真实 systemd／日志证据和未变前端矩阵复用，不重复远端请求。PR 继续 draft，不可合并。

### 环境、方法与适用范围

本机 Apple M5 / 10 CPU / 24GiB，macOS 27.0.1（Darwin 27.0.0）、arm64，Chromium 148.0.7778.96，1440×1000、浅色、无网络或 CPU 限速。Vite 开发服务器、完整正式 Fastify、JWT／实时权限、独占 MySQL 8.4 经 loopback 通信；机器其他任务未停，未控制全机负载。

三类资源各5次冷浏览器、10次暖浏览器，共45轮、405个操作样本、48组分布。冷：每轮新 context 且禁用 HTTP 缓存；后端／MySQL／OS不冷启。暖：每类复用 context／HTTP缓存，每轮新 page，第1轮也计入。按顺序、单用户，无并发压力；每个范围筛选执行6小时和1小时两次，故该组 n 为10／20，其余 n 为5／10。

计时从自动化动作开始，直到可见目标满足条件并经历两个 requestAnimationFrame；包括 Playwright 动作可用性、轮询及调度开销。不是单独 API 延迟、INP、Core Web Vitals、生产首屏 SLA 或容量压测；无前后对照基线和既定阈值，不宣称达标或性能改善。p50／p95 使用 nearest-rank，n=5/10的p95等于max，不能推断稳定尾延迟。

数据来源：真实登录态和正式 API，任务专属持久化库存；55条数据库日志（19条warning），首批50／第二批5，ID不重复；两个网络接口。指标正常响应实际为未配置（数据库2／服务器3／网络1项，均0 series），测量其能力读取／范围筛选／定义与原始明细路径；不代表有大时序数据时的图表性能。服务器日志实际无诊断证据，测量该状态的切页，不调用诊断GET或采集POST。未覆盖大量日志、接口／series、真实SSH/SNMP延迟、生产构建、移动端性能；旧视觉／键盘证据继续有效。

### 结果

最终专属浏览器 1/1 通过（55.2秒），405个操作样本、0 pageerror、0诊断请求。841个API响应中，业务指标／日志／接口均200；旁路 `/api/platform/frontend-events` 有35次429、10次202，其余796次200。遥测限流如实保留，不放宽生产限额或将整轮描述成所有请求200；该限流与自动化频率使测量不能外推生产多用户体验。

单位毫秒；完整原始样本／API状态在 performance.json。

| 模式／资源／操作 | n | min | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| cold-browser/database/page-load | 5 | 213.8 | 224.0 | 296.6 | 296.6 |
| cold-browser/database/tab-to-metrics | 5 | 366.8 | 467.2 | 483.4 | 483.4 |
| cold-browser/database/metric-range-filter | 10 | 32.8 | 33.4 | 41.7 | 41.7 |
| cold-browser/database/metric-details | 5 | 66.5 | 66.5 | 67.5 | 67.5 |
| cold-browser/database/tab-to-logs | 5 | 100.1 | 100.2 | 100.4 | 100.4 |
| cold-browser/database/logs-next-page | 5 | 94.2 | 94.6 | 95.3 | 95.3 |
| cold-browser/database/logs-level-filter | 5 | 45.7 | 46.7 | 62.5 | 62.5 |
| cold-browser/database/logs-text-filter | 5 | 33.1 | 33.3 | 33.4 | 33.4 |
| cold-browser/database/logs-fulltext | 5 | 32.4 | 33.4 | 33.6 | 33.6 |
| cold-browser/database/tab-to-overview | 5 | 63.1 | 63.6 | 65.1 | 65.1 |
| cold-browser/server/page-load | 5 | 210.4 | 219.3 | 318.6 | 318.6 |
| cold-browser/server/tab-to-metrics | 5 | 366.4 | 483.3 | 500.5 | 500.5 |
| cold-browser/server/metric-range-filter | 10 | 32.3 | 34.5 | 42.7 | 42.7 |
| cold-browser/server/metric-details | 5 | 66.4 | 67.1 | 67.6 | 67.6 |
| cold-browser/server/tab-to-server-logs | 5 | 65.7 | 66.3 | 66.7 | 66.7 |
| cold-browser/server/tab-to-overview | 5 | 66.6 | 66.6 | 67.6 | 67.6 |
| cold-browser/network/page-load | 5 | 211.0 | 221.6 | 266.1 | 266.1 |
| cold-browser/network/tab-to-metrics | 5 | 349.9 | 366.7 | 367.8 | 367.8 |
| cold-browser/network/metric-range-filter | 10 | 32.6 | 33.3 | 40.6 | 40.6 |
| cold-browser/network/metric-details | 5 | 66.6 | 66.7 | 67.1 | 67.1 |
| cold-browser/network/tab-to-interfaces | 5 | 83.5 | 98.9 | 100.9 | 100.9 |
| cold-browser/network/interface-status-filter | 5 | 32.5 | 33.2 | 34.4 | 34.4 |
| cold-browser/network/interface-name-filter | 5 | 29.0 | 30.1 | 31.4 | 31.4 |
| cold-browser/network/tab-to-overview | 5 | 65.5 | 66.4 | 66.8 | 66.8 |
| warm-browser/database/page-load | 10 | 199.7 | 208.7 | 247.5 | 247.5 |
| warm-browser/database/tab-to-metrics | 10 | 366.0 | 366.7 | 467.1 | 467.1 |
| warm-browser/database/metric-range-filter | 20 | 32.9 | 36.6 | 43.4 | 50.1 |
| warm-browser/database/metric-details | 10 | 65.7 | 66.6 | 67.8 | 67.8 |
| warm-browser/database/tab-to-logs | 10 | 89.1 | 99.8 | 101.3 | 101.3 |
| warm-browser/database/logs-next-page | 10 | 93.3 | 95.2 | 97.1 | 97.1 |
| warm-browser/database/logs-level-filter | 10 | 45.5 | 46.9 | 47.5 | 47.5 |
| warm-browser/database/logs-text-filter | 10 | 32.7 | 33.3 | 33.5 | 33.5 |
| warm-browser/database/logs-fulltext | 10 | 32.6 | 33.3 | 34.2 | 34.2 |
| warm-browser/database/tab-to-overview | 10 | 59.2 | 63.5 | 65.1 | 65.1 |
| warm-browser/server/page-load | 10 | 186.0 | 199.1 | 231.6 | 231.6 |
| warm-browser/server/tab-to-metrics | 10 | 366.5 | 483.4 | 500.7 | 500.7 |
| warm-browser/server/metric-range-filter | 20 | 33.0 | 33.7 | 42.7 | 45.4 |
| warm-browser/server/metric-details | 10 | 65.7 | 66.5 | 66.8 | 66.8 |
| warm-browser/server/tab-to-server-logs | 10 | 62.1 | 66.7 | 67.7 | 67.7 |
| warm-browser/server/tab-to-overview | 10 | 65.7 | 66.6 | 67.1 | 67.1 |
| warm-browser/network/page-load | 10 | 184.4 | 191.6 | 253.4 | 253.4 |
| warm-browser/network/tab-to-metrics | 10 | 349.9 | 366.7 | 367.6 | 367.6 |
| warm-browser/network/metric-range-filter | 20 | 32.7 | 33.7 | 40.9 | 41.5 |
| warm-browser/network/metric-details | 10 | 66.3 | 66.6 | 67.0 | 67.0 |
| warm-browser/network/tab-to-interfaces | 10 | 76.0 | 83.4 | 84.2 | 84.2 |
| warm-browser/network/interface-status-filter | 10 | 32.8 | 33.2 | 33.4 | 33.4 |
| warm-browser/network/interface-name-filter | 10 | 30.2 | 31.0 | 37.1 | 37.1 |
| warm-browser/network/tab-to-overview | 10 | 61.0 | 66.7 | 66.8 | 66.8 |

### 验证与清理

前端 typecheck、diff检查通过；无显式隔离开关时专属性能测试1 skipped（安全默认，不算业务通过）。新增测试实际沿既有正式服务夹具运行；初始化增加90秒上限、显式关闭任务环境指标调度，afterAll只删除本轮专属 schema 并查询确认不存在。

首轮性能测试1/1成功（56.6秒）；清理核对时首次独立查询遇到MySQL启动时机，之后观察到旧轮次遗留schema，未擅自删除。为提供确切本轮清理证据，仅增加schema／子进程清理记录后补跑一次性能测试，最终1/1成功（55.2秒）。最终数据对应补跑；没有重复旧全量矩阵。

本轮 schema `db_ops_ai_qualification_max175_52329` 已删除且回读0行；API／Vite子进程已退出，3175／29775／5195无监听，既有任务MySQL容器恢复exited。旧schema不属于本轮新增，保留不动。无共享部署、重启、Provider、正式binding／调度、远端采集或产品模型调用；父产品模型账本188299不变，MAX-182固定c102不扩。原外层AGENTS修改保留。

### 人工读屏与剩余门禁

安装信息核对：VoiceOver 10 / build 993；未启动、未发生人工听读，没有实际VO按键／朗读记录。本轮生成5份Chromium AX快照，并自动核对日志Enter展开后按钮焦点；它们不是人工读屏通过。确切缺口为可听取VoiceOver实际输出的人工验收者。附件 manual-screen-reader-R9.md 提供隔离环境入口和逐项记录表，覆盖名称／角色／顺序、筛选、全文、明细、分页及适用的焦点恢复。不可用的人工条件未混称成共享部署授权阻塞。

厂商SNMP／网络流量按成员决定已延后测试环境实机复验，仍未测，但不再列本地阻塞。正式共享调度／binding和完整Agent链路仍未满足；缺目标版本／既有绑定及具体操作对应的批准，未自行解除门禁。若决定立即验证，应先只读确认目标并交操作／影响／回滚／停止条件预览；若决定延后，应先更新有效要求。人工读屏和该范围决定完成前，整体仍blocked、PR仍draft。

R8旧head完整14/14 CI有效，但不继承到本轮新提交。实际新head／CI及30分钟checks接续以本轮交付评论为准。本轮不重跑未变产品的完整gate；新提交由现有CI统一门禁验证。

证据包只收录报告、精确测试源码、performance.json、5份AX、清理记录和浏览器结果；原始API／迁移日志、JWT、原始主机日志不入包。source-manifest.json列出本轮实际交付文件与SHA256，未交付文件不列为证据。
