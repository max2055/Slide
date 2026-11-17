# MAX-684 已完成 CI 首错闭环

起点 bbb309ee8f432a1f16bfb063da0204382cc11c89；base 451ab8c9969f18d94f17392a74301294de82b5e1。本报告所在提交为新候选，原分支/草稿 PR #1010，不合并、不部署。

## 已完成 run 与 G1

https://github.com/max2055/Slide/actions/runs/44116760893 completed/failure。实际 checkout a5b5a6142109303bab310260ac28941026d6f91d，GitHub commit API 确认 parents 为上述 base、bbb309e；tree 61ac0fc537aa7674f4cd82b62e14331425a5359e。PR 回读 OPEN/DRAFT、head=bbb309e。

Ubuntu24.04 CI 使用 Node24、pnpm11.19.0、MySQL8.4、OpenSSL/NSS、Playwright Chromium/msedge。完整配置见候选 .github/workflows/ci.yml 两个 qualification jobs，凭据仅为隔离测试配置。TLS入口 playwright.investigation-tls.config.ts：1 PASS；Edge入口 playwright.edge-ci.config.ts：4 PASS，随后实例查询9 PASS。各完整步骤退出0，job Edge success；Chromium所在job因后续其他断言失败，不覆盖TLS步骤成功。

两个 trusted-tls.json 均确认：无CA profile被拒绝；隔离profile HOME NSS CA可信，证书校验开启；实际REST登录200；secureContext=true，同源WSS 4次，普通聊天返回、完成结果2次；离线5秒后重连不重放；同JWT撤权HTTP404，正文清理断言通过。受控Provider、无真实模型调用。Edge artifact 14343002722 ZIP SHA256 2ff1c28cc39626e3da21130128cb1d12ed836a4e9d6302ae607e40a0137bbeaf；Chromium artifact 14342902864 哈希见附件hashes.json。原日志与artifact完整保存于受控outputs/max684-ci-44116760893。由现成Linux证据补齐bbb309e的G1，不在缺依赖arm64环境重复运行，不修改系统信任。后续候选有效性需按变更核对。

## 上游首错与最小差异

- job 134157542771：release-security.spec.ts:27跨用户历史预期404实际403。旧qualification-viewer仅viewer权限，无chat:view，先被全局授权拒绝。仅为该测试身份添加独立qualification-chat-reader角色及chat:view，不改默认viewer角色及生产授权。
- job 134157543526：steer.mysql.test.ts:75 beforeAll createSession抛权限不足；1491 PASS/149 SKIP，1 suite FAIL，尚非测试业务断言。独占schema为owner626赋最小chat:view；other627保持原权限。
- release-artifact/ci-gate为上述失败传播，不是第三/第四根因。启动probe初期非零后已就绪，不能当最终首错。
- 补齐viewer权限的真实浏览器红验收确认另一个触达的产品错误：404状态正确但JSON空体。chat-routes reject同步send后调用方return void，与异步序列化发生竞争。现在6个handler拒绝返回reply，preHandler拒绝等待reply；状态、稳定码及授权不变。新增真实socket+序列化hook回归，保留浏览器原404及同响应体断言。没有放宽断言/超时、修改fatal或猜测历史401原因。

## 新候选验证

macOS arm64，Node24.22.1、测试pnpm11.19.0；最初离线依赖恢复使用运行时pnpm11.25.0（冻结锁文件未变），随后全部测试与检查使用声明版本。任务独占MySQL8.4容器max684-ci-fix，1GiB、随机端口49629、空测试口令；无共享库或私有凭据，全部Provider受控。

- steer完整文件2 PASS/1 SKIP（原MAX626_BROWSER_TEST可选项未启用），退出0。
- 完整chat权限真实SQL/Fastify/WS及路由4文件95 PASS（包含59真实验收与新socket回归），退出0。
- CI原选中browser4项4 PASS，退出0。前一误选完整release-security文件2 PASS/8 FAIL保留原日志；首错为空JSON，其余包含未启用专项/限流，不能把后续定向4PASS写为整个文件通过。
- bootstrap真实MySQL事务回滚/重复执行1 PASS，退出0。
- 后端typecheck、contracts:check、source-policy、diff检查通过。错误文件名chat-routes.test.ts的一次空收集退出1保留，不作通过证据。

完整入口（仓库根，PATH含上述Node及pnpm版本）：

```bash
INVESTIGATION_TEST_MYSQL_PORT=49629 INVESTIGATION_TEST_MYSQL_PASSWORD='' pnpm --filter slide-api exec vitest run src/adapter/__tests__/steer.mysql.test.ts
MAX684_ACCEPTANCE=1 MAX684_MYSQL_PORT=49629 MAX684_MYSQL_PASSWORD='' pnpm --filter slide-api exec vitest run src/auth/chat-authorization.mysql.test.ts src/auth/chat-routes.test.ts src/chat-routes.active-minutes.test.ts src/auth/chat-authorization.test.ts
DB_HOST=127.0.0.1 DB_PORT=49629 DB_USER=root DB_PASSWORD='' QUALIFICATION_ADMIN_PASSWORD=Tpam1234 QUALIFICATION_CANCELLATION_E2E=1 QUALIFICATION_CRON_E2E=1 PLAYWRIGHT_MANAGED_ENV=1 pnpm --filter slide-frontend exec playwright test release-critical-paths.spec.ts release-security.spec.ts agent-cancellation.spec.ts --grep 'qualification login|qualification security boundary|viewer cannot|Stop cancels' --workers=1
node --test tests/qualification/bootstrap-admin-atomicity.test.mjs
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm ci:source-policy
```

清理：各验收入口finally清理本任务schema/服务；独占容器停止在交付前完成。无付费模型、未知动作重放、后台工作或订阅。AGENTS.md既有修改未提交。

旧run必需ci-gate失败仍保留；新候选待正常push后的最终CI与原Reviewer复核，未轮询或宣称放行。startup仍仅复用提交前阶段证据，历史401/fatal因果未知；不恢复人工听读门禁。MAX-684保持in_progress。
