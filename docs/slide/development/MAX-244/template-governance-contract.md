# MAX244 模板继承与灰度治理契约

本候选接续已接受的维护阶段，不重做维护，不宣称依赖治理或整单完成。

## 来源与边界

任务分支在 `5d38fef8d37a4a88bbdacc8beb18e0b89f239a97` 上追加。维护接受头为 PR573 `4e85ab3c347b072675eb4a3a3b9fe29590c934fd`，与该 source 树一致。

最小消费237 `e4583f2559bf2381cf15e94d36cdce03c3cd9e5a` 的 authoring registrar、公开请求/响应、migration142 和 Lit template-library；其他237差异不整体覆盖。239安全集成 `a1f63ceae59a86689c786747a451c63f008abd31` 和238 applied-envelope `888e36be4834bcddca97b8e8495dd2bd8ef0b5e6` 已在起点中。240 `2fe2a510221d853d5709e45c0368f1ff48a2bdea` 是历史消费契约参考，本次不改240读侧或241专业详情，也不改242工作空间、239五个audit测试或CLAUDE.md。

治理仅是持久意图和现有服务的编排。模板由 MetricTemplateService 发布；组合、参数、试采、配置事务和正式采集仍由既有 TemplateBindingService / scheduler / applied-envelope writer 负责。没有第二采集或事件引擎。

## 固定继承和差异

- 每个版本只有一个固定 `{template_id, version}` 基础指针。根深度0，最多3条继承边；按模板身份检测环，即使环经过该模板旧版本也拒绝。基础必须是已发布不可变版本。
- 发布时展开基础快照；本地同 item_id 项、同 rule_id/scope 触发器覆盖继承值。参数 schema 冲突拒绝；同 schema 本地默认值可覆盖。移除本地覆盖恢复固定基础。草稿可以暂存不完整引用；发布拒绝，编辑页仍可读取草稿修正。
- 展开项归属子模板，source_chain.base 保留原项身份；聚合 inheritance 保存原始模板与固定版本。当前版本本地来源用 version=null，避免内容哈希自引用；被子版本继承时解析为确切父版本。该来源参与内容哈希，旧版本不重写。
- 发布/重复发布复用237现有哈希幂等语义，不升级资源。重新发布与旧快照相同的内容可返回既有版本，UI选中实际返回版本；不会假造新版本或静默移动资源绑定。
- 差异返回不可变 hash、采集项增删/单位/语义快照、参数 schema/defaults、固定触发器版本及实际不可变规则体、发布组合、仍绑定起始版本的授权资源。资源列表最终实时投影；坏绑定或存储失败返回unknown拒绝，不静默忽略。
- 模板参数沿用238命名空间解析和默认/覆盖来源，不自动改写平台、策略组或资源策略。采集频率和负载以现有 binding preview 的实际 settings/releases/budget 为准，不能把名为 interval_ms 的模板参数冒称已改写资源采集频率。确认页按具体组合预览负载及参数；组合冲突保留具体canonical metric/providers。

## 灰度意图与回执

公开路径见生成的 OpenAPI `template-governance`：resources、preview、batches、batch读取/逐资源step、inheritance、diff。所有接口JWT+实时权限，private/no-store。没有隐含全局范围。

创建批次保存 actor、稳定 operation_key、请求指纹及目标pins；逐资源保存原配置、组合候选、基准revision、尝试号和内部稳定应用键。仅替换同模板版本，其他已绑定模板与覆盖保留。配置组合继续由238拒绝重复canonical metric、非法参数及受限AST等；不放宽codec或activate谓词。

step命令必须带独立稳定 operation_key；同键不同action拒绝，同键跨已被后续动作替代的尝试返回superseded。动作意图先独立提交，再以原键调用现有 probe/preview/trial/apply；进程在试采/配置提交/日志响应任意边界丢失后，不生成新的未知应用键。重试用原键查询应用操作，pending保持unknown，不盲重放。新尝试仅由显式retry/rollback推进。每资源行锁串行；候选revision及既有配置事务的提交实时权限仍是权威。日志回写失败不抹除已提交事实，恢复读取既有配置操作。

`submitted`只是配置已提交；`applied`必须来自现有正式采集 envelope 的 applied_revision。读取保留配置application原状态，并显示确认失败的采集任务/调度事件 `collection_failed` 及证据身份；不会把采集失败伪写成 applied，也不新写application失败状态。正式采集失败时原effective快照保持。显式retry在现有revision上重新试采/提交；原命令键重放不增加revision/审计。

回退复用批次保存的前版pins/覆盖/策略组，并要求当前revision仍是该批次目标；并发后来配置不被覆盖。回退仍需真实试采与后续正式采集回执。前版未绑定时返回 ROLLOUT_UNBIND_NOT_ALLOWED，不能利用回退执行本次未授权的实际解绑。批次各资源独立提交，失败有独立状态，不宣称整体成功。

审计：批次不可变目标、逐资源保留的before，以及追加intent/状态审计关联稳定应用键；配置版本历史和操作由原writer记录。一次恢复不重复配置revision或审计。批次只对原actor且仍拥有全部所请求资源读取权限开放；撤权拒绝，diff单独按现时可读资源投影。

## Lit交互和验证

现有指标设置页的模板区接入template-library及治理组件，不要求手填内部ID。固定基础版本、参数/项来源、恢复、发布、差异、资源灰度确认、批量/逐项应用、失败重试和回退均使用真实HTTP。确认前预览是只读，返回选择不写批次。写入前sessionStorage按user/session保存原意图，响应丢失重放原键；损坏记录停止写入。响应校验token、挂载代次，卸载或换主体后的迟到响应不回填；错误/空/加载分别呈现。弹窗支持Escape及关闭后焦点恢复。

可复现命令（仓库根）：

```bash
pnpm --filter slide-api exec vitest run src/metrics/templates src/metrics/bindings src/metrics/triggers src/contracts/metrics
pnpm --filter slide-api exec tsx e2e/max244-governance.ts
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm contracts:check
pnpm --filter slide-frontend exec vitest run
pnpm --filter slide-frontend build
pnpm security:scan
```

e2e启动带nonce标签的独占Docker MySQL，绑定动态非3306端口和owned schema；记录准确ID/PID/cwd/schema、前后端地址及源码起点。使用生产registrars、JWT、Lit和唯一配置/正式样本写入链。SQL传输受控，不代表真实硬件；仅在该owned schema明确调用WorkerRuntime.runOnce，不启动生产worker或scheduler扫描，不发送外部通知、不调用模型。三种桌面尺寸截图、trace、结果和cleanup由脚本输出。清理校验精确nonce；未知清理非零并留句柄，不能扫邻居或端口前缀。

本流程候选交Chief独立安全/权限复核；本地自检不是独立验收。维护已接受证据继续有效；依赖治理、升级通知等原剩余范围保留，通知外发豁免沿用。
