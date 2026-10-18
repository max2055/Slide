# P10 action-readiness-1：候选配置与受控来源运行方案

本文件对应 MAX-203 的 action-readiness-1 附件。起点 `a268037cd5b09cbc5cf4941b42de75fd4b58118d`，沿草稿 PR212；整包 base `1c3578f3d7ebace2953117be9dcffa0060a69497`。本阶段只交本地候选；真实部署/采集/目标恢复由父非实现上下文独立审查后分配。P07/P08/P09 前置保留。历史 B16 证据复用。

## 实际装配及配置

`server.ts` → `createOperationsComposition` → `RegisteredActionEnvironment`，使用已合入 P06 `PlanSources`、`ActionPlanService`、原 JWT 与审批。每次创建、读取、提交、审核都会核现有服务要求的完整实时 ACL/调查成员/resultVersion/证据及引用，不新增来源写入口。环境只发送固定 `sudo -n -- /usr/local/libexec/slide-action-demo-helper inspect`；不注册 execute、receipt、行动工具或行动 worker，composition 无条件保持 dispatch=false。

部署只提供三个文件引用，内容及私钥不放入 `.env` 示例、仓库、评论或证据包：

| 环境变量 | 内容和权限 |
| --- | --- |
| `OPERATIONS_PILOT_MANIFEST_FILE` | UTF-8 `{manifest,signature}`；普通文件，不允许组/其他用户写，父目录仅部署者可写 |
| `OPERATIONS_PILOT_PUBLIC_KEY_FILE` | 由受信部署者设置的 Ed25519 SPKI PEM 公钥；不可从请求或 manifest 内获取 |
| `OPERATIONS_PILOT_SSH_KEY_FILE` | 专属 slide-action 私钥引用；普通文件且权限0600；不读取既有root采集账户私钥替代它 |

manifest 字段为 `schemaVersion:1`、`target`（下表的完整 P07 注册对象）、`policyVersion`、完整 `verifier`、毫秒UTC `validFrom/validUntil`。签名消息为 `operationsContentHash(manifest)` 的 hex UTF-8 bytes，Ed25519 签名编码为 base64；不签 JSON 原文或二进制hash。P07 自己的 target 签名仍签 `operationsContentHash(target)`，两者消息不同，不能互换。

每次从文件重新验证签名和注册；删除文件、改权限、缺配置、格式错、未知/不匹配均拒绝，错误不包含文件内容/SSH输出。SQL 在原事务锁 `servers` 行并比对 host/port/host key。只有计划的 target、tool、unit、唯一 `target_config_hash`、medium风险、policyVersion、完整verifier均与签名注册一致才访问SSH。主机key必须真实握手通过，helper返回的config/helper/unit hash和serverId必须匹配。完成SSH后重新核签名材料未变化并读数据库UTC；计划有效期必须包含于注册有效期，不能用慢响应跨过到期。环境注册不证明业务效果；P08 实际验证器装配与300秒效果观察仍待其原owner完成。

策略和验证器注册是部署受信材料，不是客户端可选代码。父在独立审查时核准具体 policyVersion、verifier id/version/definitionHash 及以下固定窗口；配置正文必须与对应审定定义文件逐字节摘要绑定：before=120s、readiness=60s、observation=300s、interval=10s、maxExtraRestarts=0、requireAllHealthy=true。不存在可审定定义文件/版本时不签注册，不用随机hash补齐；P10原owner在下一来源阶段交具体定义与准确内容，P08原owner确认后续消费接口。这里只绑定注册，绝不把尚未合入的P08当作效果已通过。

## 已有实机材料与恢复点

以下是父已独立核验的 P07 新helper Q01 历史绑定（不是当前已激活状态），可从父附件 `newhelper-q01-independent-review.md`、outputs的 `2026-10-17-p07-newhelper-q01` 证据包重算。P07候选接口准确head `7c24a15d8366dd2b90a2a77516ab3d8a03fed351` 仅供参考，未合入本候选。

| 绑定 | 已审历史值 |
| --- | --- |
| serverId / host / port | 3 / 192.168.49.130 / 22 |
| 产品账户 / 固定unit | slide-action / slide-action-demo.service |
| helper路径 | /usr/local/libexec/slide-action-demo-helper |
| helper SHA256 | 9eeef88558c46c7e2b380f79e7b21348a7be4ba619f47770f62127c0846eddd4 |
| unit SHA256 | 905a161d6d6268458309213652e6e3afe85158a76aca1988e9293dcafdeb4495 |
| host key | SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA |
| target config hash | 9dcc021fc26eca2adac13f07fc7c2ec6e3109bd7d7b42fbaa6b15265daa7ecab |
| protocol / toolVersion / eligible | 1 / "1" / true |

原阶段已保留18份前态文件并恢复：产品账户认证拒绝、unit not-found/inactive/MainPID0、18087无监听，目标写锁 `released_unassigned`。下一阶段需要按保留清单/manifest重建专属服务与受限helper，不能把历史Q01当当前可用注册，也不重复旧盘点来等待来源。host clock 偏移未解，不回填时间；负责人须先解释/修正本专属链的时钟与有效期，未解决则不生成计划。root@VM的既有凭据只引用父受控说明；mysql-3306仅取已授权纳管配置，不迁移/写其业务库。

## 下一次受控来源与准确待审计划：工程顺序

1. **父协调**独立审查候选准确head、SQL/HTTP/SSH安全证据及必要CI，沿既有授权把目标写锁一次交给 P10 来源阶段原owner；不并行启动 P07/P12 目标写，不新增 Max 逐包批准。只解锁最小来源准备，不解锁产品 execute。
2. **P10原owner**建立新平台 schema `slide_v23_source_<run短ID>`（严格字符白名单），目标为本机专属 MySQL9.6 容器且仅127.0.0.1动态端口；不使用mysql-3308承载平台表。新schema先运行正式MigrationRunner，保留128/129 ledger/checksum，第二次运行证明重入。配置只导入已授权的server3、mysql3308和唯一metrics关联所需记录，过滤原队列/批准/会话，使用新的专属JWT/加密key。记录映射，不能把本地重编号误认原目标3。
3. **P10原owner**迁移前/配置完成后分别 `mysqldump --single-transaction --set-gtid-purged=OFF`，写到统一outputs受保护目录并记sha256；恢复到第二个专属schema，核ledger/checksum、配置身份、无工作队列。恢复失败即停止，不启动候选。旧版本API只读连接保留schema回退，不反向DDL/DROP证据。
4. **P10原owner**候选API建议127.0.0.1:19303（先查占用）；SSH/DB动态端口记录实际值，不覆盖原服务。核 PID→端口→cwd→命令→commit→日志；使用本schema独占 `slide-singleton-workers` 外部租约持有者持续续约（5秒续，30秒租约），API必须standby。失去续约/意外worker/队列增长即优雅停候选。关闭cron/自动调查/通知/行动dispatch，STOP_NEW_DISPATCH=true；禁接其他目标的出口。
5. **P10原owner**基于 P12 已审原生采集证据，在候选schema复用唯一正式 metric store/发布/绑定/任务实现。只建立专属 server3 文件系统系列与mysql3308慢查询系列，不能建立第二套长期指标。先在无注入状态证明真实采集→正式publication/source binding→阈值告警/事件。候选API-only时由专用受控脚本调用现有生产端口：`metrics/scheduler/service.ts:MetricScheduler.tick/register`、`MysqlScheduleStore(pool,registry,'production')`、`MetricFormalization` 和原 `JobRegistry.execute`，持原SQL claim/fence执行本次tick生成的准确metric job（只允许两个目标）。正式consumer用 `metrics/consumers/operational.ts:evaluateOperationalRule`，告警用原evaluator工作流上下文，调查用 `investigations/system-event-bridge.ts` / `system-composition.ts`；保留原SQL事务、授权和幂等键。脚本不启动克隆全局worker，不直接INSERT观测/告警/结果/证据或改canonical状态。`ServerCollector.collectServer` / `MetricConfigurationService.trialCurrent` 当前为 `trial:true,persisted:false`，只能诊断，不能当正式采集证据。下一来源阶段原owner须交这个有界脚本及准确配置给父检查，然后执行；没有正式链不注入。
6. **P10原owner**在已有授权隔离卷/目录或mysql3308有界session内制造一个可恢复真实事件，沿既有collector/evaluator触发→事件→调查服务；调查通过真实runtime只读工具捕获原始证据与结构化结果。计划必须引用实际调查ID、最新resultVersion、同request/run的准确evidence ID/hash/version/deadline。不得使用测试里的SQL enrichment。若需要模型沿父canonical账本发前预留/实测结算（deepseek-flash），不从本次0调用推定重置额度。失败/usage未知不重放。
7. **P10原owner，父审绑定**恢复Q01所定义的受限账户/helper/专属unit，核指纹/bytes/config并运行固定inspect；不执行restart。根据实际资料和已审策略/验证器定义生成带短有效期的签名manifest，私钥留专属受保护路径；从已有真实来源发 `POST /api/operations/actions/plans`，保存返回完整不可变plan ID/version/contentHash及所有来源、策略、工具、配置与验证器bytes。通过原submit形成 pending_approval；检查used_count=0、action_executions=0、无action job。不在报告填空白ID要求Max批准。
8. **父协调**独立核正式来源/时钟/版本/hash/准确plan并把真实可审材料交两个真实分离主体（原作者/请求者不能自审）。P07由原owner在准确版本once批准齐备后接续Q02～Q18；任何变更/过期必须重新建准确材料/审批。P08仍等P07审定合入。无需重复授权环境，但本P10准备不代签、不创建假真人、不消费批准。

停止阈值：越界目标/共享库写、host-key或hash错、异常资源开销、时钟/usage未知、lease失效、任何未知动作结果，立即停止新派发/注入，保留operationId与日志，不重发。停候选前核队列/批准/未知结果；核本任务PID后SIGTERM，不按端口强杀。恢复本次前态并逐项核VM服务/PID/InvocationID、专属unit/账户/端口/目录、mysql3308有界session/数据；保留18文件及新增差异清单/审计。不得重启SSH、网络、VM或共享数据库进行恢复。

## 验证范围

本地test数据/签名/主体/SSH均synthetic。实际server子进程通过测试专用TCP重定向连接本机ssh2端点，完整验证真实SSH握手与host pin、固定inspect协议、MySQL迁移和JWT/HTTP；生产没有目标override。它证明装配行为，不证明实机helper已重新激活、真实正式来源、真人once或行动效果。测试不调用模型，不连接VM/mysql3308/共享服务。部署与所有真实输入依然由上述已授权下一阶段建立并交父核验，不能据此宣称P10整包通过。
