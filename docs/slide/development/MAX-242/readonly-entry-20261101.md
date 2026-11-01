# 只读调查入口与生产者接入契约

本轮承接2026-11-01授权，消费MAX-240候选`29a2029eaa05d827a2c11b58a2f95a1a05ebe4b9`（含239安全头`0a9eec2e13b03c7665c025080fce799f769247fe`），复用现有Investigation/Session/Run。没有新增调查引擎。本轮只完成来源上下文→草案→授权事实→保存/返回来源；模型分析、结构化补充、行动审批执行和实际恢复验证不在本轮完成声明内。

## 240 / 239 可直接调用的公开入口

```ts
import { investigationEntryHref } from '../controllers/investigation-entry.ts';

// 使用用户已选定的绝对窗口，不在点击或重试时重算相对时间。
const href = investigationEntryHref({
  schemaVersion: 1,
  resourceRefs: [{ type: 'instance', id: resourceId, role: 'primary' }],
  from: selectedFrom, // canonical UTC，例如2026-10-31T00:00:00.000Z
  to: selectedTo,
  metric: { id: metric.definition.id, semantic_version: metric.definition.semantic_version },
  dimensions: { ...series.dimensions },
  sourceEventIds: selectedEventIds, // 真实数字event ID；资源入口传[]
  returnTo: location.pathname + location.search + location.hash,
}, basePath);
// 在现有按钮/链接中使用href进入统一工作空间。
```

资源入口可省略`metric`和`dimensions`，服务器/网络设备沿用`server`/`network_device`类型。指标入口必须同时保留语义版本和完整维度；带metric的入口仅支持一个明确资源，不隐式复制一个指标到多个资源。跨资源无metric可传最多20个显式资源，且恰好一个primary。不得填入未选择的关联资源。

路由为`/investigations?entry=<encodeURIComponent(JSON.stringify(context))>`；有部署basePath时helper会保留前缀。`returnTo`当前允许站内资源、事件和调查路由（含详情），拒绝外站、协议相对地址、反斜线和编码分隔符。来源路由若后续新增，需先扩充服务端白名单及测试；当前不静默丢弃返回位置。

组件`<investigation-entry .context=${context}>`在统一工作空间内展示草案；保存后的同组件以`.investigationId`读取持久化上下文。组件发出`investigation-draft-created`（`{id}`）和`investigation-entry-denied`，工作空间以现有controller衔接历史/详情，后者清除原详情和敏感草稿。240仅需接入helper生成的正式路由；本轮没有编辑240的`semantic-metrics.ts`、历史API、238持久化或241三类详情布局。

## HTTP公开契约

均需真实JWT，所有成功/拒绝响应为`private, no-store`。完整TypeBox/OpenAPI及生成类型已纳入`contracts:check`。

| API | 行为 |
|---|---|
| `POST /api/investigations/entry-facts` | body为`InvestigationEntryContext`；只读预览，不创建调查/Session/Run/job，不调用模型。 |
| `POST /api/investigations/drafts` | 同body，必须带`Idempotency-Key`。原`bridge.create`不传firstRequest，仅保存现有Investigation/Session；200返回`{id,context,modelInvoked:false}`。 |
| `GET /api/investigations/:id/context-facts` | 读取原`command_snapshot.context.entry`和现时授权事实；不接受覆盖scope的query。 |

事实响应为`{context,facts,modelInvoked:false}`。精确metric使用240的`observations`服务，最多200条，保留`total/has_more/next_cursor`及每条质量、source、版本；界面明确标识分页，不宣称完整展示。资源入口调用既有history核心指标查询；缺数据保持空/未知，不回退latest、不扩大窗口、不把空值写成零。后续生产者可复用原始观测分页接口按相同context翻页。

context被保存为创建命令不可变快照，未新增表或迁移。原`POST /api/investigations`的“创建并分析”兼容接口保持原语义，页面打开不调用它。显式分析仍由既有`/:id/runs`控制。

## 拒绝、撤权与未知提交

- 服务端严格拒绝未知字段、无效资源/角色/重复资源、非法日期、未来/反向/超过31天窗口、无效metric或dimensions；拒绝而非取整或默默裁剪。
- 复用现有Investigation实时身份/资源存在/资源权限检查，读取前后检查全scope；metric消费者保留自己的最终授权。源event需当前`alert:view`和事件资源权限，且必须属于显式scope，读取后再验。
- 保存前校验同一context的授权事实；幂等键进入原`investigation_create_keys`，并行/重复请求返回同一调查。相同key不同command返回409。没有Run/request/job创建或模型预算预留。
- 浏览器在发送前把原key写入sessionStorage，存储键为用户身份与context的SHA-256，存储值只有随机幂等键。上下文/凭据不以明文存入该重试索引；写失败时不发送。刷新/返回原链接继续原key。未知提交锁定原命令并提示核对原请求。
- 401/403/404清除已读事实和来源链接，并通知原工作空间清除详情；权限/会话事件立即清屏，丢弃晚到响应。重新聚焦/恢复可见时重新读授权事实。撤权不会自动停止正式采集或关闭事件。

## 验证边界

浏览器测试`frontend/e2e/MAX-242-entry.spec.ts`使用任务自有非3306 MySQL、完整迁移、生产server、真实密码登录/JWT和真实API、DB、浏览器。正式观测与事件是受控数据夹具（沿用真实观测存储及事件writer），不冒充本轮目标实机采集证明。所有Provider禁用，另设本地模型请求计数守卫。按1440×900、1366×768、1920×1080验收，包含键盘/焦点、来源保留、空数据、错误/越权、幂等并行/冲突、未知保存和撤权。真实模型调用必须为0。

不重做已接受原型，不合并部署，不访问共享3306，不实际解绑，不外发通知；唯一终态订阅保持不变。整单更广泛分析/审批执行/恢复闭环仍待后续范围验收，不能用本次只读入口代表全范围done。

## 240读取器集成更新

PR568于本轮收尾追加`9b6c7ab4523b1627fc2860611d0fe2b66f654ba0`，将内部任务读取器与HTTP读取器拆分。本项已追加合入该安全候选，并显式消费`authenticatedMetricConsumerService`；不能用内部`metricConsumerService`替代用户事实读取。初始29a2029验证保留为历史，最终集成候选另行绑定源码和证据。
