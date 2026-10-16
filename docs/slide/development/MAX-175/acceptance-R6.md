MAX-175 R6：journald 固定参数修复与真实隔离复验

## 结论与范围

沿用原分支 `codex/max-175-resource-layout` / 草稿 PR189，交增量复审，不合并。Chief R5已审定的前端时间窗口修复及R4 F1/F2关闭结论复用，六前端产品文件未修改。本轮依最新正文独占写锁，仅修改 `apps/db-ops-api/src/server-diagnostic-service.ts` 的固定时间参数引号；新增专属后端参数边界回归，更新原真实隔离浏览器断言。

产品/测试验收 head：`0a89e5bb52dc90e1fa780c97689f300714db18c0`。此前 `a2df32b` 为已运行失败回归的测试检查点；本报告之后不再修改产品/测试。最终交付head、源码摘要和实际附件清单见 R6 source-manifest.json。

原R5交付head `300afed4243f27701f3baaeb510622d525e9aeaf` 的CI run `38729950284` 已主动核实完整11/11 SUCCESS，包含release-artifact，实际快照附 ci-R5.json。该结论不继承给R6新head；每push续设原实际子checks。

## 根因、最小修复与回归

生产固定命令原为 `journalctl ... --since=-5 minutes ...`，真实POSIX shell把它拆成 `--since=-5` 与独立match `minutes`。CentOS同账号的真实journalctl退出1并报 `Failed to add match 'minutes': Invalid argument`，不是目标没有日志。

修复仅为 `--since="-5 minutes"`。没有新增接口、动态命令、权限、采集能力或输出/超时限额；fallback、来源和partial/unknown语义不变。

新 `server-diagnostic-service.max175.test.ts` 用真实 `/bin/sh -c` 执行生产命令，通过shell函数记录实际argv，不只比较源码字符串。旧实现1失败/1通过，失败差异准确为独立的minutes；修复后2/2通过，原命令拆参对照也保留，所有其他优先级/行数/输出选项完全一致。RED、GREEN日志已附。

| 验证 | 结果 | 来源 |
| --- | --- | --- |
| 专属shell参数与既有诊断服务 | 5/5 | journal-green.log |
| 诊断、Linux日志解析、指标provider、OS profile受影响模块 | 5文件/51项通过 | affected-backend.log |
| 后端typecheck | 通过 | backend-typecheck.log |
| contracts:check | 通过，无契约变化 | contracts.log |
| 真实采样/正式查询/日志消费浏览器 | 1/1，约1分钟 | live-browser.log、browser.json、live-evidence.json |

前端产品源码未变，复用R5完整1078项、typecheck/build/CSP、原布局5/5及MAX-163/165兼容9/9，不因报告重复全量检查。本次浏览器实际验证受影响日志消费以及明暗窄屏。

## 真实journald到页面的证据

使用原任务镜像 `slide-max175-live-target:r5`，镜像ID仍为 `sha256:766cbccacb23c905ebc7c385a5337ec8e1be4f928c3844a3ce7b307ab91b8c77`。基础镜像、CentOS Stream9及OpenSSH/systemd/Net-SNMP确切版本与R5相同，metadata记录本次实际进程与端口。目标容器ID为 `64a036722d9f3484daf459097bca9cc87d5b9b579a6d865f8fb7c6688f3386a3`，独占bridge为 `7cc79b0e84a5c6af5a219468ca49d9b8394998952100d353225fd2b356691156`；资源和loopback端口限制沿用R5隔离预览。

实际 `systemd-cat` 向journald写入 `MAX175_REAL_JOURNAL_WORKLOAD` warning。生产 ServerDiagnosticService经真实ssh2和原有有界execCommands执行修复后的固定命令，解析出带真实timestamp的消息，正式应用日志页显示该消息。六组1440/768/390×明暗均通过：

- 日志section质量good，无fallback reason；原tail fallback未调用。
- 服务section仍unknown（容器PID1为sshd），整体诊断仍partial，不升级主机健康；库存offline/观测未知仍保留。
- 6次显式诊断POST，0自动诊断GET，pageerrors为空；保留JWT/实时权限与显式采集门禁。
- 390暗色截图已人工查看，实际日志与时间/质量可读，无页面溢出。

原隔离脚本同时实际完成两轮MySQL/Linux SSH/Net-SNMP共6采样、18次正式指标查询及2MiB流量，生成30张页面图；另1张为390日志顶部裁剪，原图保留。指标来源与precision_loss边界如实记录。本轮重点是journald消费变化，R5已审指标资格不重复提升结论。

连接边界保持：生产SSH策略拒绝loopback，未改策略；测试沿仓库既有资格模式创建真实SSH连接接缝。唯一HTTP覆盖是显式诊断POST，内部实际服务/权限/SSH；其余HTTP使用完整正式Fastify。Linux Net-SNMP不是厂商交换机，库存huawei枚举占位不代表华为实机；直接调用采集包/正式发布与查询不等于生产调度或在线binding已验。

## R5清单更正

原R5证据ZIP及SHA不变，其中 `compat-layout/api.log`、`compat-layout/migration.log` 实际未交付，却遗留在manifest中。本轮明确更正为 **未交付的本地原始日志**，不以它们支撑验收，不补交可能包含运行细节的原始服务日志。

附件 `source-manifest-R5-corrected.json` 替代原独立清单及ZIP内旧清单，移除两条错误evidenceFiles记录，并在correction.notDelivered明确列出；260截图、13源码摘要及其余17项实际证据全部重新核对。原R5 ZIP SHA256仍为 `3079a6ca55ae6b3c2997d0a720f614c3aad90a864a95d1160cec6c6f509dfd5b`。本轮R6包从实际入包文件集合生成清单，并逐项核对ZIP内存在性与SHA256。

## 剩余业务门禁与最小独立方案

本轮已取得正常journald读取，关闭“固定参数阻止真实日志读取”的缺口；不将容器journald正常读取称为完整systemd主机通过。

当前主机无limactl、utmctl、multipass、qemu-system-aarch64，未安装虚拟化工具或创建共享VM。完整systemd正常流的最小独立方案为：提供任务自有可启动CentOS Stream9 VM（1CPU/1GiB、独立磁盘和NAT、仅loopback22275转发SSH，无宿主共享挂载），先固定所用镜像SHA256、实际VM ID/版本与SSH账号。启动后通过 `ps -p 1 -o comm=` 核验systemd，`systemctl is-system-running` 和 `journalctl --version` 记录真实状态；写一条带MAX175标记的warning，经本轮同一服务/真实SSH执行固定诊断、验证services实际结果与journald消息，再只读核页面。实际OS或状态不符立即停测，不修改os-release或预置服务结果。影响仅该VM启动、任务日志与只读诊断；清理为关闭确切测试句柄并删除该VM/独占磁盘及转发。实际镜像/VM尚未提供，不能声称该方案已执行或版本已核实，也不为截图启用privileged/cgroup宿主挂载。

共享在线SSH/SNMP、厂商设备、正式目标授权/调度/binding、完整Agent链路、人工读屏和性能门禁仍未完成。原R5共享步骤预览保持：先指定获准服务器和网络设备ID/实际版本/现有绑定，再预览一次显式诊断、两次受限采样及只读查询；无获准对象不探测。共享部署/重启、Provider/在线binding及采集未获新增授权，本轮均未操作。产品模型调用0，父账本188299连续，MAX-182固定c102不扩。

## 清理与交接

脚本finally已关闭SSH/API/Vite、删除本次schema/容器/网络，恢复确切任务MySQL容器 `a6e6f31f6fa7a1ad1490a13bf094caa842809fa19b4b496d6c47f1385d52b313` 为exited；最终回读任务端口无监听、带MAX-175标签目标无残留。凭据只在隔离运行期使用，证据写出前校验不包含临时密码/community/JWT/密钥。

恢复环境中原实现目录为空，已通过平台checkout取回原远端head并续接同名原分支，未创建新PR或推送其他分支；外层原AGENTS修改保留。本次仅交增量待审，状态in_review不等于业务齐备；PR继续draft不可合并。每push续设并回读原实际checks，父交接前核family活动/队列，已有Chief运行不重复trigger/mention。
