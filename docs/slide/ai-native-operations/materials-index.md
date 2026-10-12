# R00 实施材料索引

这些材料是V1.1实施输入和Review裁定，不是已有产品能力说明。仓库默认分支与后续验收应以 [Review对齐矩阵](review-alignment.md) 为入口，主调度任务为MAX-140（`01a12b4a-05bc-767f-96ba-70446f34907f`）。

## 可在任意checkout取用的材料

|文件|用途 / 来源|边界|
|---|---|---|
|[implementation-baseline.md](implementation-baseline.md)|父任务原文实施基线v1.1，原附件`01a12b4b-3bf1-7cbd-a1ca-bd15936b5e1a`|按原文保留历史方案和A01–A18；本机绝对路径仅作历史引用，当前入口见本索引；不是已实现能力|
|[menu-addendum.md](menu-addendum.md)|父任务菜单决定，原附件`01a12b4b-3e7c-770e-80a1-6389c1c2b7e6`|T06复用现有路由/权限/共享组件；System/Ops是Profile；V2/V3入口隐藏|
|[prototype.html](prototype.html)|原单文件原型，原附件`01a12b4b-42e1-730d-9a90-9da3a1d614a2`|可离线打开；所有数据/模型/权限/持久化均为演示；V3为future预览|
|[prototype-verification.input.json](evidence/prototype-verification.input.json)|原资料包24项Chromium原型检查记录|原设计验证记录，非R00重新验证；未证明真实业务、Safari或Firefox|
|[candidate-ledger.md](candidate-ledger.md)、[JSON](evidence/candidate-ledger.json)|重点38文件、180最终候选+17快照独有位置|保留每条来源、源码SHA/hash、证据缺口、归属；不是全仓确认报告|
|[input-provenance.json](evidence/input-provenance.json)|附件manifest逐项校验，最新Review文件hash/mtime及所选路径覆盖|不提交大体积原始Review；mtime与取得时间分开|
|[partial-delta.json](evidence/partial-delta.json)|阶段快照未在最终报告独立保留的位置|报告去重不是代码修复，17个位置都已登记|
|[reproduce.mts](evidence/reproduce.mts)、[结果](evidence/probe-results.json)|outbox、实例边界、非成功结果、late projection有界复现|无网络/业务数据库/模型调用；executor模拟SQL边界不能替代真实MySQL|
|[mysql-json-comparison.json](evidence/mysql-json-comparison.json)|真实MySQL9.6.0常量SELECT|只否定FINAL-0080的恒空断言；无表读取或写入，不证明crash recovery|
|[validation.md](validation.md)|当前命令、结果、文档核验与未完成项|当前PR/CI/合并状态单独移交，未使用历史head结果|
|[t01-contract-baseline.md](t01-contract-baseline.md)|T01 契约使用、数据生产位置、confirmed/pending 与后续责任映射|baseline-only，不解除 R00 领域门禁|
|[t01-samples.json](evidence/t01-samples.json)|第13.3节固定40样本，带脱敏合成快照与正反证据|T11 runner 输入；尚未运行模型评估，不替代真实资源夹具|
|[t01-validation.md](t01-validation.md)、[结果](evidence/t01-baseline-results.json)|T01 当前验收和逐文件测试基线、失败分类|不替代 T12 真实链路与最终 gate；CI/合并证据见任务交付|

原型截图和图册仍在资料包：`outputs/2026-10-11-ai-workspace/screens/01-attention.png`至`13-mobile-evidence.png`、`review.html`。这些路径指**下载解包后的相对路径**；不要假设存在作者本机的outputs目录。资料包没有完整的原型构建/验证源脚本，本仓库交付仅承诺已生成HTML可取用，不凭原README提到的build.mjs/verify.mjs宣称可重建。

## 原附件的CLI取用

已登录且有Slide项目访问权限的执行环境，可从仓库内建立私有下载目录，使用Multica CLI。无权限时需要授权持有者交接同一hash的资料；不能绕过平台认证请求资源URL。

```bash
mkdir -p .multica/r00-inputs
multica issue get 01a12b4a-05bc-767f-96ba-70446f34907f --output json
multica attachment download 01a12b4b-4fd6-7434-85eb-539890035766 -o .multica/r00-inputs
multica attachment download 01a12b4b-51ec-7bd2-b0d6-801fe8673b9d -o .multica/r00-inputs
# 在下载目录检查 .sha256 后，再列包内容并解包到独立目录。
```

原包2,545,916 bytes；包SHA-256和27项文件hash保存在来源账本。本次已核验。快照中RUNNING含历史PID/恢复命令，仅作历史证据，不能运行或停止当时进程。最终Review尚未作为独立原始附件镜像；本PR的精选候选/当前源码行段、报告hash及覆盖记录足够支撑已作出的裁定，其他候选仍pending，不以本机原路径当跨环境交付。

## 规则逐项整合

|指定规则|默认分支对比|纳入决定与有效内容|
|---|---|---|
|[根AGENTS.md](../../../AGENTS.md)|原main为旧架构/命令/示例凭据/按端口强杀及集中前端规则；没有fb0766d6之后远端改动|采用附件更新版；准确区分平台MySQL与纳管类型、capability边界；环境加载、进程身份、范围/授权、真实验收、输出目录及300MB包限额。前端细则拆到专用文件。**不提交Multica自动运行时块**|
|[frontend/AGENTS.md](../../../frontend/AGENTS.md)|main没有该文件，任务现有本地文本与附件相同|共享组件、主题token、Shadow/Light DOM、Lit binding、键盘/焦点与原型证据边界|
|[source-sync.md](../development/source-sync.md)|main没有该文件，任务现有本地文本与附件相同|分阶段错误与代理/凭据规则；真实sync→Commit→manifest→重复sync，不启用unsafe生产捷径|
|[resource-governance.md](../development/resource-governance.md)|main没有该文件，任务现有本地文本与附件相同|input含缓存、不双加；单调统计、不冒充实测；无硬预算不设人为预算门槛|
|[Multica专项技能](../../../.agents/skills/multica-issue-management/SKILL.md)|main没有该技能，任务本地已有3个文件|为新版根规则表中的链接提供可执行说明，仅纳入SKILL.md、agents/openai.yaml、scripts/multica-issue.sh，保留已有CLI/auth/不误启动约束|

四份附件规则与当前任务规则正文相同；远端无后续有效增量需要另行合并。只提交上表规则、该专项技能及本目录列出的方案/证据文件；不提交其他技能删除、本地审计报告、xlsx、tar发布包、原始Review或`.multica/r00-inputs`。

## 子任务定位

stage及依赖以MAX-140当前Issue为准；这里提供稳定UUID，便于不依赖聊天历史取用。

|任务|Issue|UUID|
|---|---|---|
|R00|MAX-141|`01a12b4b-6207-7367-84ef-63d959a0a4b7`|
|T01|MAX-142|`01a12b4b-7ced-7694-a4aa-5f54f3d66dd5`|
|T02|MAX-143|`01a12b4b-96f6-7a4c-a222-09fac7f6d202`|
|T03|MAX-144|`01a12b4b-b036-75b6-8a39-9f7bbb400bc0`|
|T04|MAX-145|`01a12b4b-cbd6-7eee-8e46-d57949b5d1ca`|
|T05|MAX-147|`01a12b4c-046c-7327-8f74-78f23cac53b9`|
|T06|MAX-148|`01a12b4c-21e0-711b-8bf9-2d5a57a55cf8`|
|T07|MAX-146|`01a12b4b-e57b-7d6f-a50d-e4e02c414ee6`|
|T08|MAX-149|`01a12b4c-4299-7e43-b117-0b5e8d0a6bd6`|
|T09|MAX-150|`01a12b4c-5bd5-75ce-a757-aa0a6dbc46f9`|
|T10|MAX-152|`01a12b4c-913e-7348-96ec-d435df1779d0`|
|T11|MAX-151|`01a12b4c-77fd-7db4-933f-200e1041b005`|
|T12|MAX-153|`01a12b4c-b1dd-74b8-b378-46267a3cc4fc`|
