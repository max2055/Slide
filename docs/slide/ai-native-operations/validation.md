# R00 验证记录

时间：2026-10-12（Asia/Shanghai）。测试源码为`fb0766d606c9f07448a5eddac2a6657847d90830`，交付只改变规则/方案/证据；测试后业务代码、package配置与依赖没有改变，不重复全量测试。Node v24.18.0，pnpm 11.19.0；工作树分支`codex/MAX-141-review-alignment`。

## 已运行的当前验证

1. 来源校验：原包2,545,916 bytes的SHA-256匹配，manifest全部27项的字节数和hash匹配；两个方案及原型HTML按附件原文复制。四份规则与当前任务本地正文比对一致；远端main与Review源码基线一致。
2. 文档核验：相对Markdown链接目标存在；账本197个记录ID唯一、源文件hash和行段一致；所有T01–T12出现在准入/责任矩阵；新增规则引用的技能和脚本齐备。没有用空提交或文档镜像测试充当验证。
3. 后端focused：18个文件、247项通过、0 skip（5.18s）。覆盖实例权限、Run/DirectAdapter/display/WS、Workflow、Analysis、当前源码同步/快照/部署绑定。
4. 前端focused：5个文件、76项通过、0 skip（1.47s）。覆盖导航与告警/源码呈现；Lit dev-mode提示为正常开发提示。
5. 有界复现：`reproduce.mts`完成5组断言，记录outbox连接不释放、重复返回ID、受限实例边界不一致、false/0丢失、late projection实际语义。无模型/网络请求、业务数据库表读写或服务启动。
6. 真MySQL常量查询：9.6.0；原pending谓词=1、unquoted谓词=1。只读取版本和计算JSON常量，无业务表读取或变更；只排除FINAL-0080的恒空主张。

后端命令（从仓库根运行）：

```bash
pnpm --filter slide-api exec vitest run \
  src/auth/require-instance-access.test.ts \
  src/adapter/__tests__/agent-run-service.test.ts \
  src/adapter/__tests__/direct-adapter.test.ts \
  src/adapter/__tests__/display-stream.test.ts \
  src/adapter/__tests__/display-stream-ws.test.ts \
  src/workflows/worker-runtime.test.ts \
  src/analysis/analysis-envelope.test.ts \
  src/analysis/analysis-evidence-binding.test.ts \
  src/analysis/analysis-recovery-schedule.test.ts \
  src/analysis/analysis-provider.test.ts \
  src/platform/deployment-binding.test.ts \
  src/platform/source-snapshot-service.test.ts \
  src/platform/source-management-service.test.ts \
  src/platform/source-routes.test.ts \
  src/platform/git-source-connector.test.ts \
  src/platform/gitlab-source-connector.test.ts \
  src/platform/source-policy.test.ts \
  src/platform/source-credential.test.ts
```

前端和复现命令：

```bash
pnpm --filter slide-frontend exec vitest run \
  src/app/ui/app-navigation.test.ts \
  src/app/ui/app-navigation.integration.test.ts \
  src/app/ui/views/source-errors.test.ts \
  src/app/ui/views/source-manifest.test.ts \
  src/app/ui/views/alerts-analysis.test.ts
pnpm --filter slide-api exec tsx ../../docs/slide/ai-native-operations/evidence/reproduce.mts
```

复现脚本修正了初次运行的包解析路径，并按实际reducer语义记录sequence推进；最终命令退出0。不能引用失败尝试的断言冒充缺陷确认。

## 原型历史记录与未运行项

`evidence/prototype-verification.input.json`来自2026-10-11资料包，24项交互/宽度检查是原型历史记录。本R00没有改动原型源或重新声称完整浏览器验收。V3预览没有被实现。

本次未运行真实Investigation业务MySQL/WS/provider/SSH/网络/浏览器链路；V1功能尚未实现。没有执行源码同步链路改动，因此未重复POST sync/manifest真实验收；若T09改动链路，专项门禁仍必须执行。未运行T12完整gate/迁移/回退演练，也不把既有单测或mock当这些项目的通过证据。没有生产部署、数据库写入、服务停止或新增付费模型调用。

## PR与合并门禁

`gh repo view` / `gh pr list`均401；去除GH_TOKEN/GITHUB_TOKEN覆盖后`gh auth status`仍确认max2055 keyring token无效。Multica `issue pull-requests`返回空，当前没有关联PR。未修改凭据/保护规则，也未绕过CI。完成可审阅提交及恢复材料后，需要恢复GitHub授权，再复用该分支创建独立PR、核对当前head的所有required checks/审查、正常合并并验证merge SHA在main中。

PR、head SHA、merge SHA和CI URL在最终Issue回复中只报告实际取得的值；本记录不预填虚构成功。材料就绪不等于R00的“PR完成CI并合并”验收已通过，阻塞由MAX-140保留，done由人工决定。
