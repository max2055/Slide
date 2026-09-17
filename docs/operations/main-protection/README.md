# main PR 与 CI 门禁

状态：Max 已于 2026-09-17 在 MAX-51 评论 `01a0ad09-d4b9-7add-ab3d-979553277bcd` 批准本策略在 CI 修改合入后启用。尚未写入远端规则；批准不等同于规则已生效。

## 只读复核（2026-09-17）

- 最新 main：`1f86697322fe2c48ea71a7ab608871556ba2df05`；与工作分支原始 CI 文件无差异。
- `GET /repos/max2055/Slide`：公开、个人所有仓库，当前身份 max2055，admin/push 均为 true。
- `GET /user` 未返回 plan 名称，不能声称已确认付费套餐。公开仓库可使用分支 rulesets；最终创建能力须在授权后由 API 响应确认。
- `GET /repos/max2055/Slide/branches/main`：protected=false；`.../protection`：404 Branch not protected。
- `GET /repos/max2055/Slide/rules/branches/main` 与 `.../rulesets?includes_parents=true` 均为 `[]`。
- 成功 PR 运行：https://github.com/max2055/Slide/actions/runs/35170622250 ，SHA `0b51484bd7d1316560367a6838df8e315924e706`。
- jobs 与 check-runs API 确认 8 项名称：backend、frontend、agent-core、sandbox-controller、browser、browser-qualification、recovery-qualification、release-artifact；来源 github-actions，app ID 15368。

## 配置决策

`ruleset.json` 仅匹配 refs/heads/main：必须通过 PR；8 项检查全部必需并绑定 GitHub Actions；合并前必须包含最新 main；阻止删除及强推。bypass_actors 为空，管理员和自动化均无提交绕过通道。管理员仍有编辑规则的权限，紧急变更必须另行授权并记录恢复。

批准数设为 0：本任务要求 PR 和 CI，而未要求第二名维护者批准；这保留个人维护者的合法合并路径。讨论必须解决，现有 merge/squash/rebase 三种合并方式均保留。没有配置 merge queue，不新增 merge_group 触发器。

CI 保留 pull_request(main) 与 workflow_dispatch，新增 push(main)，无路径过滤。PR 与合并后的 main 各跑一次是预期的补充检测，不能用 push 检测代替合入保护。8 项检查没有事件条件跳过。

当前唯一工作流为 ci.yml；release:artifact 仅构建 tar/校验和，release:rollback-drill 只操作 mktemp 临时目录，upload-artifact 上传到各自 Actions run。没有 gh release、包发布或实际环境部署，因此双事件不会重复发布；之后若新增部署必须另行限定触发事件。

## 授权后应用

先通过普通 PR 合入 CI 修改，再应用规则。以下写操作本轮未执行。应用前重新核对 main、现有 rulesets 与检查名称；如果已有其他规则，不覆盖或删除它们。

```bash
# 保存应用前快照（只读）
gh api 'repos/max2055/Slide/rulesets?includes_parents=true' > rulesets-before.json
gh api repos/max2055/Slide/rules/branches/main > effective-before.json
# 仅获批准后执行，并保存返回的 ID
gh api --method POST repos/max2055/Slide/rulesets --input docs/operations/main-protection/ruleset.json > ruleset-created.json
# 将下方 RULESET_ID 替换为返回的数字 ID
gh api repos/max2055/Slide/rulesets/RULESET_ID
gh api repos/max2055/Slide/rules/branches/main
gh api repos/max2055/Slide/branches/main
```

若 POST 超时，先 GET 列表确认是否已经创建，禁止盲目重复提交。若因权限/套餐返回 403/422，保留原始错误并停止，不降级为仅 push 检测。

## 验收与恢复

1. CI 修改 PR 的 Actions event 为 pull_request、目标 main，8 项成功后通过正常合并路径合并。历史成功运行只是名称及原路径证据，不是新版本验证。
2. 合入后查询 main SHA 对应 Actions run，确认 event=push，并完成该运行；不直接提交坏代码试探。
3. 启用规则后 GET ruleset 和有效 branch rules，确认 active、ref、全部 contexts/integration_id、strict 与空 bypass；保存结果。
4. 用下一次获授权的正常 PR 验证受保护路径：8 项成功、基于最新 main、讨论解决后可合并。不要仅凭本地检查宣称合并可用，不为验证直接修改 main。
5. 恢复 CI 用正常 PR 撤回新增 push 配置；保护规则不因测试失败自动关闭。
6. 仅获明确恢复授权后，对本次创建的 ID 执行 `gh api --method DELETE repos/max2055/Slide/rulesets/RULESET_ID`，再 GET 有效规则确认。当前基线无规则，删除本次规则即恢复原状态；若应用时基线已变化，应按快照恢复，不能删除其他规则。

本轮只做配置结构和差异检查；未执行完整业务测试（没有业务代码变化），未创建远端 PR、运行新 CI、启用规则或验证保护后的真实合并。保护策略已获批准；以上远端验收仍待 PR 合入后执行。
