# T06：HTTP-only 撤权与 Profiles 设置验收

本增量沿 PR159 和托管分支 `agent/15astra/max-148`，保留起始 `784e6ebc`、原产品历史与用户改动，正常合入 `main=8108807a` 的 PR161。前两轮 T06 验收历史继续见 `t06-validation.md`、`t06-resume-validation.md`；旧 head CI 不作为本次 head 证据。

## 问题与实现

调查列表未选择详情、没有 investigation watch 时，创建/普通 Chat 转换组件的独立控制器收到真实 HTTP404，仅清除控制器数据。表单仍显示目标/标题/资源/时间草稿。现在组件响应控制器的 forbidden 边界，关闭弹窗、清除全部草稿及待核对请求、失效旧提交；使用既有 toast 显示拒绝。操作权限专用403保留可读草稿；503接受未知保留原 body/key 核对。普通关闭不解释为撤权。

新增 `/settings/ai/profiles`，仅消费 PR161 的 `GET /api/investigation-profiles` 与生成的 `InvestigationProfilesResponse`。复用 settings-shell、ai:view/admin兼容、主题 token、app-card/empty-state/shared按钮。展示版本/hash、责任、对象/资源边界、Prompt/Skills版本hash、模型场景引用、工具权限上限、输出契约及七项预算上限。事实不复制仓库配置，工具/模型就绪未评估；Profile上限不冒充全局有效预算或已消费费用。没有编辑/执行入口。旧设置路由保持原语义。

Profile 读请求 no-store，每次重新加载先清空已有事实；401/403、失败、权限事件与销毁清空事实。内容生命周期计数阻止迟到200或JSON解析在拒绝/销毁后重新恢复缓存。

## RED/GREEN 与真实业务证据

- 表单新增401/403/404三项反例在原实现全部失败（open仍true），操作403/503兼容检查通过；修复后组件与controller共30项通过。
- 真实列表创建及普通Chat转换：SQL删除当前资源grant，POST返回404/INVESTIGATION_NOT_FOUND，无新investigations行；表单关闭、标题/目标/IDs/起止时间/校验/pending清空，转换保持原Session和message_id/content且不导航到调查。原实现两项确定性失败于弹窗仍存在，修复后同两项通过。
- 首次编写测试使用24小时窗口，超出Profile一小时上限，返回400；属于夹具错误，改为10分钟后才计有效RED。未修改后端验证，也未靠重试掩盖失败。
- Profile首次夹具未种子历史迁移缺失的ai:view，UI正确拒绝；补与T03-D相同的显式隔离测试种子后，授权读/撤权测试通过。随后可逆恢复托管RED检查点的原设置实现，在正确授权夹具上重现缺少Profiles入口；恢复当前实现并执行最终完整浏览器GREEN。此复现只暂存/还原本任务自己的两个设置文件，不使用switch/reset/force，不影响用户文件。
- 真实授权Profile端点返回no-store；UI逐项匹配服务器Profile/hash/责任/prompt hash/工具名单，1600/1024/390无横向溢出。同JWT SQL撤销ai:view后真实403擦除事实，刷新仍不可读。另一个已完成SQL授权读取的HTTP200被延迟，第二次真实读取403后释放旧200，等待旧load实际完成，缓存仍null。
- 无ai:view深链无Profile请求；加载/503/空事实的展示使用明确辅助故障注入，不冒充后端真实未配置事实。HTTP401、权限事件/销毁迟到响应另有单测覆盖。

## 本地最终验证

| 检查 | 结果 |
|---|---|
| 完整调查浏览器 `T06_TEST_MYSQL_PORT=<隔离端口> pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts` | 24/24，0skip，0retries，0observationErrors；原18项全部运行，加HTTP撤权2项及Profiles4项 |
| `pnpm --filter slide-frontend test` | 99文件、798项通过 |
| `pnpm --filter slide-frontend test:browser` | 120项通过 |
| `pnpm security:agent` | 17文件、187项通过 |
| frontend typecheck / build / CSP | 通过 |
| `pnpm contracts:check` / `qualification:matrix` / `security:scan` | 通过 |
| lint / diff check | 全仓0errors；触达重点文件0warnings/0errors；全仓266既有/夹具warnings如实保留 |

真实浏览器使用本次独立loopback MySQL8.4、正式MigrationRunner、JWT/HTTP/WS、Worker/Executor和Chromium。仅Provider/只读目标工具为合成夹具，零新外部模型请求；原5/6停发授权未转用。新增场景位于原spec，CI browser-qualification原步骤运行完整spec，不另设mock或skip路径。

本次不改后端/schema/auth/ledger/executor；已合并main中的后端/公开类型变动属于PR161整合。PR交付树排除私有.multica、用户AGENTS改动、历史产物，完整源码hash清单位于本报告附件。当前head CI与实际qualification日志另附准确核验结果；本地通过不能替代父独立Review/CI/合并。

## 出口限制

Profiles消费已完成。T07-C/PR162的策略、有效预算及持久用量成本端点仍未获父核验合并，继续为V1开放要求。本次停in_review、PR159保持draft，不自行merge、不宣称完整T06/P1/V1，不放行stage8–10；T12/A01–A18总门禁不变。无新Issue/子代理/生产修改。实际编码token和费用遥测不可用，不编造用量。
