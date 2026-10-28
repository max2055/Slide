MAX238-FIXTURE-CLEANUP-R5 独立复核（2026-10-28 UTC）

结论：准确交付 `b0d2bdc84f2fb2b6ab645244ae9d66d3f9648259` 的 fixture 清理判定与 CI 接入有界接受。R3 公开 keyed 授权/协议接受继续保留；MAX238/MAX235 整单仍 in_progress。下一 ready 原范围包 MAX238-ROLLOUT-CONTRACT-REGRESSION 直接交现有15coder1；不等待整单P0/P1/done。

准确对象：开发 run `01a18389-68ec-7c24-a24d-804ae5e57066`，actor `45c6e088-9615-48ae-a675-f91d1447c25e`，attempt1，17:23:07Z–17:27:26Z，completed/error=null。实现 `d49a63da0`、交付 `b0d2bdc84`、基点 `39077b228f345171bef3289a2dbda4374df54c03`；作者评论 `01a1838d-46c4-7149-ad1b-e684e1cb240f` 与 Git/run result 一致。API 没有独立 checkpoint 字段，不以 completed 替代接受。exact once 回调 `01a18389-72ad-7cb5-bc21-d991ee61d1cb` 消费1次、enabled=false、last_error=null，本次 Chief run `01a1838d-9220-748c-91b5-04f58afbf185`。不恢复旧规则。

已读最新 MAX238 continuation_policy v25/handoff、父 MAX235 policy/watch/handoff、子78根/父27根线程摘要，展开 R5作者/R4复核/父PR问题相关线程；没有新成员暂停取消。按 Multica issue管理契约执行单结果评论与精确交接；保留运行期 AGENTS.md 修改和 Chief 任务起点。

独立验证：

- 准确三源码哈希与作者证据匹配。仅 shell判定、shell回归、现有 frontend CI 两行接入变化，另两份证据文档；生产/产品src、公开契约、API fixture/spec/config均未变。
- 执行准确 R5 的受控清理回归：47 passed/0 failed；bash -n 退出0。直接复用 R4 独立 inspect-counterexamples.py 对准确R5公开入口复测：初始query错误、rm成功后query错误、rm失败后query错误、cleanup-handle query错误均 exit1，处置文件保留；未触碰真实daemon。结果在 counterexample-recheck.json。
- 独立真实 Docker：本次两个带唯一nonce/owner标签的停止容器（无SQL、无映射端口），错误owner返回1且双方存在；正确owner只删自己的确切ID、邻居存在；重复清理为真实not-found/exit0；邻居按自身owner删除，健康listing核实本次两个ID均不存在。见 docker-evidence.json。该演练不能冒充MySQL事务或真实采集证据。
- YAML独立解析通过，frontend现有job在Run tests后调用轻量受控回归。现有plan/test脚本未改；作者22项CI脚本测试证据复用。R3 accepted32/MySQL4/API type/contracts、R4作者 Chromium4/一次性journal/信号关闭/typechecks/contracts及 PUBLISH-REJECTIONS c14b06a00 源码未变化，复用，不重复浏览器/DB/全量门禁。

源码审查：ref_state保留inspect stderr/exit code，Docker不可达或普通inspect错误返回unknown；仅Docker not-found答复进入absent。各入口、post-rm与rm失败后复查均共用该判定。APIshutdown/afterAll继续委托同一脚本；unknown非零并保留启动期handle，删除仍使用owner标签核验后的确切ID。错误owner/同前缀邻居保护、API只作归属核对均保留。控制命令不是真实daemon故障，真实断连/超时/服务端错误未在本机注入。只接受本机Docker明确not-found与受控错误契约；不声称跨Docker版本/语言的完整错误矩阵。未变浏览器证据仍使用fixture admin/trial，真实登录、目标采集、正式history/event链和整单UI接受未完成。

安全 PR：草稿 [PR567](https://github.com/max2055/Slide/pull/567) head `74115f22f9179a033fe774d1213962a0c3ea1a35`、base main `e11f6ba2ed8108af585af022c4acf8817c1d1fec`。从已审干净head `0bbdeaf4dc18f8804157d938cd8a0fa4a2b2b781` 追加1提交/9对象/3blob，全部新增blob扫描秘密模式/危险产物路径0命中，三文件逐字节匹配准确交付；原风险祖先继续隔离，不直接push任务历史。扫描为有界证据，非绝对无秘密证明。描述已更新R4/R5、整单未接受和关联CI失败。17:30:47Z一次性快照28项：9成功/0失败/19运行；不能宣称全绿或旧失败已修。未watch/重跑CI/合并/部署。见 pr-audit.json。

下一包 producer/consumer 已核：

`policy/service.ts` 经 `resolvePolicy` 产生完整 Published(binding/resolved/published_at/application)，`policy/store.ts` JSON序列化存储；`policy/model.ts` 与main旧基线的Published核心形态一致。`resolver.ts` 返回完整计划、8项settings、来源、metric_templates、依赖、timeout与impact。`bindings/persistence-codec.ts` 要求完整legacy载荷，并校验resolved.plan的资源/配置revision/package/policy身份与settings一致；effective只有已应用revision可证时存在，不能用pending快照猜旧生效版本。`package-reader.ts` 是共享拒绝边界；coordinator/portfolio通过它读现有绑定，模板行/损坏行不得当legacy健康行。

失败输入：coordinator.mysql.test.ts的published()只给resolved.settings.enabled，portfolio.mysql.test.ts的published()缺resolved/published_at及完整application。旧CI run40732529727 job122972501786分片8三项EFFECTIVE_INVALID；job122972501816分片6一项LEGACY_INVALID。日志与四个用例见R4 ci-failures.json。当前新CI未出这些最终结果，不能把旧33通过/36跳过当相关MySQL门禁完成。形态上符合夹具漂移，但需下一包在一次性非3306 MySQL复现，使用真实发布/解析产物证明，再决定修夹具或确实的兼容缺陷；不预设必须放宽codec，也不将真实旧行兼容问题掩盖为夹具。

producer-consumer-inputs.json 固定10个读写/测试输入blob；均与干净PR一致，8个 MAX240 输入仍与已接受 R3 一致。下一包默认所有权是这两个 rollout MySQL测试与最小真实夹具/契约回归；确认生产缺陷才修最小bindings边界，安全复核重跑受影响守卫。禁止修改MAX240 query/storage读方法/formal-store读方法/consumers、写入新源、迁移、worker、真实切换和activate规则。

MAX236–245均fresh读状态/policy（family-contract-state.json），上期contracts-and-readiness逐项保留：236容量SLO/实际writer入场，237模板候选不等运行完成，239规则引用→有效快照→现有评估单writer，241/242实际页面/Run输入，243–245事实前置未自动放行；事实/owner/恢复条件沿用表，普通producer实现由Chief继续协调而非人工缺key阻塞。MAX240 run `01a18374-c736-7af5-902b-bf0147f61750` 独立在途、callback `01a18374-cdb0-7d36-bdbe-aa757b7813f2` 不重派，不以MAX238未done阻断。本期下一包不缺外部输入。

本次实际派发、fresh全局全部页/家族槽位、唯一callback和父子阶段读回见 dispatch-receipt.json。所有生产操作hold、既有activate试采成功/必要指标谓词和名单保持；无子代理、模型、MAX224账本、3306业务写、部署/worker/停写/复制/切换/回退/解绑。
