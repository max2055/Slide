# 模板触发器到现有事件中心

本次实现一个已注册指标 `mysql.processlist.count@1.0.0`（单位 `count`）的完整流程。三类实机与真实外部正式通知没有验收；受控值并非真实目标负载。历史 checkpoint、纯算法文件 journal 和旧 CI 均不作为本候选的数据库事务或浏览器证据。

## 唯一入口与生产者/消费者

| 生产者 | 消费者 | 约束 |
| --- | --- | --- |
| Lit `template-trigger-editor` → POST `templates/:id/triggers` | `TriggerPublicationService` → 已有模板 repository/service | 结构化受限 AST；独立问题/恢复；参数、版本和 content hash 固定；不丢弃他人未发布草稿；同连接发布规则和模板新版本 |
| MAX238 原生模板绑定/试采/应用 | `mysql-host`、`binding-service` → `metric_trigger_snapshots` | 同资源、固定 template/item/规则版本及参数来源；发布配置仍为 pending，不把试采当正式样本 |
| 已有 scheduler / `MysqlScheduleStore.writeTemplateResults` | 严格 `templates-applied-v1` codec → runtime adapter | 正常正式观察值、attempt/source-check 写入成功，所有选中指标可用后才转换 applied；旧 `templates-v1` 不放宽；没有独立正式 writer |
| 同一正式 writer 的 observation | `evaluateTemplateSamples` → 已接受 compiler/resolver/evaluator/episode | exact applied fence、配置/规则/item/维度身份；源时间水位线；重复/迟到不回放；窗口缓存有界 |
| 已有 `alert-engine` 时钟 | `evaluateTemplateClock` → 同一 adapter | 显式 nodata；普通缺测、过期、单位不符仍未知，不冒充恢复；没有新增 worker/轮询器 |
| adapter 的 episode 转换 | `alertEventService.persistTemplateTransition` → `alertDatabaseService.createAlert`、已有 `alert_events` | 一个既有事件/告警中心；opening 快照不被后续配置覆盖；恢复最多一次 |
| 既有 `NotificationDispatchScheduler` | 既有 `workflow_jobs` → 既有 notification delivery handler/账本 | 同连接 outbox；复用原 `notification:alert:channel` 幂等键、投递状态和记录；没有第二通知账本 |
| GET/acknowledge `template-events/:id` | 现有 `event-management` 内 Lit 详情 | 当前配置与历史分开；确认只改处理状态；回读 sample/attempt ID、值、单位、源时间、规则/模板/config 版本与回执 |

MAX238 依赖来源是 `88fc15e2bce814218ff2f1836a33d57ff236eef6`，原始逐路径源 blob 表保留在 `producer-source-map.json`。最终发布审计另外给出本候选的目标 blob 与本次扩展路径，不能把源表当成最终同一性声明。

直接相关的最小公共扩展包括严格应用成功 envelope、规则发布/事件证据 DTO、递归 AST 的生成类型，以及原配置状态入口对 source-check 精确样本的核对。该状态入口只读既有 `metric_observations`，核对正常 writer 的样本身份、资源和 config revision 后显示正式可见；不合成 rollout generation，不改 MAX240 query/storage/formal-store 读方法。前端不再把已经 applied 的同版本 pending 描述成待执行。

## 事务与线性化点

- 规则发布：模板父行锁串行化，规则版本与模板新版本同连接提交；锁前、锁后与最终提交前均重读权限。发布结果未知时销毁连接，客户端重载固定版本，不盲目重放。
- 正式写：沿用既有 policy/resource/job 锁和最终授权/lease fence。正式样本、attempt/source-check、applied envelope、episode/head、告警/事件及通知 workflow job 同事务提交。最终 MySQL commit 是线性化点，注入中断测试确认全部回滚。
- 评估：`metric_trigger_heads` 主键绑定资源、规则版本/body、配置快照/item/维度，行锁串行化转换；`sample_watermark` 只接受严格更新的源时间。同 ID/同时间/迟到样本不会重新打开已恢复的 occurrence。未知保留打开 episode 和未知区间。
- `metric_trigger_inputs` 只是正式样本的有界评估缓存（24 小时、4096 条、每规则最多32个维度）；不替代正式 store。窗口只使用有覆盖证据的切片，间隔缺口不补造覆盖。预算超出拒绝本次事务，不截断规则。
- 历史 opening 固定保存规则、模板、配置、指标、单位、源样本值/时间/身份；last 为最新判定。90 改95创建新版本/配置身份，旧事件仍读90。
- 确认使用 episode 行锁，实时校验 alert:view/alert:manage 及资源读/写权限，首次确认写一次审计；不创建通知任务、不执行运维、不恢复。通用手工 resolve 拒绝模板来源，通用编辑不能篡改模板事件来源。旧 NULL source 告警保持可操作。

## 可复现验收

使用独占、标记所有权的 MySQL 8.4、非3306随机环回端口；禁止加载生产凭据或连接共享实例。实际端口、nonce、PID、episode/sample/attempt/template/config ID 与时间记录在随交付附加的 `business-evidence.json` 和资源清理记录中。

```bash
MAX239_FLOW=1 MAX238_TEST_MYSQL_PORT=<独占非3306端口> \
MAX238_TEST_MYSQL_PASSWORD=<测试root密码> MAX238_TARGET_PASSWORD=<测试只读账号密码> \
MAX238_HANDLE_DIR=./.max239-flow-handles \
pnpm --filter slide-api exec vitest run src/metrics/templates/trigger-flow.mysql.test.ts --maxWorkers=1

MAX238_TEST_MYSQL_PORT=<同一独占端口> MAX238_TEST_MYSQL_PASSWORD=<测试root密码> \
MAX238_TARGET_PASSWORD=<测试只读账号密码> \
MAX239_EVIDENCE_DIR=/Users/max/Coding/40-Slide/outputs/<本run目录> \
pnpm --filter slide-api exec tsx e2e/max239-flow.browser.ts
```

浏览器控制器前台启动真实 Lit/Vite、Fastify、独占 MySQL，浏览器编辑并发布规则，经过真实只读 MySQL probe/试采、绑定/应用、立即采集及既有正式 writer。95/85/60/null 等值由受控 collector transport 输入正常采集路径，不能称为真实实例负载验收。没有预种事件。

API 确实终止旧 Node PID，再以不同 PID 重连同一数据库；85保持同一 episode，60仅恢复一次。对外通知使用固定隔离环回 HTTP transport 接入既有 delivery handler/状态/记录，验证实际 HTTP 回执；这是本地受控证据，不是正式外部送达。未注册或调用产品 AI handler。

真实 MySQL 集成覆盖中断回滚（含通知任务）、95/85/60、90/70边界、迟到/重复正式输入、未知/时钟过期、显式 nodata、窗口覆盖/缺口、确认幂等与手工恢复拒绝、来源篡改拒绝、请求权限403和等待数据库锁期间会话撤销401。浏览器覆盖90→95历史分离、正常正式样本、通知追溯和1440×900/1366×768/1920×1080无横向溢出及基本焦点。

最终门禁包括受影响模块测试、API/frontend typecheck、contracts:check、frontend build/CSP。跳过的 gated 实机/数据库测试不计为通过；构建现有大 chunk 提示不作功能失败。独立复核仍由 Chief 按最终候选执行，未把实现方自检冒称独立复核。

## 留存边界

仅清理本 run nonce、确切 container ID、PID/cwd、schema handle 所属资源；未知不得按前缀/端口清理。正式产品模型调用0；没有使用产品预算重试 Provider，没有新建终态订阅。整单保持 in_progress、done 留成员。三类实机及真实外部正式通道/回执保留未完成；不 merge/deploy 或开启生产 worker。
