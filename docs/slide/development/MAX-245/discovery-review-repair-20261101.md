# MAX-245 发现生命周期独立复核缺陷修复

本轮在同一发现业务流程中修复 Chief 报告的 R1/R2/R3，交回独立复核；未标整单完成，未发布。原分支 `agent/15coder1/max-245`，保留起点 `c3848a39464eb5ce4d4eb19031b9f0e8abe35a7c`，仅追加提交，未修改已有 AGENTS.md 工作区内容，无子代理。

## 准确源码与范围

- 源码：`a098655a243625f11e0c51a14cde5486302bdd14`。
- 源码 tree：`19e5a172ae0cf1f30befebe38618a469e144cdd0`。
- 相对本轮起点：8 文件，210 行增加、34 行删除；其中包含回归和真实验收脚本。
- 相对候选 parent `ce0d28671be9167dd03b20bd81d52d6fcc836118`：260 文件。不是仅本轮修复文件可直接发布，父链及完整范围仍须 Chief 决定。
- 证据包包含两份完整差异文件清单、本轮修复 patch、候选 parent 对完整源码 tree 的逐文件状态/行数统计与 diff SHA256，以及相对最初开发起点变化的 359 个源码文件 SHA256。完整差异可按准确 parent/source 从本地 Git 对象复核。

## 缺陷与正确行为

| 复核项 | 修复及验证 |
|---|---|
| R1 不完整枚举误推进退役 | 注册生产/试采路径必须获得起止 ifNumber、非倒退 uptime，ifTable 行数与两次计数一致，行 ifIndex 与索引一致，ifXTable 不出现基表外索引。缺失、空表但计数非零、少行、计数在 walk 中变化均失败/unknown。失败不生成正式样本，也不更新发现实例、项或事件；跨过退役期限仍不推进。只有完整空枚举进入等待期。 |
| R2 集合基数改变身份 | 固定使用可信 MAC/type，不随集合基数增减 index。MAC/type 重复时整个枚举 unknown，不登记猜测实例。兄弟消失后原接口保持同 ID；新 collector、设备重启、改名、ifIndex 变更仍保持身份，换 MAC 的真实复用产生新实例。Counter 连续性仍独立重置，不制造速率。 |
| R3 旧行操作串到当前资源 | 资源/版本/权限上下文变化使旧请求失效并取消。状态读取有加载态和请求序号，最近刷新胜出。行操作绑定读取快照的资源、版本、会话及行引用，旧快照不能发起停止；选择器不参与重定向。过期预览不启动新资源状态读取。停止在 B 提交后即使响应迟到，也不能覆盖已切到 A 的界面。 |

共享 authFetch 额外拒绝让已取消请求的迟到 401 触发刷新/会话清理；正常认证逻辑保持。对应 API 回归有独立 RED→GREEN。当前状态加载失败后旧行操作保持禁用，必须重新成功读取。

## 验证证据

- RED：`8918a509d`，SNMP 7 项正确行为断言失败、前端 5 项失败，确认原实现缺陷；`442c9ee7d`，取消请求的迟到 401 正确行为断言失败。
- GREEN：后端受影响模块 **804 passed / 168 opt-in skipped**；前端相关 **65 passed**。跳过项不记为通过。
- 后端/前端 typecheck、前端 build、`pnpm contracts:check`、`git diff --check` 通过。
- 准确源码真实演练：`pnpm --filter slide-api exec tsx e2e/max245-discovery.ts`，nonce `1a8aeee1777d6048`，**12 组通过，error 无，cleanup=true**。脚本在 `evidence.source` 记录准确源码 SHA。
- 真实链路：Lit/Chromium → JWT/Fastify → 独占临时 MySQL 8.4（随机非3306，owned schema）→ 受控 UDP SNMP → 原正式 writer/唯一事件/历史读侧。
- 新增 R1/R2 通过受控端点产生矛盾/不完整响应，沿原调度/采集任务写入失败证据，检查正式状态完整不变和唯一事件不分裂；随后完整空枚举、等待、重现、禁用/退役及历史读取仍通过。
- R3 浏览器使用两个授权资源，B 特意植入与 A 相同 instance/revision 的碰撞 fixture；真实 JWT GET/stop 路由验证隔离，延迟响应并注入旧 401/403。此 B fixture 用于证明最坏操作碰撞，未宣称 B 通过了真实 SNMP 采集。
- 三桌面尺寸、空/加载/错误、键盘焦点、零 pageerror 均通过；截图及机器可读证据附包。浏览器、Vite、Fastify、SNMP、owned schema 和容器均清理，未留本轮容器。

可复现检查：

```sh
pnpm --filter slide-api exec vitest run src/metrics/templates src/metrics/bindings src/metrics/triggers src/metrics/scheduler src/metrics/consumers src/metrics/snmp src/metrics/config src/contracts/metrics src/contracts/public-api.test.ts
pnpm --filter slide-frontend exec vitest run src/app/ui/components/template-library.test.ts src/app/ui/components/native-template-configuration.test.ts src/app/ui/components/template-trigger-editor.test.ts src/app/ui/components/template-discovery.test.ts src/api/index.test.ts
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm --filter slide-api exec tsx e2e/max245-discovery.ts
```

演练端点显式提供表外合法 sentinel，使空表 walk 正常终止；不把协议错误当成功空枚举，不在产品代码放宽校验。

## 安全及发布边界

官方 gitleaks v8.30.1 下载后校验官方 checksum。新增提交 `c3848a394..a098655a2` 扫描 **0 命中**；准确源码全部祖先重新扫描仍有 **52,835 条自动命中，10 个历史提交**（JWT 75 / generic-api-key 52,760），均来自既有祖先。未把自动命中全部判定为真秘密；原历史凭据风险限制继续保留。

原始验收目录扫描有 2 条 generic-api-key 命中，均定位为 evidence.json 两处相同的浏览器生成公开 collect caller_key（幂等操作 ID，非认证凭据）；逐位置核验，无确认秘密。交付附脱敏扫描和分类摘要，不附巨大祖先明细或秘密值。打包扫描另确认源码哈希清单中的 12 条 generic-api-key 命中均为文件内容 SHA256；证据包保留这些可核验哈希。候选父链的完整 patch 含既有历史验收材料删除上下文，并出现 23 条额外命中，故不作为附件传播；交付该完整 diff 的 SHA256、260 文件状态/行数及精确 parent/source，交 Chief 在 Git 对象中审查。最终包内保留 14 条已分类的哈希/公开操作 ID 误报，无确认秘密。

未 push、未建 PR、未创建安全发布头。交 Chief 的候选仍为上述 parent / 精确 source tree 及 260 文件完整范围，不能把候选父链推断为获准。不更换祖先或改写当前分支来绕过限制。

## 保留范围与接续

本轮仅修复本次确认的同一发现流程缺陷。趋势聚合、容量治理、隔离历史回放、SSH/数据库真实动态矩阵和最终跨分支集成仍保留；受控 SNMP 证据不等于真实网络硬件部署。未重新开发已接受上游能力，未使用共享3306、生产 worker、真实通知、解绑、危险删除、部署或产品模型，模型 token 使用为 0，未重置累计预算。

状态交 `in_review --no-start`，由既有 MAX-245 唯一终态订阅及 Chief 独立复核承接；不新增回调、守卫或巡检。本轮修复通过不代表整单 done 或发布 gate 已通过。
