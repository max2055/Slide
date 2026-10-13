# T06 调查治理只读设置 Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; preserve the managed branch, PR159 history and user changes. No delegation or external model calls.

**Goal:** 按 MAX-148 v1.2.14 消费已合并的策略、有效预算和持久用量事实。

**Architecture:** 设置导航增加三个独立深链，复用同一个只读 Lit 页面及现有主题、按钮、卡片和空状态。每次刷新、分页、切页、销毁或授权改变递增 generation 并清空事实；旧响应不得恢复内容。策略需 ai:view，预算和用量另需 config:manage，未知权限不先读取。

**Tech Stack:** Lit 3.3、generated public API types、authFetch、Vitest、Playwright Chromium、隔离 MySQL8.4/正式迁移/JWT/Fastify。

## 1. 直接反例

- 新增 `frontend/src/app/ui/views/investigation-governance.test.ts`：无权限零读；401/403/503清缓存；切页、刷新、权限事件、销毁后的迟到200丢弃。
- 运行 `pnpm --filter slide-frontend exec vitest run src/app/ui/views/investigation-governance.test.ts`，确认缺实现的RED，随后实现并重跑。

## 2. 只读设置

- 新增 `frontend/src/app/ui/views/investigation-governance.ts`；修改 `settings-navigation.ts`、`views/settings-shell.ts`，保留全部旧入口。
- 策略展示生产组合未配置/未接入。预算展示loader与冻结policy、匹配/冲突/未初始化、UTC窗口、保留成本；不将Profile上限当余额。
- 用量显示all_history reservation总数、各状态和known/unknown/pending、token已知小计、input内含cachedInput。按币种显示配置费率估算、保留成本；不合并币种、不把unknown/缺费率当零。按groupCount/nextOffset分页，页大小5/20/50；每页替换事实避免跨页汇总误加。
- 运行focused tests、前端typecheck；新增权限交集/旧深链回归。

## 3. 真实验收

- `frontend/e2e/fixtures/investigation-server.ts` 注册正式governance routes/store；只在测试夹具提供存储可用性开关。新 `frontend/e2e/investigation-governance.spec.ts` 使用隔离schema和正式ledger写端口创建五种state、双币种、同组缺费率事实；不执行真实Provider。
- 真实SQL撤销ai:view/config:manage并用同JWT刷新，HTTP403后缓存为空；无权深链零读取；延迟真实200跨刷新/页切换/销毁/撤权不得恢复。真实存储不可用503、空用量、未配置策略、冻结hash冲突、分组分页/总数、成本语义及1600/1024/390无溢出与键盘焦点。
- 修改 `frontend/playwright.investigation.config.ts` 纳入新增spec，现有CI qualification命令自动执行全部旧24项与增量，0skip/0retries/0observationErrors。
- 运行完整真实suite、前端unit/typecheck/build/CSP、相关安全/contract/matrix/scan/lint；失败分类修复本次范围问题。保存日志、截图和源码hash，不以mock替代SQL证据。

## 4. 交接

- 托管分支提交限定产品文件；通过独立git index生成仅frontend/docs/必要CI的PR159增量，保留原head与main父历史；不含私有.multica/用户AGENTS。
- 推送PR159普通快进，核验当前head CI并读取原qualification日志。报告准确head/源码SHA256/测试限制与清理证据，停in_review等待父完整Review、普通merge/main与T12，不自行放行stage8–10。
- 核验本run一次性终态交接规则；本run只发布一条最终评论及附件。
