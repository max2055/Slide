# MAX238-COLLECTION-DISPLAY-E2E-R1 复现步骤

脚本只读目标、只写一次性平台库；凭据只从环境变量读取，文件里没有密码或令牌。

## 环境

1. 一次性平台库（非 3306）：
   `docker run -d --rm --name <unique> -p 13306:3306 -e MYSQL_ROOT_PASSWORD=<generated> -e MYSQL_ROOT_HOST=% mysql:8.4`
2. 空库跑完整迁移（含 `135_metric_template_binding_storage.sql`）：
   `DB_HOST=127.0.0.1 DB_PORT=13306 DB_USER=root DB_PASSWORD=... DB_NAME=slide_max238_r1 pnpm --filter slide-api exec tsx init-db.ts`
3. 把共享开发库中已纳管的 `database_instances`（含加密凭据列）、`users/roles/user_roles/role_permissions`、
   `metric_policy_bindings` 与 5 张模板表**只读复制**到一次性库；再在一次性库里为测试用户设置已知密码。
   这一步是本包的一次性环境准备，不进产品代码；复制不读明文秘密。
4. 真实 API（127.0.0.1:3001）与真实 Vite（127.0.0.1:5173，`VITE_API_PROXY_TARGET=http://127.0.0.1:3001`）。
   API 需要可构造的 LLM Provider 行（本地 `deployment_type=local` 即可，不会发起模型调用）。

## 链路

```bash
MAX238_API=http://127.0.0.1:3001 MAX238_ADMIN_PASSWORD=... MAX238_EXPECTED_REVISION=4 \
  docs/slide/development/MAX-238/e2e-20261029/run-chain.sh
```

依次打印：模板列表 → 版本 1 预览（9.6 目标上 `executable=false`，item `unsupported`）→ 发布模板版本 2
→ 版本 2 预览（`executable=true`）→ 真实试采（读到 `db.uptime_seconds`）→ 应用（`committed`, revision N+1）
→ 绑定状态 → 最新数据 API（`available` + 同一观测）。

## 页面

在 `frontend/` 目录下运行（这样能解析 `@playwright/test`）：

```bash
MAX238_PAGE=http://127.0.0.1:5173 MAX238_API=http://127.0.0.1:3001 \
MAX238_ADMIN_PASSWORD=... MAX238_EVIDENCE_DIR=/tmp/max238 \
  node ../docs/slide/development/MAX-238/e2e-20261029/browser-evidence.mjs
```

脚本保存 `max238-r1-{databases,instance,metrics}.png`、页面文本（穿透 shadow DOM）和页面自身的
`/api/metrics/query` 请求/响应。核对方式：页面渲染的 `数据库运行时长` 值与响应里同一个
`observed_at` 的 bucket 值、单位、质量、`package_id/package_version/config_revision` 一致。

## 清理

一次性容器按确切名称/ID 删除；目标 3306 只读、不写入；共享开发库未被修改。
