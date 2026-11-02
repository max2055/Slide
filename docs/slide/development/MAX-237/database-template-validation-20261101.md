# MAX-237 数据库模板逐项验收（2026-11-01）

本轮真实验收源码 `ec479476454f1b035bf93c9ec6ba3e551d5dc745`，保留平台指定 `e4583f2559bf2381cf15e94d36cdce03c3cd9e5a` 祖先，仅在 `agent/15coder1/max-237` 追加。生产实现与上轮完全相同；本轮仅新增验收脚本、三份人工候选定义、用户指南与本报告，不重做编辑/存储/绑定/事件/历史引擎，不在现有应用库安装模板。原 AGENTS.md 本地修改保留且不提交。

## 验收与证据

复现入口在仓库根目录：

```bash
pnpm install --frozen-lockfile
pnpm --filter slide-api exec tsx e2e/max237-database-templates.ts
```

需要 Docker 与 postgres:16.4/mysql:8.4；脚本创建独占容器和动态回环端口，拒绝共享3306。本次PG镜像 digest `sha256:e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412`，服务器实际返回 PostgreSQL 16.4 / aarch64，非合成响应。完整业务输出在本轮Issue附件的 `evidence.json`；本次 nonce `5867bf3a569506c3`。

| 验收目标 | 实际结果与边界 |
|---|---|
| 三引擎人工原生候选→注册映射 | PG5项、Oracle3项、达梦3项；通过真实模板服务selectMetric从当前配置注册表取得固定digest、单位/维度/实现/raw/transform；映射和版本资格全部写入证据 |
| PG正常只读采集 | 普通LOGIN/CONNECT账号，非超级用户，无业务表权限，default_transaction_read_only=on；5个raw与模板指标、单位、维度及collector逐项断言；capacity与服务器配置核对，disk为正数 |
| 只读/权限/超时 | CREATE TABLE被真实25006拒绝；pg_sleep触发原生57014，私有连接全部关闭；撤销CONNECT使固定采集器返回permission_denied与null，恢复CONNECT后正式采集good；无补0 |
| 计数连续性 | 首样本派生率counter_baseline/null；自有库真实pg_stat_reset后counter_reset/null；保留uint64和服务器观测时间、database OID/startup/reset epoch；未改值/时钟/collector |
| 资格前置拒绝 | PG17版本unsupported，解析transport次数0；不外推未注册版本 |
| 发布可用性 | 只读采集成功后发布不可变PG模板，真实MySQL repository读回固定版本；probe→trial→apply→两次CollectNow任务→前台正式worker.runOnce→10个good/uint64持久样本，稳定metric与raw来源可追踪 |
| 发布权限与不可变 | view-only发布TEMPLATE_FORBIDDEN；两次采集后模板版本完整内容不变；原R1/R2、JWT/Lit端到端与锁等待撤权证据复用，不声称本轮重测UI |
| Oracle/达梦 | 真实MySQL只创建候选草稿，current=null、versions=[]，未发布/激活/绑定/连接厂商实例；映射存在不等于实库资格 |
| 清理 | 所有权句柄/schema/server UUID核验后drop；精确容器ID+nonce核验后优雅stop，两容器不存在；资产连接、私有连接、admin、平台pool/root pool全部关闭；最终证据cleanup全部true |

`stored_observations` 保留正式writer写入行，`collections` 保留两次任务样本和attempt_ids，`baseline.raw` 保留原始字段、采样时刻、来源及版本。未验收PG历史页面/事件触发保持恢复，不把持久采样等同完整历史业务验收。没有产品模型、外部通知、生产worker、实际解绑或部署。

## 检查结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter slide-api typecheck` | 通过；生产代码未变 |
| `pnpm --filter slide-api exec vitest run src/metrics/database src/metrics/templates src/metrics/config/postgres-counter.test.ts src/metrics/config/postgres-counter.pg.test.ts` | 14文件185项通过；11文件64项环境门控跳过，不计通过 |
| `pnpm --filter slide-api exec vitest run src/metrics src/contracts/metrics src/alert-event-access.test.ts src/security/server-instance-authorization.test.ts` | 最终受影响模块gate：85文件1119项通过，61文件254项环境门控跳过 |
| `pnpm contracts:check` | 通过；公共契约未变 |
| 新e2e单独TypeScript检查 | 使用继承API tsconfig、include仅该e2e的临时配置，`tsc --noEmit -p .qualification/max237-db/tsconfig.json`通过；默认API tsconfig不包含e2e，未将二者混称 |
| 新e2e oxlint / git diff --check | 0警告0错误 / 通过 |
| 真实业务入口 | 6组验收断言通过，逐项样本/raw/权限/cleanup断言包含在内；命令exit 0 |

本轮没有生产代码/前端变更，复用已接受前端、安全与CSP结果，不无条件重复全量前端和模型测试。首轮失败是新脚本未按item_id排序，被既有AGGREGATE_ORDER校验正确拒绝；按稳定ID排序后通过，首轮失败日志和cleanup全部true保留。随后强化每项raw/单位/维度/collector与正式样本质量断言并在上述准确SHA完整重跑通过，没有放宽校验。

## 用户资料与剩余范围

`database-template-user-guide.md` 描述六类模板的版本、最小权限、单位/维度、默认参数、无预装规则、未支持项，以及命名/发布/资源测试应用的既有入口。`database-template-candidates.json`不是产品导入文件或部署产物；Oracle/达梦“不可应用”是本次交付资格限制，现有管理员编辑器不具有新的认证锁，未虚构此能力。

已核对父235当前正文/执行合同、237阶段接受记录及成员输入 `627966eff:docs/slide/development/MAX-235/member-inputs-20261027.md`：已授权外部采集对象只有MySQL/VM，没有Oracle/达梦目标。本worktree无应用.env，现有容器/镜像没有Oracle/达梦服务。本次不使用共享3306，不尝试猜测目标或凭据。

Oracle/达梦实库缺口由Chief协调Max提供已授权19.3/8.1目标、凭据引用和只读窗口，15coder1完成正常/异常/权限/计数连续性实测后才将对应候选交付为可用模板。生产transport目前未提供两引擎事务counterQuery连续性证据，不能从注册映射或合成数组推断事务率正常；届时属于具体实现方范围内需补齐的内部接线，不让Max提供代码契约。

本阶段可交独立复核，整单不得标done：Oracle/达梦真实资格、原要求MySQL使用率/速率及Linux MemAvailable逐项真实证据全覆盖、最终跨项集成和当前SHA门禁仍需Chief核对；模板继承/治理/发现依244/245分工，不在本轮重复实现。PG触发/恢复、历史页面也没有本轮真实证据。网络按成员决定受控协议验证，不列硬件部署阻塞。未合并、未部署，PR #390继续唯一交付入口；独立复核由既定Chief承接，不创建子代理或重复运行。
