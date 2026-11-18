# 消费者与构建来源技术包（作者报告）

输入 head：`3e253c5c9a8f68a8242c807cf52a42d1a3676fda`；PR base/merge-base：`451ab8c9969f18d94f17392a74301294de82b5e1`。交付继续追加到原 PR #920，不改写起点历史。最终完整 head、命令退出码和证据校验和随受控 REPORT.md、Issue 交付；本页不把输入 head 称为包含本页的新提交。

## 351 条消费者调查

[consumer-chains-20261117.json](consumer-chains-20261117.json) 覆盖本轮全部 351 个 ID、148 个文件、120 组实际消费者结论。[原台账](artifact-fields.json) 每条新增 consumerReview，绑定链路、目标/配置来源、当前行和文件/行 SHA256。sourceReview 保留上一轮历史调查，不把其中旧的 needs-sink-proof 字段解释为本轮没有调查；previousStatus/previousAdjudication 保留原状态。全表仍为原 657 条，未删记录、未新增扫描例外。

结论按实际接收方区分：本地投影/验证/脱敏、注入的 SQL/HTTP/SNMP/SSH 替身、明确创建的 loopback 接收器或容器、调用方选择的真实数据库/API，以及历史说明。每个 ID 都有具体消费者描述，不能只凭目录名或文件哈希判断安全。真实 SQL 中的合成业务字段与驱动登录凭据分别记录；创建任务 schema 不等于 SQL server 也属于本任务。

本轮完成的是源码消费者裁定，**不是 351 条全部风险关闭**。下列真实或可覆盖入口仍须运行方提供目标身份、账号来源和资源授权：

| ID / 链路 | 已查明行为与实际限制 |
|---|---|
| W032–W034 | runtime 包装器把 DB_PASSWORD 转交实际 MySQL 测试；DB_HOST/PORT/USER 可选择已有服务器，创建 schema 不证明服务器归属。缺值回退已修复，变量存在仍不等于资源授权 |
| W048 | 标准 run-report-recovery 创建容器并传同一 docker port/密码；直接调用 observation 可独立指定容器和端口，docker inspect 不独立证明二者对应 |
| W056–W060 | run-existing-mysql 的 docker 容器和 TCP 地址分别可配置，必须核对二者身份；只清理其资格验收 schema 的规则不能证明共享服务器已授权 |
| W337、W480–W482 | 真实错误密码认证与 PG 采集；PG 标准 runner 创建对应账号/容器，但直接传端口不构成容器身份证据 |
| W460 | smoke 的管理员登录和创建用户是真实 HTTP；SMOKE_BASE_URL 可覆盖，CLI 不提供目标隔离和既有用户清理。随机新密码不改变已经由旧脚本创建的固定密码账号；旧账号由 owner 盘点处置 |
| W610、W620、W622、W627–W631、W635、W646 | Playwright page.request 仍是真实 API。managed runner 的 bootstrap/独占服务规则只有在实际使用该 runner 且未覆盖目标时成立。W620 还创建 enabled 通知渠道并执行报告投递，需核对真实接收端；不能因示例 URL 或合成 secret 认定不会外发。W627/W628 创建独特用户名后登录/撤销并清理，不是已有管理员密码 |
| 各 SQL-backed 夹具 | 已逐项标明实际 SQL 配置和任务 schema；本轮没有连接共享数据库或以静态 schema 前缀签收服务器身份 |

其余本地/替身结论只覆盖相应值在该调用路径的用途；不证明任意同值在其他历史、进程或外部副本中均无效。R3、此前入口修复和本轮新增结论仍待 Chief 统一安排原 Reviewer 独立核验。

## 两处新修复与验证

1. `run-agent-runtime.sh --mode mysql` 在任何运行子进程之前检查 DB_PASSWORD 是否被定义，缺值退出 64；保留显式空字符串供独占无密码夹具使用。三个测试环境变量直接转交同一输入。已有模式回归明确注入空值，不把必填改回默认值。
2. `smoke-test.ts` 的建用户请求从公开固定密码改为每次进程用 crypto.randomBytes 生成；不修改产品 API，也不借此授权运行真实建用户操作。

验证：54/54 脚本测试通过；10/10 smoke 实际 CLI 回归通过（每次启动替换 fetch，比较两次建用户密码的摘要，确保新值不同）；后端 typecheck 通过。runtime 实际 CLI 测试拦截 pnpm，覆盖缺值在工作启动前拒绝及显式空/非空输入按原值传给三个消费者。源码策略和新增秘密扫描均为 0。此处没有运行浏览器/数据库业务，CLI 替身回归不替代这些验收。

首个提交全量扫描退出 1，348 个匹配、225 个二进制路径。随后最终 PR 区间检查发现此前入口修复带来的五个函数引用匹配，按下述 CI 根因修复后，全量为 343 个匹配、225 个二进制，退出仍为 1。该结果按“仍有匹配”如实保留，不是全量清洁。台账/新语义分类不参与扫描器放行。

首个提交 `506fa070c91540a0ae292692171260ada598a7d8` 对应 run `44065512536` 为 completed/failure：首个有效错误是 plan 的秘密增量检查，release-artifact/ci-gate 是同根因传播，没有该候选可用发布包。PR base/head 本地复现五处 credential-field-unquoted，均来自此前修复的 `qualificationPassword()` 函数引用。受影响两份 Playwright spec 现在先在测试体读取局部 password，再用对象简写传入，保留真实使用时必填校验，不改扫描器、不加例外。修复后的 PR base→工作树检查为 0，前端 typecheck 通过；两文件 20 个用例收集通过，只说明收集成功，不代表浏览器/数据库业务通过。新 head 的 CI/发布物另行记录，不继承此失败 run 或旧成功 run。

当前执行环境原先没有 node/pnpm 的 PATH，也没有 worktree 依赖；使用仓库声明的 pnpm 11.19.0、相同 lock 的离线缓存安装，lock 未变。打包的 Node 24 执行脚本测试；其应用签名限制阻止第三方 native binding，因此另用官方独立 Node 22.16.0（下载包 SHA256 对照官方 SHASUMS）运行 Vitest/typecheck。早期 Node 22 直接执行 TS 的两处失败为运行版本差异；旧模式夹具缺密码的一处失败由本次必填变更引入并已修正。最终结果分别留存，未删除失败日志。

## 九处构建映射

[paired-build-mappings-20261117.json](paired-build-mappings-20261117.json) 使用九个新 PF ID，包含精确整匹配/捕获组偏移、原包文件/视图哈希、源码语句哈希及实际语义。五处对应登录翻译字段（英文密码标签/placeholder/显示/隐藏，以及中文 placeholder）；四处对应预算校验文案（automatic daily、total daily、contextWindowTokens、maxExecutionTokens）。后两处是赋给 errors 属性的错误文字，名称含 Tokens 不表示认证令牌。

输入固定为 artifact `14302744472`，RELEASE commit `86c13d9a49d9c9a42755aa31a6d7d8cdd5699b16`；ZIP SHA256 `ddfe5206d817b6a493c0c3b205fc1509dd1940f5c74feac7100a06cb8d532df7`；tar SHA256 `62f0479079e7e71654c9ba3b9815b84b0f815daa136a0785bd0f4d1cc1d36e55`。本轮没有重新下载原包。

Reviewer 交接目录 SHA256SUMS 全部通过。后端重跑恢复脚本，657 条输出与交接输出字节一致；九处再逐个核对完整正则、捕获组、HMAC、源码字段及原包内准确字符串。原文和 HMAC 密钥仅在内存/受控输入使用，不入库、不上传。映射由原包源码建立，不把后来源码相同视作后来构建文件相同。

**旧 W647–W655 的历史匹配身份仍无法独立证实。** 原始扫描只留 path/line/rule，原临时脚本当时未归档；恢复脚本哈希只能证明本次实现。legacyOrdinalCandidate 仅表示恢复顺序候选。旧 W 记录完整保留，replayEvidence 仅指向新 PF 证据，不将 57 个文字候选强分配给旧 ID。W656/W657 继续原版本限定结论。

## A1–F1 与剩余边界

| 项 | 本轮结果 / 仍需完成 |
|---|---|
| A1 | 351 条剩余源码消费者全部逐 ID 作出作者裁定；九处新 PF 源码映射完成。旧 W 身份不可追溯明确保留；真实活动消费者和账号签收仍由 Chief 协调 |
| B1 | 持久 manifest 注入、两次独立 claim 未执行；owner/admin 责任及原方案不变 |
| B2 | 新增 runtime 缺值/显式空兼容、随机建用户密码 CLI 回归；不表示所有历史入口的真实资源迁移验收完成 |
| C1 | 真实 JWT、登录、实时权限、HTTP/WS 会话切换未执行 |
| C2 | 真实两库改密、旧池/在途事务和采集未执行；消费者/账号/窗口待协调 |
| C3 | 真实切换前后业务/密文/备份和唯一账本保全验收未执行；未调用模型、未改变账本或原加密密钥 |
| D1 | R1/R2 和技能/lock 问题保持独立关闭；R3、入口与本轮新增证据待统一独立复核，作者报告不自行放行 |
| D2 | 本轮精确来源和消费者证据已补；扫描并非基线清洁或任意格式秘密不存在的证明。图像像素/字体深层语义及既有未知格式边界继续保留 |
| E1 | 历史下载暂停；shallow 缺父、远端独有/隐藏 ref、全部历史产物、服务端 LFS 孤儿、外部副本和完整恢复仍未覆盖，未再重试 mirror |
| F1 | 本地检查与代码绑定；最终候选 CI/发布物只接受其自己的 head、合成提交、RELEASE、哈希、源码一致性与扫描证据。旧 CI/包不迁移；不重置 watch、不轮询 |

受控证据入口：项目 `outputs/max-681-consumer-chains/REPORT.md`、`SHA256SUMS`；扫描交接仍为 `outputs/max-681-paired-field-handoff-20261117/README.md`。该技术包供独立审查；整单保持 in_progress，不构成共享配置/写入、真实切换、删除、历史改写/强推、合并或发布授权。

## R4 更正

本页此前把部分 Playwright 实例密码裁定为管理员/viewer 登录输入，该结论已由独立复核 R4 否定。[R4 修复与更正索引](r4-credential-binding-20261117.md) 接续 W633/W637/W639 及同类 W614/W616 的实际数据库认证调用链、完整输入分离、缺值回归及 3/3 真实业务证据；原历史快照不能覆盖本次更正。旧候选 7b9ebe8… 的 CI/发布物成功结论按独立复核接收，不能迁移到修复后的候选。
