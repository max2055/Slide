# MAX-245 发现流程透明认证刷新修复

本轮修复 Chief 的 R3 补充/P1：正常 access token 轮换后，读取、预览和停止回执被丢弃并永久加载。R1/R2 及原资源切换问题已由 Chief 关闭，保留其有效证据。本轮交回独立复核，未标整单 done。

## 对象与最小实现

- 分支：`agent/15coder1/max-245`；起点 `d7893a5d3bb1573f2e94b7b67b982cb0e585eb1e`，仅追加。
- 准确源码：`1974eb0538991982fb51cbf201469868497c2db7`。
- 源码 tree：`5415aad557f50f8fb62e43a186a4a3d22eddb668`。
- 相对起点：5 文件，159 行增加、6 行删除，包含测试和真实验收脚本。
- 原因：组件将完整 access token 当作会话标识，合法刷新也被当作身份变化；同一检查同时阻止成功结果投影和 busy 清理。
- 共享 ApiClient 提供进程内会话代次。显式登录/setToken、退出或外部 token 替换推进代次；只有由同一刷新会话确认的 token 轮换保留代次。组件保存非敏感代次，不再保存完整 token。该代次仅用于界面结果归属，不替代后端 JWT 和实时权限校验。
- 刷新请求在写新 token 前再次核对代次；若已换登录，旧刷新成功/拒绝响应均不能覆盖或清理新登录。
- 组件继续核对资源、版本、generation、请求序号和来源快照。真实会话变化会清空旧结果并结束旧加载；权限/会话失效事件仍沿原路径失效。外部直接写 token 保守视为上下文变化，不尝试从未校验的 JWT 内容推导权限。
- 停止网络结果未知时不自动重试，旧行操作保持失效，使用只读刷新核对实际状态。

## 验证

RED 提交 `c69eb571c`：实际 Lit + metricRequest + authFetch 的正确行为回归，11项中8项失败，复现读取/预览/停止在本请求或并发请求刷新后丢结果，以及换登录/退出后的永久加载。

GREEN：前端受影响组件、API、服务恢复和 auth gate **84 项通过**。前端 typecheck、build、contracts:check 和 git diff --check 通过。首次 typecheck 发现测试 deferred 的 Promise 类型过宽，已修正后重跑通过；无产品类型错误。后台产品代码未变，复用上一轮后端 **804 通过/168 opt-in 跳过**与 Chief 已核验的 R1/R2 证据，不把跳过项算通过。

实际认证封装集成覆盖：

- 读取、预览、停止 × 本请求触发401刷新／另一并发请求刷新，共6组合；确认 token 已轮换、流程结束、正确显示回执。
- 换用户、退出、权限事件、版本切换拒绝旧结果；显式重新登录（即使 token 相同）和外部 token 写入也失效。
- 旧会话刷新200/403迟到不能覆盖/退出新登录；原A/B反序、旧401/403、清空选择、并发刷新和旧行操作保护保持。
- 未知停止回执不自动重试。

准确源码真实演练：nonce `cb9d738cf3be3a29`，**13组检查通过，error无，cleanup=true**。复用原全流程脚本，新增实际 Lit/Chromium → authFetch → Fastify → 独占随机非3306 MySQL 的真实 refresh token 事务轮换。资源请求首次使用受控过期JWT触发401；刷新使用生产 ActorContextService/signAccessToken，重试由真实认证封装执行。为保证每轮签发内容不同，fixture刷新签发TTL按轮次增加1秒，不修改生产签发规则。

六种浏览器组合均记录 `refresh_calls=1`、`token_rotated=true`、`busy=false`：本请求刷新时目标请求2次（首次401未执行业务）；并发请求刷新时目标请求1次。并发停止先由真实路由提交，延迟回执期间另一请求完成刷新，随后成功回执仍正确显示。另将真实已提交停止的HTTP回执丢弃，确认仅1次写请求、没有自动重放，随后只读读取显示disabled。

原受控SNMP→正式writer/唯一事件/历史、失联等待/重现/退役、锁后撤权、资源隔离和三桌面/键盘检查也在同次演练保持通过；B仍为刻意制造ID/revision碰撞的状态fixture，不声称B完成了SNMP采集。无pageerror，所有浏览器、Vite/Fastify、SNMP、owned schema及容器均清理。

复现入口：

```sh
pnpm --filter slide-frontend exec vitest run src/app/ui/components/template-discovery-auth.test.ts src/app/ui/components/template-discovery.test.ts src/app/ui/components/template-library.test.ts src/app/ui/components/native-template-configuration.test.ts src/app/ui/components/template-trigger-editor.test.ts src/api/index.test.ts src/api/service-recovery.test.ts src/app/ui/auth-gate.test.ts
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm --filter slide-api exec tsx e2e/max245-discovery.ts
```

## 发布与范围

官方 gitleaks v8.30.1 经官方checksum验证。新增提交扫描0命中；准确源码全部祖先仍有52,835条既有自动命中（10个旧提交，JWT75/generic-api-key52,760），发布限制继续保留，不将自动命中全部判断为真实凭据。

原始真实证据扫描2条，逐行确认是相同的公开浏览器collect caller_key，非访问或刷新凭据。交付源码哈希清单的额外命中按内容哈希分类，不冒称原始扫描零命中。附件不含原始JWT、refresh token或巨大祖先明细。

候选parent仍为 `ce0d28671be9167dd03b20bd81d52d6fcc836118`，对本轮源码tree的完整范围为262文件。提供完整路径、状态/行数清单和diff哈希，未传播历史删除上下文；完整Git对象供Chief核对。未push、未建PR、无安全发布头，父链与最终发布范围仍由Chief处理，不以此阻塞本地修复。

AGENTS.md已有工作区修改未动，无子代理。未使用共享3306、生产worker、解绑、危险删除、部署、真实通知或产品模型，模型使用0，未重置累计预算。

趋势聚合、容量治理、隔离历史回放、SSH/数据库动态矩阵及最终集成保留原范围。本轮以 `in_review --no-start` 交回Chief独立复核；不新增回调、守卫或巡检，不标整单done。
