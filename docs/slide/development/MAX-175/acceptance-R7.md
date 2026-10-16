MAX-175 R7：Max 提供的完整 systemd 主机实测与日志体积阻断

## 结论

已使用 Max 在本任务提供并明确“可用于测试”的 `192.168.49.130:22` 完成真实连接和验证。主机身份为 Kylin Linux Advanced Server V11 (Swan25)、aarch64、内核 `6.6.0-32.7.v2505.ky11.aarch64`，PID1 为 systemd，`systemctl is-system-running` 返回 running，systemd 为 `255 (v255-34.p04.ky11)`。不再以“未提供完整 systemd 测试目标”作为本项阻塞。

**真实指标到正式页面通过，正式日志正常流失败，整项仍 blocked。** PR189 保持草稿，不合并。此次只新增专属验收脚本及报告，没有修改六前端产品文件或后端产品实现。R4 F1/F2、R5时间窗口及R6引号修复的既有审查继续有效；此次发现的是繁忙真实journald此前未覆盖的相关既有容量边界。

## 目标、授权与环境

- 使用成员本次提供的目标和凭据；凭据仅在内存、子进程环境及临时任务数据库的加密记录中使用，不进入源码、报告或附件。
- SSH主机密钥固定为 `SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA`。生产 `authorizeServerTarget`、`sshSessionPool.getConnection` 及主机密钥校验均实际执行，没有旧容器的loopback连接接缝。
- 服务身份已读取：sshd MainPID 4301、ActiveState active、启动路径 `/usr/sbin/sshd -D $OPTIONS`；端口22可达。
- 本地平台使用原任务独占 MySQL 容器 `a6e6f31f6fa7a1ad1490a13bf094caa842809fa19b4b496d6c47f1385d52b313`、loopback33175及随机任务schema。服务API3175、Agent WS29775、Vite5195；启动前核验端口空闲，均由本轮脚本创建和清理。
- 仅临时任务库存记录该服务器，`collection_enabled=0`，本地v2后台采集关闭，临时schema中的Provider全部停用。两次有界包采样及本地发布不是共享在线binding/正式调度验收。
- 主机只追加任务warning日志以识别真实journald路径，执行固定只读身份、诊断和指标命令；未安装软件、修改配置或重启远端服务。

## 实测结果

最终验收命令在frontend运行：

```sh
MAX175_SYSTEMD_TARGET=1 MAX175_TEST_HOST=<本次批准目标> MAX175_TEST_PASSWORD=<仅环境注入> MAX175_TEST_FINGERPRINT=<已核指纹> pnpm exec playwright test e2e/max175-systemd-host.spec.ts --workers=1 --reporter=line
```

| 路径 | 结果 | 资格 |
| --- | --- | --- |
| 真实生产SSH → linux-host gauges/filesystem → 正式持久化与指标查询 | 通过 | 最终两轮各32个observations，四个collector attempts均succeeded，正式查询200 |
| 正式服务器指标页1440/768/390 × 明暗 | 1项浏览器测试通过，6组实图 | 各9个当前指标卡，无页面横向溢出，实际观测时间；库存offline/未知保持原值 |
| 正式JWT/实时权限 → 显式collect-diagnostics → 正式日志页 | 1项浏览器测试失败 | 返回503/INTERNAL_ERROR，6组失败图单独命名，不冒充正常日志通过 |
| 进入日志、刷新、指标/日志切换 | 无自动诊断GET | 最终运行只有1次显式诊断POST，pageerrors为空 |
| 不提供显式测试开关和凭据的默认执行 | 2项skip | 防止CI或普通浏览器测试访问外部目标；skip不算业务通过 |
| 后端typecheck | 通过 | 新增独占诊断probe也在类型检查范围内 |

本轮三次有目的的浏览器运行：首次发现503；第二次补读响应body以确认正式HTTP错误；第三次拆开独立指标验收和诊断失败证据。合计6轮指标采样、3次显式诊断POST、3条带不同PID的任务warning日志；最终验收仅引用最后两轮和最后矩阵。另有一次有界生产服务诊断定位，未重复整套前端矩阵。

定位时第一次独立probe遭遇任务MySQL刚启动尚未就绪，未发远程诊断；补就绪检查后一次生产服务probe明确复现下述根因。该环境启动问题与实际诊断失败分开记录。

## 503根因与最小修复请求

独立probe沿用生产数据库凭据读取、目标策略、密钥验证、SSH连接和命令执行，仅记录每段退出码及字节数。uname、systemctl、ss、ps均成功，输出分别6、2051、420、680字节。执行原固定journalctl命令时抛出 **SSH_COMMAND_OUTPUT_LIMIT**，单段上限131072字节；正式HTTP安全钩子将该503细节转换为INTERNAL_ERROR。

同一真实主机、相同5分钟/warning/200行窗口的只读计数对照：

| 命令 | 行数 | 输出字节 | 最大行字节 |
| --- | --- | --- | --- |
| 当前生产journalctl完整JSON | 200 | 202050 | 1241 |
| 增加固定output-fields投影 | 200 | 104037 | 691 |

候选参数为 `--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_PID`，journalctl仍自动保留时间/游标等必需元数据。对照只输出字节统计，没有交付远端原始journal内容。它证明裁剪未消费元数据可避开本次128KiB传输中止，**尚不能证明完整修复**：共享解析器自身还有64KiB上限，104037字节仍会触发截断/partial。不能提高上限、删主机日志、缩短窗口或伪造good来使测试通过。

请求Chief协调将当前后端契约从“仅固定时间字面值加引号”扩展到：同一固定journalctl命令的必要字段投影、已有字节边界下的截断/partial处理及本任务专属回归。先评审上述差异；如需触达共享 `linux-host-evidence-service.ts`，必须另核锁，当前不改。优先在已锁 `server-diagnostic-service.ts` 中保留原15秒、128KiB单段/512KiB总限额、5分钟、200行和fallback，明确输出不完整的partial语义。不得把这项请求理解为放开全局采集能力、权限、输出限额或共享HTTP安全钩子。

待批准后的验收：真实shell参数及大量journal元数据边界回归；相同授权主机经完整正式POST取得可用服务/日志证据；若触及解析字节边界，明确partial/truncated及其原因。正常数据与截断数据分开断言，不继续硬要求所有真实负载都good。仍须保留失败历史，而非把最终503断言改为200或用overlay替代正式接口。

该授权请求来自当前子任务正文“journald固定参数的最小后端所有权”明确限制。当前没有越界修改产品源，也没有改变共享解析器/HTTP安全层。

## 清理与交接

本轮finally已关闭确切SSH/API/Vite句柄、删除各随机schema、恢复确切任务MySQL为exited；3175/5195/29775无监听。远端主机继续运行，3条任务warning日志保留为审计记录，不删除journald或回滚主机日志。原AGENTS.md修改保留，产品模型调用0，父账本188299连续。

不交付带登录token的Playwright trace或本地原始API日志；证据清单仅列实际入包文件。包内包括真实身份/指标/正式查询、字节计数probe、生产命令失败边界、12张正常指标/失败日志图、运行失败历史和清理结果。所有截图明确区分正常指标与失败日志，未宣称systemd服务诊断整体通过。

剩余：本次日志体积问题的最小范围协调及修复；厂商网络设备/SNMP目标和确切授权；正式共享调度/binding及完整Agent链路；人工读屏和性能门禁。此次服务器测试授权不扩展为共享部署/重启、Provider修改或其他在线设备授权。
