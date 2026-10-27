# MAX238-B1：固定模板绑定预检准入

2026-10-27 14:04 接续巡检决定。授权沿用 MAX235 已批准的范围内精确包及独立 P1 接续；不等待 MAX236 整单 done。本包是 MAX238 原范围的可独立实施子集，不代表整项或生产验收通过。

## 目标与基线

实现未挂载的内部绑定预检模块：读取固定发布版本，核验 pin 与内容哈希，输出保留模板归属的项目/采集包组合，并显式拒绝跨模板 canonical metric 冲突。它为后续绑定 compiler 提供输入，不调用正式采集、应用或存储。

继续 MAX238 自己的平台任务分支，不切换其他任务分支，不合并 MAX236/237 整条开发历史。以其实际起始 HEAD 为代码基线，记录差异和 SHA。先读任务原文、当前 metadata/评论、根规则、源码同步与资源治理规则。

已核对可读取的准确输入：

- MAX236 REAL-C R1 HEAD `228c942ffe3bd3ad66d4e5a6eecdd0982efbf4c4` 的 `contracts/metrics/templates.ts`。
- MAX237 已接受 T1 HEAD `1d7f9e1f9c5a1649a7791b995691b72f5b21f887` 的同文件；两者 blob 均为 `bdd455ccc218c9e8543eaee6ad5bc5686f414170`。
- 该 T1 的 `metrics/templates/model.ts` 提供 `templateContentHash`，按 `stable(aggregate)` 重算；`source_chain` 不属于 aggregate 哈希。
- 该 T1 `TemplateRepository.getVersion(templateId: string, version: VersionNumber): Promise<TemplateVersion | null>` 是准确读端口。`MetricTemplateService.detail()` 读取 current，不能用它替代固定版本读取。
- 当前 `metrics/scheduler/compiler.ts` 只支持单 package。B1 不改它，也不声称它已经支持多 pin。

## 唯一写入边界

新增 `apps/db-ops-api/src/metrics/bindings/` 下 B1 的预检实现、局部类型/错误和对应 focused tests；文档/证据写 `docs/slide/development/MAX-238/`。不在该目录复制另一个 policy resolver、模板发布服务或 scheduler。

为避免第二套 schema/hash，授予两个精确的基线提取例外：若当前分支缺失，允许从上述 T1 HEAD **逐字节**提取 `apps/db-ops-api/src/contracts/metrics/templates.ts` 和 `apps/db-ops-api/src/metrics/templates/model.ts`，分别核对原 blob；若已有不同内容，先报告差异，不覆盖、不自行重定义。这两个文件本轮不得修改，MAX237 仍拥有 templates 实现；本例外不放开其他共享文件。

只读：contracts index/definitions/public-api、生成契约、server/路由、policy model/resolver/store、scheduler compiler/store/runtime、237其余源码及 DDL、前端/导航/共享组件、事件/历史实现。无数据库、SSH、共享环境、部署、真实采集、模型 Provider 或子代理操作。Zabbix 无需新增研究；不得移植其实现。

## B1 行为契约

1. 输入是现有 `ResourceBindingCandidateSchema` 对应的已存在 binding 快照，以及注入的只读 `getVersion` 端口。binding 的 resource/package/group_id/overrides/revision 原样保留；不引入第二绑定事实、第二 revision 或持久化。B1 不接受/分配初始 revision=0，不实现新建发布事务。
2. 用现有 schema 拒绝重复/乱序 pin、非法版本、空 pin 且 package=null 等输入，不静默去重或重排掩盖无效输入。pin 必须是数字固定版本和准确 content_hash；不能跟随 current。
3. 每个 pin 仅按 `(template_id, version)` 读取；验证返回对象 schema、身份、状态 published，以及 pin hash=返回 hash=重算 aggregate hash。缺失、身份替换、retired、内容被篡改或读取失败均返回稳定的内部机器错误；不返回成功的部分组合，不泄露存储异常。读端口不自带资源授权证明，调用方授权集成另验。
4. 多模板结果保留每个完整 pin、`(template_id,item_id)` 项身份及准确 immutable package release。相同 item_id 在两个模板下仍是两个不同身份；不得只以 item_id 建 map，不得把多 pin 压成 legacy package。每个项目的 composition 覆盖与 collector release 由既有 schema 校验，输出引用仍带模板归属。
5. 以 canonical `(metric.id, semantic_version)` 检测跨模板提供者重叠；B1 保守地将所有重叠报告为显式冲突（包括同值、不同 unit/dimension 的情况），带双方 pin/item 及稳定机器码。不得后者覆盖前者，不以显示 message 作为身份。本包不设计冲突解决 UI 或优先级。
6. 参数 schema/defaults、trigger refs、source_chain 保留为每 pin 的来源信息，不扁平合并同名参数，不生成 effective trigger/评估/事件，也不冒充完整参数最终值与来源链。冲突排序稳定；不修改输入和读端口返回对象。
7. 空 template_pins + 有效 legacy package 为明确的 legacy 分支，原样保留 package；不调用模板端口，不称已编译。非空 pins 可保留候选 schema 允许的 legacy package，但仅作为兼容字段，不能据此替换 pin。空绑定不是解绑。
8. 正向结果只能称 `preflight` / 未编译候选：不得带 applied/healthy/首样本成功、正式测试成功、授权已通过、CAS 已成功等结论。revision 比较和并发原子 CAS、测试 digest/revision/权限失效、参数覆盖解析、package registry 实现核验、真正多 release 编译及 wiring 属于后续准确包；文档列清这些缺口。

可以选择符合现有模式的局部函数命名和错误类型，但不能增加第二套公开 schema；超出此边界的直接阻塞先记录最小事实，仅暂停受影响步骤。

## 验收与停止条件

focused tests 至少覆盖：有效双 pin/多 release且每项保留归属；相同 item_id 不同模板不碰撞；canonical 重叠含同值与 unit/dimension 不同均显式拒绝；不同 semantic_version 不误判同一 identity；旧版本在 current 改变后仍固定；缺失/retired/错身份/hash伪造/aggregate篡改/端口异常；重复乱序/空绑定/legacy分支；source_chain 改变不改变 hash；输入与读结果不被修改；失败无部分成功和异常秘密泄漏。反例应断言业务结果和端口调用，不只镜像实现。

运行 B1 focused checks、受影响 metrics 模块检查和 API typecheck；提取契约时核对 blob并按实际影响运行 contracts:check（失败先分类，不擅改生成文件）。不机械重跑已接受全量测试、不新增真实资源操作或 CI 轮询。证据绑定实际 HEAD、命令及结果，明确局部通过不等于 A06/A07/A09/A16/A20 整体通过。

完成后提交当前任务分支，回报准确 HEAD、允许文件 diff、输入来源、机器码与反例结果、未实现项、下一步最小契约/集成事实。本包停止于内部预检实现和验证，禁止继续自行接入生产。独立准确终态回调由 Chief 登记并复审；MAX238 整体保持 in_progress。

## 后续归属

Chief 在 B1 接受后精确决定 B2（现有 payload.binding CAS/测试配置一致性及真正多 release compiler）；缺少的 shared wiring 只阻塞 B2 相应动作，不倒退要求 MAX236 整单完成。238 owns binding/compiler，239 owns evaluation/events，240 owns history。保留原五项/A01–A22、四标准、D05/O02/O03、同批1000万实测预算与人工听读排除；无产品模型请求时本包不消耗该测试预算。
