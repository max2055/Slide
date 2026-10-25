# V2＋V3 方案与新增 PR189/195 兼容性核对

核对日期：2026-10-16。范围：新增两个已合并PR的实际diff、当前main相关源码、方案proposal-1及原型R1设计说明。未做全仓代码审查、真实部署或新的业务验收。

## 结论

**没有发现需要推翻方案的核心功能或架构冲突。** 两个PR没有新增可信案例、行为基线、行动计划或变更执行器，也没有修改本方案依赖的ResourceRelation、公开契约、工具审批服务和共享主题token。需要修正的是旧基线事实与资源页集成约束。

当前HEAD、本地main、origin/main及GitHub main均为 `47f8f4f1f185b03cbbd5b9a1d73825d2428245d7`。旧方案基线 `4c00819a` 后的first-parent合并恰为以下两项：

| PR | 准确head / merge | 本次读取的检查 |
|---|---|---|
| [189：资源详情R1.1](https://github.com/max2055/Slide/pull/189) | `0976c67437af449a8eae2b8a57d70ecc2e8f5273` / `e2d1365747f9c5d28e54bdda97e6861ed159e65a` | MERGED；14项SUCCESS，含ci-gate |
| [195：HTTPS/WSS](https://github.com/max2055/Slide/pull/195) | `5a58cf51bab44ae3bc9971e1b75eb99c21758bba` / `47f8f4f1f185b03cbbd5b9a1d73825d2428245d7` | MERGED；14项SUCCESS，含ci-gate |

GitHub正文和R11历史交付报告仍有“draft/等待CI”的时点文字，以本次PR状态、准确head检查和merge包含性为当前事实。检查成功不等于重新验证了共享在线环境，也未据此认定仓库分支保护配置。

## 对齐项

### 1. 资源上下文按R1.1现有页面挂载

PR189把概览改为状态、风险、证据缺口和下一步，指标/日志各有职责，调查入口压缩为紧凑行。参见 `frontend/src/app/ui/views/instance-detail.ts:548`、`server-detail.ts:450`、`network-device-detail.ts:348`、`components/resource-investigation-links.ts:56`。

原型R1的 `#context` 将关系和基线并列展示，适合内容审阅，但不能整页覆盖新资源概览；否则会重新造成信息重复，也会覆盖PR189的上下文清理。这是**集成位置需要澄清**，不是新增知识库/行动中心视觉风格冲突。

方案现明确：基线在已有“指标与趋势”；服务器/网络复用“关联资源”；数据库关系在概览中按需展开。P09补充三类资源详情最小挂载点和必要semantic-metrics所有权。原型不新增正式一级菜单。资源页实际接入设计仍需提供三类页签内对照，当前未修改可交互原型、未宣称该项对照已完成。

### 2. 不能为基线或验证倒退证据/采集语义

- `apps/db-ops-api/src/metrics-v2/scheduler/store.ts:54`：停用revision首次由真实fenced worker应用后，不再周期入队。P04消费正式观测；不能为了积累基线自行启用采集或以任务数量充当有效样本。
- `apps/db-ops-api/src/security/sensitive-data.ts:7`：合法Date转ISO、非法Date转null，支持来源/过期审计；不代表所有来源已具备版本与质量。
- `apps/db-ops-api/src/server-diagnostic-service.ts:123`及`:338`：固定journald投影和partial/truncated保留，不可把截断当完整反证。
- `frontend/src/app/ui/views/server-detail.ts:291`附近的显式POST采集，以及metrics/logs的generation/contextVersion与撤权清理，必须在新面板延续。查看、刷新及WS重连不得产生行动。

R11真实Agent读的是legacy connections，V2调度验证的是uptime；不能合并为同一时间序列，不能当作V2 cutover或2～4周基线资格。R11的事实/根因/恢复限制及厂商SNMP/共享环境未验收边界继续保留。

### 3. 继承WSS，不扩大环境授权

PR195只改 `deploy/HTTPS.md`、`deploy/SECURITY.md` 和 `scripts/qualification/check-tls-transport.py`，未改产品API、权限、数据库、审批或执行器。既有 `frontend/src/app/ui/direct-gateway.ts:98` 已根据页面协议选择同源 `/agent-ws`。

P10/P11复用现有连接和身份/权限校验，不硬编码ws或暴露28888。隔离回显验证不能替代真实Edge、认证、Agent消息和断线恢复。受影响环境证书/切换与Edge验收由Max按既有安排执行；本次不代为切换、不部署生产，未验收的环境只限制相关环境资格。

## 已同步的文档与验证边界

- 方案更新为proposal-1.1：最新main、PR189/195状态、第1.1节兼容约束、资源页信息架构、P09文件所有权及B17回归项。
- 初始核验记录保留在planning-evidence.json；追加本次复核而不覆盖历史PR和V1任务状态。
- 没有改变≥30真实案例、14/28天有效观测、双人审批、单次批准、未知不重发或用户确认门槛。
- 本次使用Git差异和GitHub准确head CI作核验；没有重跑产品测试、调用模型或远程操作。仅文档/核验记录变更，不存在待合并的V2/V3代码分支，因此不声称已完成未来分支的Git冲突演练。
