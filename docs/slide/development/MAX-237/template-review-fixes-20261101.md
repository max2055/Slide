# MAX-237 模板流程 R1/R2 修复

修复源码 `fc06d487e2c7cac7eb6f880ce21f3f9be255595f`，保留指定起点 `373717d6fd79930f6043473e7aa5399cfb8bf8d7` 与任务分支，更新唯一 PR390。后续交付提交仅增加本说明。Chief 的独立复核仍待执行，本文为实现方验证记录。

## 修复与验收

| 复核问题 | 行为与正式回归 |
|---|---|
| R1 直接读取403保留旧事实 | library/editor/capabilities 全部清空，递增请求代次，迟到响应不再写回；刷新可恢复。覆盖详情和库的普通HTTP403，无窗口事件依赖。 |
| R1 写入拒绝 | 自定义模板写403及复制403撤销可编辑状态，保留可读内容和重新读取入口；内置模板的业务禁止保留会话；401清空全部旧事实。库刷新同步详情的编辑权限。 |
| R2 名称输入未保存 | 模板名称与逐项名称独立跟踪，与周期/监控项草稿共同保护关闭、Esc和版本切换。保存草稿仅清除已保存的草稿修改，不清除尚未提交的名称；发布和复制在未保存时禁用。 |
| R2 保存与放弃 | 模板名称显式保存；监控项名称显式保存后仍须保存草稿引用。放弃重新读取持久化名称和精确版本；发布快照核对保存后的监控项名称。 |
| 键盘焦点 | 列表刷新会替换原打开按钮；关闭后按模板稳定标识定位当前按钮，找不到时回到刷新入口，避免恢复到已移除的元素。 |

正式组件用例 `frontend/src/app/ui/components/template-library.test.ts` 最终10项通过，包括迟到响应、读403恢复、写403/401区分、两种名称保护和未知写入同键重试。Chief 附件原探针未经修改在临时测试文件运行，4项全部通过，临时文件已清理。

## 实际执行

在上述修复源码执行 `pnpm --filter slide-api exec tsx e2e/max237-template-workflow.ts`：13组断言通过。真实 Lit→Fastify→JWT→独占 MySQL8.4，端口58269，nonce `c0ca97d5d1bb7f08`。新增断言直接撤销实际数据库中的读/写授权，验证清空/禁用/恢复；覆盖模板和监控项名称输入、保存草稿后仍未保存、关闭/Esc保护、显式放弃、显式保存后发布，以及1440×900、1366×768、1920×1080截图、Tab限制与焦点恢复。浏览器无未捕获异常。

浏览器/Vite/Fastify/连接已关闭，所有权核验后删除schema，精确容器ID及nonce核验后优雅停止，`cleanup.json verified=true`。此前失败演练的独占数据库和容器也已清理。未启动生产worker、模型、子代理，不写共享3306，不解绑、不通知、不部署。

| 命令 | 结果 |
|---|---|
| `pnpm --filter slide-frontend exec vitest run --maxWorkers=2` | 155文件1427项通过；此轮加载的组件9项通过，最后新增的同键重试对照由最终组件10项单独覆盖。 |
| `pnpm --filter slide-frontend exec vitest run src/app/ui/components/template-library.test.ts` | 最终源码10项通过。 |
| `pnpm --filter slide-api typecheck` / `pnpm --filter slide-frontend typecheck` | 通过；焦点修复后前端复验通过。 |
| `pnpm contracts:check` | 通过；未修改公开契约。 |
| `pnpm --filter slide-frontend build` | 最终源码通过，CSP两个生产脚本检查通过；保留既有大chunk提示。 |
| `pnpm security:scan` / `pnpm security:test` | 扫描通过；35文件336项通过。 |
| `pnpm --filter slide-frontend exec oxlint src/app/ui/components/template-library.ts` | 0警告0错误。 |
| `git diff --check` | 通过。 |

失败记录保留：最初新增夹具复用已消费Response，导致3条用例失败，改为每次创建Response后通过；误将测试参数放在`--`之后触发全量测试，两次日志输出与最终结果区分，不计为额外验收。默认高并发全量中未改动的semantic-metrics观察详情用例超时，限制2 worker后全量通过，没有修改其断言或超时。首次真实流程末尾发现刷新后的焦点恢复失败，补齐组件局部恢复逻辑后，在新独占环境完整复验通过。Fastify既有propertyNames strictTypes提示保留在完整日志中。

## 证据与剩余范围

Issue附件交付完整日志、最终13组断言、两轮cleanup、三尺寸截图、源码/证据哈希和所有新增推送对象审计；CI只采集一次事实，不watch/merge/deploy。AGENTS.md运行时预存修改不入提交。

后端存储、采集及契约实现未修改，复用前轮已接受的真实MySQL/VM/受控SNMP证据和后端模块验证，见 `native-template-workflow-20261101.md`。受控SNMP不声称网络硬件实测，也不等待硬件部署。

本次交付仅收口复核R1/R2，原范围仍保留：PostgreSQL/Oracle/达梦模板逐项真实验收、原要求指标逐项真实证据、完整模板用户资料、跨项集成/currentSHA门禁；继承治理/发现按MAX244/MAX245分工，不重做。发现执行与模板专属图形继续明确未实现，不冒充成功。本项交付 `in_review --no-start`，不标整单done，不新增规则或开发run。
