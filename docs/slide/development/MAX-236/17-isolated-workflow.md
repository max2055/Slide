# MAX-236 独占容量与迁移工作流

本入口只操作本次创建的独占 MySQL 8.4 容器及白名单 schema。它不连接共享 3306、远程设备，不启动生产 worker，不执行共享/生产停写、复制、切换、回退或实际解绑。

## 运行

从仓库根目录，先按 package.json 指定的 pnpm 安装冻结依赖。Docker 需已提供 `mysql:8.4` 镜像；不修改现有容器。

```bash
pnpm install --offline --frozen-lockfile
python3 -B -m unittest discover -s scripts/max236 -p 'test_*.py'
python3 -B scripts/max236/fixture.py create .max236-workflow/my-run.json
python3 -B scripts/max236/fixture.py workflow .max236-workflow/my-run.json
python3 -B scripts/max236/fixture.py drill .max236-workflow/my-run.json
python3 -B scripts/max236/fixture.py clean .max236-workflow/my-run.json
```

`workflow` 先装配固定源码并 typecheck，再同步执行受控工作负载和正式数据副本演练。命令失败为非零，句柄及日志保留；不要把未知状态当作已清理。`clean` 可在失败后单独运行，前提是归属仍可确认。每次重跑完整工作流创建新句柄；现有源码快照或 schema 不会被静默覆盖。

`workflow-<nonce>.log`、`source-<nonce>/max236-sources.json` 和 `results-<nonce>/workflow.json` 位于句柄所在目录。结果和完整源码 manifest 必须一并保存，并以实际文件字节生成 SHA-256。命令会等待前台子进程结束；测试有 30 分钟上限，Docker、连接、检查和清理调用均有界。

## 来源与边界

- 配置来源：MAX-238 safe `b5c140c1d646bfb5581ff88da7498b4793e7322d`。
- 事件来源：MAX-239 safe `0a9eec2e13b03c7665c025080fce799f769247fe`。
- 公共祖先：`88fc15e2bce814218ff2f1836a33d57ff236eef6`。
- 以 239 为私有快照，合入 238 相对公共祖先的后端源码变化；交叠文件作三方合并，仅对已知的首行 import 冲突保留双方 import。任何其他冲突拒绝运行。实际合并文件及全部后端/Agent 源码、脚本、SQL、lockfile 摘要记录在 manifest。
- 外部依赖复用冻结安装；API 的 `@slide/agent-core` 指向同一私有快照。任务工作树和其他 owner 的产品文件均不被覆盖。此装配只用于本项验收，不是生产集成/部署。
- 本项 R3 旧迁移执行器仍是唯一旧配置演练实现。本次增加真实 NetworkID 核验和原生 envelope 拒绝：原生编译计划不能被旧工具清空后降级。没有放宽 activate 谓词或 strict codec。

跨 owner 接口修正仅在私有装配应用：238 的 `templateHistoryPayload` 会将 239 已正式应用的 envelope 重新编码为 pending；第二次采集因此被 strict decoder 以 `BINDING_PAYLOAD_REVISION_INVALID` 拒绝。`producer-compat.test.ts` 固定复现这条边界，兼容补丁改为完整复用并重新严格校验已存 payload，保留 formal proof/effective revision；不修改任何 decoder 谓词。根工作树的 238/239 产品文件不变，补丁随本项交付供对应 owner 集成，私有源码 manifest 记录补丁后的实际文件摘要。

## 工作负载与测量口径

固定 500 个 RHEL 服务器、100 个 MySQL 9.6 模拟目标、50 个 SNMPv2c 模拟目标；平台存储是真实 MySQL 8.4。每资源一个 uptime 指标、一个无标签维度序列，默认采样周期 60 秒、短时保留全部样本。这里的数据库版本是受控目标画像，不能当作远程实机版本。

受控 SQL/SSH/SNMP 只返回既有适配器期望的固定响应，不做远端 IO。正式路径为原模板服务的探测/试采/发布 → CollectNowService → WorkflowStore/WorkerRuntime/JobRegistry → MetricScheduler → 同一个正式 writer → 原有触发器/事件事务。历史读调用 238 的 `readConfigurationAt`，不接管 240 消费者。

默认并发为 1、2、4，每档两轮 95 → 20，分别触发问题和恢复；可通过 `MAX236_CONCURRENCY`（1–4）、`MAX236_CYCLES`（偶数，2–10）和 `MAX236_JOB_TIMEOUT_MS`（5000–60000，默认30000）调整。30秒是本次受控任务的显式作业预算，经既有配置 override 发布，未修改 worker 逻辑。同一轮先入队全部 650 个请求，再排空和并发读取；这是突发清空测试，不是匀速到达或完整 retention 压测。更大指标数和维度基数应更换明确的模板/受控响应后重新测量，不能线性外推本结果。

每档记录 admission/drain/read elapsed、worker 与历史读 p50/p95/max、端到端吞吐、排空吞吐、积压峰值/末值、Node RSS/CPU、Docker 即时 CPU/内存快照及 MySQL 状态。Docker 快照不是资源峰值；同机其他任务可能影响结果。所有数值均来自运行，不从 650 个资源推算生产 SLO。

## 一致性、迁移与回退

逐一核验 650 个任务的正式样本和历史配置，检查唯一样本 ID、每资源唯一 episode head、每轮问题/恢复数量和零末尾积压。相同 caller key 重放不产生第二个任务。环境不配置通知渠道，验证不会产生外部通知任务；这不能替代真实通知投递验收。

将本次正式平台的全部表复制到句柄预写的 `max236_reala_copy`。只在副本用正式采集刷新代表数据库的 capability，然后重复 preview，注入审计 INSERT 失败，验证绑定、revision、审计及内容摘要未变，再执行配置变更、相同请求重放、stale revision 拒绝及新 revision 回退。回退完整恢复原 pins/package/group/overrides，保留不可变旧 revision；历史配置读仍返回原有效采样设置。

内容保全覆盖正式 observations/publications、事件及 episode/head 水位、旧数据库/服务器/网络历史、凭据密文所在资源行和 instance ACL。只比较摘要，不导出凭据值。多模板有损回退及旧迁移的重复/冲突/失败事务由原 R3 真实 MySQL 套件补充；两个执行入口不互相冒充。

## 停止与放行

归属未知、目标不匹配、源码冲突、类型检查失败、任务/样本/历史不一致或数据保全失败均非零停止并保留证据。完整隔离流程及必要模块 gate 通过后可提交复核。生产迁移仍需独立操作授权；短时受控基线不等于生产容量、长期 retention、真实远程网络设备或完整 P0/P1 验收。

旧阶段已接受结论保留；16 号检查点中的缺口以本入口及最新实测记录为准，不能把旧检查点改写成通过证明。

2026-11-01 完整650资源流程及最终gate结果见 [18号实测报告](18-isolated-results-20261101.md)。
