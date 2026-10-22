# MAX-222：r4 后离线生产修复与来源核验

本阶段完成上下文准入的离线修复候选，以及可信采集生命周期缺失的准确诊断。**没有新增真实调查，不能据此宣布第5项真实分析或第6项正式覆盖通过。** 原 PR #229 保持草稿，不合并、不部署。本阶段授权依据为 MAX222-OFFLINE-AFTER-R4.md（附件 `01a1613d-e124-76ae-b998-55618c40d947`）。

## 版本与验收边界

- 起点为 PR229 真实 head `1f42054cb3e8fe8103f6be047bf321a9c96113b5`，没有将 owner 工作树中的无关文档历史推入 PR。
- 当前代码候选 `7602f7f2203cd30a5102fb79343eda9d0dbaad54`；之后只有本报告文档提交。最终 PR head、文件哈希和补丁见交付包 `candidate-version.json`、`changed-source-manifest.json`、`candidate.patch`。
- 保留诊断提交和 RED 回执，再交付 GREEN；不重写 r1～r4 真实运行或旧证据。

| 原验收项 | 本阶段结果与证据边界 |
| --- | --- |
| 1. 趋势筛选 | 本阶段未改前端，复用此前同一前端源码的筛选、异步重渲染与浏览器验收证据。 |
| 2. 平板模板 | 未改前端，复用此前 1440/768/375、浅深色布局证据。 |
| 3. 中文名称、趋势时间 | 未改前端，复用此前名称、技术 ID 和完整时间/时区证据。 |
| 4. 下载名、IPv6 | 未改相关实现，复用此前跨格式与地址回归证据。 |
| 5. 真实分析 | 上下文离线候选通过；真实 r4 仍为 partial/CONTEXT_UNRECOVERABLE，11 facts/11 evidence、0 claims/0 hypotheses。没有新真实分析成果。 |
| 6. 指定资源正式覆盖 | 已只读核验来源并准确暴露生命周期缺口；未改正式绑定，未完成新候选连续3正式周期，仍未通过。 |

原前端与 r3 查询证据保留在本目录既有报告和此前 issue 附件。本包是 r4 后增量证据，不能替代那些历史截图，也不把旧 CI 14/14 算作新 head 的 CI。

## 上下文根因与生产改动

r4 的11个工具均已返回，查询修复实际有效。直接失败点是第二批六工具、必要 reasoning、七项 schema 以及不断增长的历史受保护引用挤满输入预算。原始最小摘要投影约12118，超过10880；文案实验11651也不足。上述数值为离线重建，均不是新增 wire 遥测。

本次沿现有 planner/projection 修复：

1. Agent Core 新增可选 `contextPolicy.evidenceReferences: 'canonical'`，默认仍为 `full`，必须配置 checkpoint 回调。Ops 启用该模式：旧摘要保护区使用完整 canonical 前缀的 range/hash、已记录调用 ID 与 `uncertain_do_not_replay` ID，不反复复制全部旧参数。每次投影继续校验摘要源 hash；完整 canonical、调用参数、回执和原始证据仍保存在持久历史。
2. Ops 成功回执以移除 ALLOW 审计后的512字节为短回执阈值。仅删除已确定重复的生成完成/告警计数标签与空 actions/artifacts；其他短回执业务字段、warning、unknown、非空 actions/artifacts 保留。大回执提供 toolCallId、完整回执 SHA256、字节数以及 evidenceOmitted/requiresNarrowerRead，明确要求缩小同资源范围读取。拒绝与业务错误不走成功压缩分支。
3. 重复证据语义放入一次共享系统规则：缺失/unknown 不是健康，引用不含观测值、不得据此推断健康或根因，历史记录不构成成功或重放许可。七项工具描述精简，资源关联枚举、时间/行数限制与实时执行 ACL 保留。
4. 不改16000窗口、4096输出和1024安全余量；输入预算仍10880，不改估计器或最终 `assertFits`。超限仍在 SDK 前拒绝。

### 最终离线准入数值

`final-admission.log` 对应代码候选，使用生产投影及实际 provider 的计数方法：

| 场景 | 离线估计输入 / 10880 | 余量 |
| --- | --- | --- |
| 原首批六工具 | 8284 | 2596 |
| r4完整夹具、第二批六工具、最小持久摘要 | 10228 | 652 |
| 后续批次2（累计17次工具调用） | 10568 | 312 |
| 后续批次3（累计20次工具调用） | 9321 | 1559 |

多批测试用真实 OpenAI SDK 连接仅监听 loopback 的本地 HTTP 接收器；累计3次持久摘要、2次分析请求、20次工具调用。完整调用/回执配对、最近必要 reasoning、canonical 原始内容/hash、恢复后相同投影、源变更拒绝与 SDK 前超限均有断言。接收器返回固定离线响应；测试中的 usage 数值是固定测试数据，**不是产品实测用量**。本结果只证明这些保留批次与协议路径，不能保证未来任意输入或真实模型调查成功。

## 第6项：生产来源及最小外部条件

只读来源核验时间为 `2026-10-22T01:47:19.152Z`。使用既有授权环境引用、数据库目标校验、资产凭据解析、SSH pool 和实时资产核对；没有输出凭据。MySQL 返回的 sampledAt 与采集时间存在8小时时差，只保留原值，不据此猜测启动时间或生成 epoch。

### MySQL

instance1 MySQL9.6.0 的普通 bindDatabaseDriver 使用 SHOW GLOBAL STATUS。只读结果包含稳定 server_uuid（交付只留 hash）、整数 Uptime/Uptime_since_flush_status、Queries/Com_commit/Com_rollback/Slow_queries；performance_schema.global_status 只有 VARIABLE_NAME/VARIABLE_VALUE。这些来源可读且含数值，但没有原子绑定的 startup generation、counter reset/FLUSH generation 和可信观测区间。

本次不假设 MySQL 整体绝无其他能力；结论限于已核验的现有生产固定来源。server_uuid 可跨重启不变，时钟减整数 uptime 存在精度、时钟和并发窗口问题；数值下降或随机数也不能证明重置边界。

生产 counter 读取若缺可信封装，现明确返回 `MYSQL_COUNTER_LIFECYCLE_UNAVAILABLE`，保留 parse_error/unknown。受影响包括 transaction counter 及派生 transaction rate，不产生虚假 epoch、rate 或 supported 样本。慢查询真零仍为 snapshot gauge，未改成速率；容量 `estimated_allocated_bytes` 仍为估算。

最小外部条件是可被身份/凭据/目标变更校验的可信采集来源，原子提供服务器身份、启动/重置/FLUSH generation、counter值和观测区间，并覆盖连接变更、缺权限和并发不一致。只有可信源和生产接线经过验证后，才可进入正式流程；单纯增加普通 SHOW 权限不能补齐这些字段。本阶段未执行重启、RESET、FLUSH 等破坏性来源试验。

### Linux 网络

server3 内核 `6.6.0-32.7.v2505.ky11.aarch64`；现有 `/proc/net/dev` 的12项网络计数全部成功解析。enp2s0 的 ifindex/iflink 为2/2，lo为1/1。失败发生在后续 `hostCounter`：生产 access 只提供 host_blocks，没有可信 `host_counter_epochs.interfaces`。

`linux-network` 与 `network-diagnostics` 现明确诊断 `HOST_INTERFACE_LIFECYCLE_UNAVAILABLE`，并通过 runner 进入 capability.basis；仍为 failed/parse_error、unknown，没有把缺生命周期标成 unsupported。该结论不等同于网络设备故障或 proc 解析失败。

最小可信来源需原子关联 boot、network namespace、接口 generation/替换身份、counter reset sequence 与观测，并在事件丢失、驱动重置、接口重建、目标/凭据变化时失效或更新。现有接口名、boot id、ifindex/iflink 不能单独覆盖这些边界；即使读取权限充足，也不能凭这些值伪造完整生命周期。需受信的主机侧生产者或等价权威来源，接入现有严格 host_counter_epochs 验证之后才能生成网络字节/包/error/drop counter 样本及速率。

### 文件系统与迁移

对实际11个文件系统的 used/size 使用现有有理数算术逐项核验。以下8项分母约分后均非2的幂，float64 无法精确表示，`partial/precision_loss` 是实际表示精度损失，不是本次解析或计算错误；保持 estimated，不改为 exact：

| 挂载点 | 精确 used/size 约分 | inode来源 |
| --- | --- | --- |
| / | 120901/326784 | 有数值 |
| /sys/firmware/efi/efivars | 5591/43688 | efivarfs未提供数值百分比，unknown/source_error |
| /run | 14128/139257 | 有数值 |
| /tmp | 6459/174071 | 有数值 |
| /boot | 90893/245760 | 有数值 |
| /boot/efi | 453/38324 | vfat未提供数值百分比，unknown/source_error |
| /run/user/0 | 1/5356 | 有数值 |
| /run/user/991 | 3/69628 | 有数值 |

另外 `/dev`、`/dev/shm`、`/sys/fs/cgroup` 的 used 为真实0，比例0/1精确。两项 inode 缺失不能填0；完整值与11行矩阵在 `filesystem-arithmetic-matrix.json`。

旧 qps、disk_usage 与告警宏迁移仍受精确 pin/revision/定义及语义核对约束，本阶段未强行解锁。正式绑定读前读后的配置 hash 相等。既有 instance1 rev4/gen4、server3 rev3/gen2 和旧正式桶不是新候选覆盖通过；下一阶段仍需字段级前值/回退、正常预览→试采→激活及每项coverage的连续3正式周期。

## 验证及失败保留

| 检查 | 结果 |
| --- | --- |
| 原r4诊断 RED | 2通过/1准入失败，保留原夹具与失败回执 |
| canonical pins RED→GREEN | 原实现缺模式验证与引用，修复后通过 |
| 生命周期诊断 RED→GREEN | 最初3项语义失败，另1项测试setup传错package对象；修正setup后隔离runner传播仍RED，最终4项通过；全部原始JSON保留 |
| Core focused | 32通过 |
| API focused | 12通过 |
| Agent Core全量 | 限制maxWorkers=2，709通过 |
| API metrics+investigations模块 | 首轮1168项：754通过、1失败、413条件跳过 |
| 最终相关重验 | 修正唯一过时的r2逐回执中文summary断言，改为检查同义共享系统提示；生产canonical模式下5文件16项通过 |
| 最终准入数字记录 | 同代码额外只跑1文件4项，保存上述估计数值 |
| API/Core typecheck、contracts:check | 通过 |
| git diff --check | 通过 |

API 首轮唯一失败是旧测试仍要求每条大回执重复中文提示；当前语义已集中在系统规则。最终结果是组合证据：未变文件复用首轮结果，加上最终相关重验，可得755通过/413条件跳过；**没有声称一次全模块执行全绿**。跳过包含依赖显式数据库/合同测试环境的条件套件，不将其当通过。

Core 首次高并发全量708通过/1个既有5000ms calibration超时（5473ms），未修改估计器或超时；相同源码以maxWorkers=2复验709通过。首次误把reporter参数放在额外 `--` 后，未生成JSON，`initial-core-timeout.json` 如实保留来自前台输出的记录，不冒充原生报告。所有RED、失败、跳过与最终结果一起交付。

## 用量、安全边界与清理

- 产品模型调用0，无新真实调查，无预留/账本写入，无 r1～r4 或未知发送重放。
- 回读 MAX-208 revision79：input19392/output3997/cached9600（输入子集）、8calls、合计23389、reserved0、limit10000000；r4增量5099已结算，未用26901已清算。本轮不能复用旧余额。编码token/费用实测不可用，不编造。
- 未改共享 Provider、凭据、正式绑定；未重启或接管共享3000/5173/28888。没有改历史partial、没有解释为已确认环境重启原因。
- 本地 SDK 接收器在 finally 关闭；只读脚本关闭数据库连接/SSH pool。全模块测试自有临时 MySQL 容器已自动清理，结束时共享容器列表与起始一致，没有留下run拥有的服务。未建调查服务副本。
- 原工作树 AGENTS.md、无关文档历史与 .multica 内容保留；只将本阶段精确源码/报告增量同步回任务本地分支，不把其无关历史推入PR。
- 便携包包含报告、完整r4夹具、源码补丁与文件哈希、RED/GREEN/多批/来源回执、校验和；使用环境秘密值在内存扫描后交付，不包含 .env 或真实凭据。

离线候选交 Chief 独立复审；只有另行明确预留并绑定唯一运行后，才可开展下一次真实调查。第6项仍等待可信来源及正式受控验证。新head CI由实际交付线程登记一条30分钟条件监听，本轮不等待、不合并、不部署。
