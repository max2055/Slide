# Docker 空间调查：2026-10-04

> 后续清理已完成：经用户明确授权，75 个清单匿名卷（16.94 GB）已全部删除，749 项未使用构建缓存已清空。复核其余 66 个卷、77 个镜像、23 个容器均保留，8 个运行容器状态未变。独立可回收量按清理前卷大小与非共享缓存计算约 36.74 GB；未测量宿主机物理空间变化。匿名卷删除不可由 Docker 撤销，缓存可重新构建。详见 [清理回执](cleanup-receipt.json)。下文保留清理前调查快照，脚本修复仍未实施。

## 范围与结论

检查对象：本机 maxair15 的 Docker Desktop（desktop-linux，Engine 29.7.2）以及 10 月 3 日启动的 Slide 审计整改任务。时间均以北京时间解释，清单保留 UTC 原始时间。仅诊断与分类，不清理既有资源、不停止服务、不修改业务代码。预算未设定；实际 token/费用遥测不可用；未派生代理。

本轮主要遗留是 **75 个无人引用的匿名数据库卷，共 16,940,362,220 字节（16.94 GB）**，创建于 10 月 3 日 14:37:05 至 10 月 4 日 04:47:36。10 月 3 日 40 个（8,970,325,874 字节），10 月 4 日凌晨 35 个（7,970,036,346 字节）。

根因是数据库测试容器的清理遗漏卷：MySQL/PostgreSQL 镜像声明 VOLUME，即使启动命令没有显式挂载，也会生成匿名卷；脚本使用 `docker run --rm`，退出清理却显式执行 `docker rm -f`，在当前 Docker 版本中留下匿名卷。已用全新空探针实测复现；`docker rm -fv` 对照测试能一并删除卷。

这批卷的时间、体积与任务的真实隔离数据库验收高度吻合，属于高置信度批次归因。卷仅有 anonymous 标签，无 task/run 标签，原容器已删除，无法逐卷证明具体归属哪个子任务；本报告不把推断写成逐卷追溯事实。

## 任务与代码证据

Multica 父任务 MAX-107 和 MAX-108～123 共 16 个子任务均为 done，父任务 active runs 为空；收尾 PR #128 已于北京时间 10 月 4 日 05:29:53 合并。最终集成证据报告生成于 04:50:42，与最后一批卷的 04:47:36 时间相邻。

调查使用已合并的 `c3195b46c81f6855bab32ee4e5b622575d7ce031` 及 MAX-123 实际工作树。用户根目录仍是旧 `main@7916d44`，没有为本次诊断更新或切换该目录。

实际任务工作树：
`/Users/max/multica_workspaces_desktop-api.multica.ai/helene-u0xo-f53fbd8f8fe6/max-123-0522ad615f7b/max123-integration`

|证据路径（相对上述工作树）|发现|
|---|---|
|`scripts/qualification/run-environment.sh:19`|清理为 docker rm -f；第 23 行启动带 --rm|
|`scripts/qualification/run-pg-collection.sh:10`|同时删除 PG/MySQL 容器但不删除卷；第 16、20 行启动带 --rm|
|`tests/qualification/startup-readiness.test.ts:198`|清理参数为 rm、-f；第 58 行启动带 --rm|
|`run-alert-event-transitions.sh`、`run-analysis-recovery.sh`、`run-audit-browser.sh`、`run-instance-removal.sh`、`run-metric-retention.sh`、`run-report-recovery.sh`（均在 scripts/qualification）|同类清理模式|
|`scripts/qualification/run-audit-integration.sh`|完整验收串联多个独立数据库专项|
|`docs/slide/audits/2026-10-04-max123-integration.md`|明确真实隔离 MySQL/PG、专项验证及一次最终完整 gate；只记录容器/服务无残留，未核验卷|
|`docs/slide/audits/2026-10-04-max123-integration-evidence.json`|Docker 29.7.2、MySQL 8.4.10、PG 16.14、命令退出码与生成时间|

各工作包的专项测试加最终集成测试会多次创建数据库，因此 75 个卷不等于 75 个智能体，也不意味着业务数据库增长。现存容器最新创建于 9 月 22 日，没有留下昨天的测试容器。

## 空间快照与分类

单位采用十进制 GB。Docker 逻辑占用不是 macOS 立即释放的物理空间；Docker Desktop 的稀疏磁盘不一定同步缩小。镜像与缓存共享层不能重复相加。

|对象|数量|总占用|Docker 显示可回收|
|---|---:|---:|---:|
|镜像|77|58.36 GB|29.86 GB|
|容器|23（8 运行）|4.757 GB|4.757 GB|
|卷|141（15 被引用）|约 31.62 GB|25.61 GB|
|构建缓存|749|47.86 GB|19.80 GB|

### 优先候选

1. **本轮 75 个匿名卷，16.94 GB**：目前引用数全部为零，任务已经结束。建议按 [精确卷清单](candidate-volumes.json) 定向清理。清理前再次核验名称、创建时间与零引用；由于缺少任务标签，保留本报告的归因限制。
2. **未使用、非共享构建缓存，19,802,862,695 字节（19.80 GB）**：可回收，不涉及数据库内容，代价是后续构建需要重新生成部分缓存。这些缓存记录创建于 4 月 2 日至 9 月 24 日，不是昨天新建；不能归因于昨日整改。此项为 Docker 全局缓存，涉及其他项目。
3. 上述两类合计约 **36.74 GB** Docker 逻辑空间。它们互不重叠，但这是可回收估算，不是实际清理结果。

### 次级候选：旧测试夹具

以下均为 9 月已停止的测试容器，其关联卷合计 **1,446,490,368 字节（1.45 GB）**。若不再需要历史测试数据库，可连同对应卷定向删除；它们不是昨天新增，也不在 75 个孤儿卷内。

|容器|ID|匿名卷|
|---|---|---|
|max74-config-mysql|e1a15bb68b85|3c73286094bafcf75537d4e7eea440ccccd7cba1f9f673ca6ff2fdc513dbded5|
|slide-max69-mysql|3ca905f72eda|ed1ab2e83e8540263a874335535154d78c503d7d3b5d9efd366c236ed6949617|
|slide-max65-mysql|e0ae137f5eed|5c5a8678708bb5ce0b353cd6e90d2e4a5b8eafa9c488b04c27dcd9b313f21033|
|slide-max58-fault-test|49bd2ea06181|ae796cb9c248e83cd2caad53ff400ecb0857e1b6798534c4510cd250dcb09318|
|slide-max54-mysql|80d636d02813|b0e438bea7a99947576b749e56f01e5c6c4f2a48380ad84208cc44c13331b79b|
|slide-evidence-qualification-20260908|5d5e0a7d0ebb|0365185dfe502d3ae1c433f1440781de01a067973d083b6549d380f8f1ced824|

旧 `slide_mysql-data`、`slide_agent-state` 卷均为零字节且无引用，可列为旧空卷候选，但没有实际空间收益。

### 保留或先确认用途

- **oracle19c**：虽然停止，但约 **4.7 GB** 位于容器可写层，而且没有数据挂载。删除容器会直接丢失其中数据库文件，是“容器可回收”数字的主要来源，不能当缓存清理。
- `slide-local_mysql-data`（约 3.99 GB）、`slide-local_agent-state` 以及运行中的 Slide/MySQL/TSDRM 容器和卷：保留。
- `51-decorix_postgres_data`、`n8n_data`：停止项目的数据仍被容器引用，保留。
- `mysql_data`：225,146,027 字节，无引用但用途不明；先识别来源，不能仅凭 unused 删除。
- 其余旧匿名孤儿卷约 **8.44 GB**：没有足够归属证据，本轮不纳入可直接清理清单。
- `dameng`、`mysql3307`、`mysql3308`、`postgresql`、`mongodb`、`redis` 等真实数据库容器：即使停止也不作为测试残留删除；部分数据位于宿主机 bind mount，不计入 Docker 卷占用。
- 未使用镜像：Docker 显示 29.86 GB 可回收，但可能包含离线发布/回滚镜像，先确认用途与重新获取能力。一个无标签未引用镜像逻辑大小约 2.25 GB，但共享层使实际收益不等于该数值，不计入优先回收估算。

## 动态复现与诊断资源清理

仅使用 mysql:8.4 的 sleep 入口，不启动 MySQL、不挂载既有数据、禁用网络、只读根文件系统、移除 capabilities。

- 第一个探针在自然退出后自行删除，卷清单与基线一致。
- force2 探针：AutoRemove=true；容器 `f9407b186d9ecd137cab663183bae94661b3e8f43f5e809f9123e67fe371e5f9` 被 rm -f 后，卷 `5d0fc9c5fc1531085437a523e1866bb6e8372c218a96e8f8eb128db6a96b34c4` 仍存在、没有容器引用。随后仅删除此探针新建的空卷。
- volumes 对照探针：AutoRemove=true；容器 `083717b29fe55c74bfda0b487260490151befc4ea9acb436906f5b91a4153dd3` 使用 rm -fv 删除后，卷 `ce09b8218a95e8a0aaf01581593cfab12f4c9ff389b37301a2da2c2a7d91ea07` inspect 返回 no such volume。
- 结束时基线 141 个卷无缺失、无新增，容器总数恢复 23。**没有删除任何调查前存在的资源。**

## 防止复发的建议（未实施）

- 对脚本自己创建的临时测试容器，清理时使用 rm -fv，或显式管理并清理对应测试卷；不将此规则应用到正式数据容器。
- 为测试资源增加项目、任务、run ID 标签，记录明确资源 ID。
- 清理验收同时检查容器和卷，并保留错误证据；不要仅凭容器不存在宣称资源清理完成。
- 长期证据保存为日志/测试报告，而非遗留整套数据库卷。
- 不采用无差别 docker system prune --volumes；精准清理清单与缓存管理分开执行。

交付验收：根因已动态复现、75 个候选完整列出、旧数据风险已分类、临时探针已清理。现有数据清理与脚本修复尚未执行。
