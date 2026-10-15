MAX-175 R5：真实隔离采样与指标窗口修复

## 结论与版本

沿用 `codex/max-175-resource-layout` / 草稿 PR189，不合并。旧交付 `4fee273c588fde7d0f67a195ecf4bf0ed1a8e68b` 的 CI run `38724099936` 完整11项全部 SUCCESS，包含 release-artifact。Chief R4 已关闭 F1/F2，原容量迟到 body、对象/权限清理及禁止自动诊断 GET 的审查结论继续有效，不重复首审。

本轮产品/测试验收提交为 `c204fcc67a1e15c01d8c964b47338ffb405ea645`。其后仅追加本报告；最终交付 SHA、代码/证据摘要在附件 `source-manifest.json` 中。当前审定 main 为 `4cb32b1d8596dc913a7fd2d2bbe0917e8f9520ea`，没有重建分支或变更 PR base。旧候选 tree 不是本轮集成结果。

本轮交付补齐可独立执行的真实协议隔离证据，不能据此宣布整项业务齐备。共享在线 SSH/SNMP、正式调度和完整 journald 正常流仍有缺口。产品模型调用0，父统一账本188299连续。

## 唯一产品差异与验证

真实指标页面发现相对时间窗口的起点、终点分别取时，可能相差1ms。60分钟窗口偶发变成3,600,001ms，产生空尾桶；当前值读取最后桶时显示未知，前桶已有真实观测。

`semantic-metrics.ts` 现在捕获一次 `Date.now()` 同时计算 from/to，保证窗口与桶宽整除；不回退旧桶、不伪造缺失值。其余五个产品文件未改，后端未改。

回归以每次调用跨1ms的真实 Date 行为复现：旧实现精确窗口断言失败（3,600,001 != 3,600,000），新实现9/9通过。当前产品源码完整前端122文件/1078测试、typecheck、build/CSP均通过；结果来自本轮前台命令输出，不声称证据包另含未保存的单测终端日志。

后续浏览器验证均在 c204fcc6 上完成：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 真实隔离正常流 | 1/1 | normal-browser.log、live-evidence.json、browser.json |
| 原MAX-175布局/日志/特殊状态 | 5/5 | layout-browser.log、compat-layout/ |
| MAX-163/165查询/权限/观测时间兼容 | 9/9 | query-compatibility.log、query-compatibility/ |

数据库三页与R1.1职责、首批50/次批5且ID不重复、过滤回首页、全文键盘、权限/对象隔离继续由原布局用例验证；受控特殊状态单列，不能当成真实正常采样。原通用浏览器192/192和R4 F1/F2证据复用；本轮未重复全站矩阵。新交付的 CI 必须按新head另行回读，不继承旧11/11结论。

## 确切隔离目标和真实数据

执行方案、命令、影响、停止/清理条件及共享步骤预览见 `isolated-preview-R5.md`。本轮使用任务自有 CentOS Stream9 容器，基础镜像 digest 为 `sha256:4fdfb367402535024cd7703a67e4549ca3b0a0ee05081e06d89e24dce3a3827a`；实际构建镜像 `sha256:766cbccacb23c905ebc7c385a5337ec8e1be4f928c3844a3ce7b307ab91b8c77`。

实际 RPM：OpenSSH9.9p1-16.el9、Net-SNMP5.9.1-22.el9、procps3.3.17-15.el9、iproute6.17.0-3.el9、systemd252-78.el9、Python3.9.25-10.el9、rsyslog8.2604.0-5.el9，均aarch64。精确进程、端口、目标ID和版本原文在 live-evidence.json.metadata。

容器独占带标签bridge、512MiB/1CPU/128PID，无宿主挂载、无 privileged；SSH22175、SNMP16175/UDP、HTTP18175仅发布loopback。任务MySQL8.4使用确切容器 `a6e6f31f6fa7a1ad1490a13bf094caa842809fa19b4b496d6c47f1385d52b313` / loopback33175，新随机schema；API3175、WS29775、Vite5195均独立。临时凭据不交付，证据序列化前断言不包含密码、community、JWT及加密密钥。

| 来源 | 两轮实际结果 | 资格范围 |
| --- | --- | --- |
| MySQL真实连接 | 每轮3 observations / 3 attempts | 连接数/上限/估算空间；不伪造counter生命周期 |
| Linux真实SSH命令 | 每轮17 observations / 2 attempts | 原host gauges/filesystem；非完整systemd主机 |
| Net-SNMP真实IF-MIB | 每轮166 observations / 2 attempts，11接口 | 原SnmpClient/SnmpDiscovery与采集包；含真实内核隧道 |

共6次实际采集，生产 runPackage 标准化、原存储及 RolloutControl 发布后由完整正式 Fastify 查询；18次正式指标查询均200。两次采样之间下载2MiB真实HTTP数据，接口counter增量至少2MiB且epoch一致，核速率公式。eth0发送速率示例约2,314,822.759bit/s，但原返回为 partial/precision_loss，保留质量与原始值，不当作good趋势。

Linux Net-SNMP **不是华为交换机**。库存表vendor必填枚举缺少generic Linux，测试行以huawei作为库存schema占位；名称明确“Linux Net-SNMP · 非厂商交换机”。该库存夹具不能建立厂商/固件实机支持结论。

## 页面、日志与连接接缝

正式应用壳实际消费上述已采集指标。三类指标、服务器日志、网络接口共5种页面 × 1440/768/390 × 明暗 = 30张新图。390暗色服务器日志、390暗色网络指标和768浅色服务器指标已人工查看；筛选控件完整可达，当前值、观测时间、质量可读，库存offline/unknown不会因成功SSH读取升为资源健康。

生产SSH目标策略拒绝loopback，本轮没有修改或绕过正式服务策略。沿用仓库 `host.mysql.test.ts` 的资格测试模式，在连接层创建真实ssh2客户端；后续命令执行、诊断解析、采集包、存储和消费用生产实现。唯一HTTP覆盖是显式诊断POST，使用实际 ServerDiagnosticService、JWT和实时权限、真实SSH返回；其余HTTP为完整正式Fastify。故不宣称正式在线目标授权/调度链路已验。

服务器日志来自真实 logger 写入的 `MAX175_REAL_SYSLOG_WORKLOAD`，经既有 `tail /var/log/messages` 和真实SSH读取。容器不是systemd PID1，services保持unknown。诊断整体partial，日志reason为 `JOURNAL_UNAVAILABLE_FALLBACK_MESSAGES`，不得把回退路径称为完整journald正常通过。为该隔离账号读取fixture日志，任务容器内显式给systemd-journal组只读权限；不修改共享权限。

六组页面操作实际发6次显式诊断POST、0自动诊断GET，pageerrors为空。无自动GET结论由请求记录和原布局R4/R5兼容用例共同支持，不用无POST或不支持OS422替代。

## 新确认后端缺陷与最小锁请求

`apps/db-ops-api/src/server-diagnostic-service.ts` 的固定命令包含：

```sh
journalctl ... --since=-5 minutes --priority=warning ...
```

同一真实CentOS目标、同一账号和同一日志，参数拆分探针退出1，stderr为 `Failed to add match 'minutes': Invalid argument`。单参数等价探针退出0，返回真实 `MAX175_REAL_JOURNAL_WORKLOAD`；原始stdout/stderr已记录在metadata.journalArgumentProbe。不是无日志或凭据问题。

请求Chief先协调 **该后端文件与专属测试** 的最小写锁：仅把固定时间字面值改为 `--since="-5 minutes"`，补shell参数回归并在同类真实journald目标复验，不新增能力或后端接口。本轮未越锁修改。审批来源是本任务六产品文件契约，后端不在现有范围。

## 已完成与剩余门禁

可独立完成部分已执行：任务容器真实SSH/SNMP、两轮采样与流量增量、正式指标查询、syslog回退日志、明暗窄屏消费、布局与共享消费端回归。

以下仍未完成，分开交审：

- 固定journalctl参数修复与完整journald正常流：先协调上述后端最小锁；容器services unknown不能替代完整主机。
- 共享在线SSH/SNMP实机和正式调度/binding链路：需环境所有者指定确切获准服务器ID和网络设备ID/版本/现有绑定，再预览一次显式诊断POST、两次受限采样及只读查询。不启动全局调度、不增binding、不部署/重启、不改Provider。无获准ID时不试探共享目标，缺绑定另交差异审批。
- 厂商网络设备/固件能力、完整Agent链路、共享新版运行态、人工读屏和性能门禁未由本轮替代；受控异常与真实正常流证据继续分列。

## 清理与交接

finally已删除本次CentOS容器、独占网络和schema，关闭SSH/API/Vite；恢复任务MySQL原先停止状态。后续布局/查询兼容验证也删除新schema并停止同一确切MySQL。最终回读该容器exited，任务端口3175/29775/5195/22175/18175/16175无监听；独占带MAX-175标签目标无残留。保留本地构建镜像供复现，不交付容器发布包。

外层原AGENTS.md未提交修改保留。本轮只更新原PR；新head交Chief审影响差异，继续draft、不可合并。每次push续设原子checks/15astra/原线程/1800秒/timeout wake并回读，父交审沿原规则、先查活动队列，不另mention或重复派发。
