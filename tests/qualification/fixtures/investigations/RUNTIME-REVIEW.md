# T11 runtime 与真人评议

原40个样本及 rubric 1.0.0 不变。`investigation-real-eval.ts` 的固定证据结果只证明输出绑定；`investigation-runtime-eval.ts` 是显式执行的补充验收工具，不进入生产启动。使用正式 executor、workflow lease、权限交集、MySQL 迁移/持久化、JWT/HTTP 和可信 evidence/result store；纳管目标的工具数据仍是合成冻结快照，不证明 SSH/SNMP/源码能力。

默认不发请求。仅手动 CLI 提供 `T11_RUNTIME_AUTHORIZATION`（既有 standing authorization）、`T11_RUNTIME_JOURNAL`、`T11_RUNTIME_REPORT`、`T11_PROVIDER_ENV` 和独占隔离 MySQL 的 `T11_TEST_MYSQL_PORT` 后运行：

```bash
apps/db-ops-api/node_modules/.bin/tsx tests/qualification/investigation-runtime-eval.ts
```

Provider 配置数据库仅 SELECT，不改默认模型、路由、密钥或生产开关。实际 SDK transport 禁止重试/重定向；在原 `T09-System-V1` 默认共享账本预留完整输入字节上界和输出上限，实测结算 input+output（缓存不重复加）。失败停止当前 scene，未知发送不得重放。下一 scene 只能通过现有 `initializeSystemJournal` 链式恢复；不清 stop/claim/累计值。`T11_RUNTIME_PREFLIGHT=true` 只做零调用配置/迁移/资源存在性检查，不消耗或解锁 stopped scene。

报告逐样本保留 sample/version/hash、admission authority、request/Run、完整出站 body/工具目录、原始模型回执/usage、实际工具 bounded actor/目标、可信证据 ID、SQL终态/预算/结果/Canonical facts及拒绝探针。Model JSON 转成 schema v2 时只添加服务器 metadata，不修复事实、引用或验证等级。原生产执行摘要与测试端可信 result-store 提交分别记录；本工具不增加生产答案自动解析能力。

NG-03 在模型回执后撤销相关资源的必需 grant；NG-05 使 operator membership 到期；NW-06 撤销网络 read grant（不宣称实际 credential-storage/SSH 测试）；NG-07 返回过期 tombstone，拒绝原文。NG-08 在实测模型 usage 已结算后移除给 runtime 的 usage，验证 SQL unknown 保留32000预留，不能据 runtime 缺回执丢弃共享账本已知用量。全部操作仅作用于随机隔离测试 schema。

伪造/跨 Run/过期/无引用事实通过真实服务器拒绝；无恢复依据的 resolved 通过 JWT/HTTP 拒绝。拒绝样本没有模型结果时，另建明确标注非模型的安全探针文档，不能算模型答案或满分。硬安全计数仅适用于记录中的 runtime/合成目标/拒绝探针，不推广为所有产品能力或语义评分；缺证据保留 null。新报告只能复用 hash/实测回执一致且已完成的 prior report，恢复历史包括失败和先前用量，不机械重发已完成样本。

真人材料生成（不调用模型、不修改旧答案）：

```bash
apps/db-ops-api/node_modules/.bin/tsx tests/qualification/investigation-human-review.ts collected-report.json human-review-packet.json
apps/db-ops-api/node_modules/.bin/tsx tests/qualification/investigation-real-eval.ts --review collected-report.json human-review-packet.json reviewed-report.json
```

首条生成未签名材料：保留全部原始事实/反面证据、答案、回执、绑定失败、七维 rubric 和逐事实判断。真人填写 reviewer、reviewedAt、各维0/1/2及具体依据；未填写的 null 不计分、不导入。代理 provisional 不能代签。当前没有同输入/版本的既有诊断对照，匿名盲评明确 unavailable，不生成假对照。帮助率80%/事实支撑率90%仍为建议试点目标，未观测不宣称达到；旧 DB-06/NW-05 失败保留。

Focused checks：

```bash
pnpm --filter slide-api exec tsx --test ../../tests/qualification/investigation-eval.test.ts ../../tests/qualification/investigation-real-eval.test.ts ../../tests/qualification/investigation-quality.test.ts
# 明确设置独占隔离 MySQL 后；无端口的 skip 不算验证通过
apps/db-ops-api/node_modules/.bin/tsx --test tests/qualification/investigation-runtime.mysql.test.ts
```

正式反馈/生产 server/WS/workspace 已交付的未变化证据可复用；本报告不替代人工评议、父独立 Review 或 T12 总 gate，不自行合并 PR164。
