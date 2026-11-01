# MAX-237 原生模板完整用户流程

实现源码：`5171b1b41afa0cb8a81d44a521ea541eeeac5a21`；任务分支 `agent/15coder1/max-237`，保留起点 `a2c665cc9c0775677d72fd9e91d5c104bc1b1fd4`。唯一 PR #390。本文替代该 PR 早期“未挂载 T1”交付描述，不替代成员范围与授权。历史 T2B/T3 文档仅用于追溯。

## 实现与集成

以 `8b955c24e` 将 Chief 指定的 `2fe2a510221d853d5709e45c0368f1ff48a2bdea` 的 apps/frontend/scripts 生产者和消费方树接入原任务分支，未引入其祖先历史。`b85b54f33` 增加模板编辑流程；`5171b1b41` 保留安全来源的清理 CI/句柄忽略规则，修正运行时边界说明。原任务 AGENTS.md 的预存本地修改未入库；未更换分支、rebase/reset/amend。

复用 `MetricTemplateService`、注册能力目录、已接受 MySQL repository、连接事务适配与实时权限服务。新增入口放在“指标与采集”中的原生模板库，原采集包目录保留在详情中。支持名称搜索、数据库/服务器/网络类型与内置/自定义筛选、复制、指标选择、模板/监控项名称编辑、周期编辑、草稿保存、不可变发布和版本详情。关联资源入口使用既有三类资源页面；不虚构绑定统计或自动绑定资源。

监控项从已安装 release 精确选择，自动携带稳定 item 身份、canonical metric/semantic version、单位、值类型、维度、建议周期、implementation/原始字段/转换映射。未实现项另列原因，不提供可选操作；伪造选择仍被服务端拒绝。发布不代表某个目标已通过兼容性、权限和真实试采。

新迁移 142 仅增加 actor-scoped 操作幂等日志，不重做模板五表存储。每次写入的 operation_key 绑定 action、template ID 和规范化请求 hash；日志与模板编辑同一事务提交。并发同键只执行一次；同键不同内容拒绝；提交响应丢失可用原键重试。模板/草稿 CAS 保留。重名允许，但分配不同稳定身份，不按名称接历史。

每个写入在所有锁等待之后、提交之前用同一连接重新读取并锁定用户/session/grants；撤权则回滚模板及幂等日志。重试也重新鉴权。内置模板编辑拒绝，复制产生自定义草稿。读请求等待结束后再次鉴权，响应禁缓存。错误只返回稳定代码，不回传驱动详情。浏览器主体/权限事件清除旧数据，失败保持未知；未知写入保留同键重试，业务冲突允许重新读取草稿。

## 本轮验收矩阵

独占、随机 nonce 所属 MySQL 8.4 容器映射非 3306 端口；完整迁移、真实 JWT/Fastify/Lit。验收脚本只导入批准的三个固定 Zabbix 7.0.21 文件，核对原始 commit。未使用模型、子代理、生产 worker、共享3306写、实际解绑、通知或部署。

| 验收 | 证据与结果 |
|---|---|
| 搜索/类型筛选→复制→选注册能力→名称/周期编辑→草稿→发布→版本 | `e2e/max237-template-workflow.ts`，真实浏览器全流程通过；新增 MySQL 指标、监控项重命名及稳定身份验证 |
| 内置三类模板、来源与注册能力自动填充 | 实际 MySQL 导入/回读三份固定转换模板，能力 API 读取 registry；不声称本轮重新采集三类目标 |
| 空名/非法周期/重复项/缺实现 | 前后端负例通过；伪造指标422；重复 item ref 400；重复 canonical metric 的原服务回归复用 |
| 并发与幂等 | 同键并发复制返回相同 identity；不同内容同键409；草稿竞争一成一败；发布同键重试完全相等 |
| 已发布版本不可变、重名/重命名身份 | 改名后旧完整 snapshot 深比较相等；同名副本不同 ID；item 名称变化新增版本且保留 item ID，语义不兼容422 |
| 放弃未保存监控项编辑 | editor 按草稿精确 item version 回读；不误用最新孤立 item version |
| 权限与等待撤权 | viewer/无权限/内置修改负例；真实模板行锁期间撤销 metric:manage，最终403，模板原名与日志均回滚；旧成功重试也403 |
| 版本详情 | 从完整不可变 snapshot 展示项、参数、触发器引用、hash/发布时间；发现/专属图形明确未实现；既有资源入口可达 |
| 桌面与键盘 | 1440×900、1366×768、1920×1080截图；无页面横溢；未保存时Esc保留，Tab留在弹窗，关闭后焦点恢复打开按钮；浏览器无未捕获JS错误 |
| 清理 | schema所有权/server UUID核验后删除；精确容器ID+nonce核验后优雅停止；浏览器/Vite/Fastify/连接关闭；cleanup verified=true |

复现入口（仓库根目录）：

```bash
pnpm install --frozen-lockfile
pnpm --filter slide-api exec tsx e2e/max237-template-workflow.ts
```

前提：Docker已有 `mysql:8.4`；固定参考仓库 `/Users/max/Coding/40-Slide-references/zabbix` HEAD 为 `6542e21fe6adc8ab7bf903c2a9d1df80e80366cd`。脚本输出 nonce 证据目录；端口自动分配，拒绝3306；不读应用.env凭据。全过程同一前台脚本完成并清理，无遗留服务交接。

验证结果：

- 后端 `vitest run src/metrics src/contracts/metrics src/alert-event-access.test.ts src/security/server-instance-authorization.test.ts`：85文件、1119项通过；61文件/254项环境门控跳过，未计通过。
- 前端 `vitest run --maxWorkers=2`：155文件、1420项通过；后续仅边界文案改变，单文件2项及build/CSP复验。
- `pnpm security:test`：35文件336项通过；`pnpm security:scan`通过。
- API/frontend typecheck、contracts:check、build/CSP通过；生产脚本2个CSP检查通过，保留既有大chunk提示。
- 新增生产文件oxlint：0警告0错误；复用清理契约47项通过；`git diff --check`通过。
- 最终真实业务脚本绑定准确源码 `5171b1b41`，10组断言全部通过。Fastify序列化器有propertyNames strictTypes提示，但响应和全部业务断言成功；不隐藏日志。

首轮迁移因新增日志表/列缺少仓库要求的注释失败，修正后完整迁移通过；首次组件 mock 重用已消费 Response 导致失败，修正夹具后全量通过。失败记录与最终日志一并保留；没有盲重放模型或外部写入。

## 既有证据复用与原范围剩余

以下实现与 Chief 指定 safe source 对应文件完全相同，复用接受记录，未称本轮重测：

- MySQL/VM实际只读collector→正式writer→触发/保持/恢复及历史证据：[`MAX-239/final-acceptance-matrix.md`](https://github.com/max2055/Slide/blob/2fe2a510221d853d5709e45c0368f1ff48a2bdea/docs/slide/development/MAX-239/final-acceptance-matrix.md)。其最新矩阵包含VM后续已接受结果，不将更早网络故障当成现阻塞。
- 网络v2c/v3受控UDP、uint64/速率/未知、一次恢复与凭据负例：[`snmp-protocol-flow-20261101.md`](https://github.com/max2055/Slide/blob/2fe2a510221d853d5709e45c0368f1ff48a2bdea/docs/slide/development/MAX-239/snmp-protocol-flow-20261101.md)。按成员决定无需网络硬件部署，不声称硬件实测。
- 238 applied-envelope/绑定、239事件审计、242事实/草案返回、244维护及240历史消费：精确复用该安全来源生产代码。本项不重做这些引擎；原有最终跨项集成门禁仍由Chief汇总。

本轮交付为派发的完整模板编辑发布流程，不能据此将原整单全部范围标done。原范围尚未覆盖：PostgreSQL/Oracle/达梦原生模板逐项真实验收；完整模板继承/退役影响管理；发现执行和模板专属图形；各模板版本/最低权限/全部未支持项的完整用户资料；MySQL使用率current/limit、计数速率、Linux MemAvailable等原要求的逐项真实证据全覆盖。已有三类uptime/受控SNMP证据不冒充这些全部通过。关联资源入口已提供，未新增已绑定资源全量统计；完整平台导航矩阵未穷举。独立复核和当前SHA CI/合并门禁未由实现方替代。

交付保持 `in_review` 待Chief独立复核；不merge/deploy、不新建PR/规则/守卫/巡检或开发run。完整日志、截图、哈希、全部待推送对象与历史对象审计随本次Issue附件交付；CI只读一次事实。
