# 混合选择器缺口修正与基线集成

本次继续原完整流程，修正全局清空 selected 导致的漏报。runtime 保留原始相邻输入：null 使后继样本的 window=null；纯 evaluator 对每个 selector 独立过滤窗口和检查覆盖。删除跨 selector 的整组清空，不修改 AST/quality/unit/codec/applied 判定。最新输入自身为 null 仍保持未知，不回退旧 last。

真实独占非3306 MySQL 的正常 writer 回归（未预种事件）：

- 修复前 RED：30秒采样、问题 last>90 OR avg(30s)>90 OR avg(60s)>90、恢复 last<70；60/60/null/95（0/30/45/60秒）没有 episode，断言失败。修复后在95形成一个 episode，85保持，获得充分覆盖后60恢复，历史 API 保留开启值95。
- 较短窗口独立：问题 avg(30s)>90 OR avg(60s)>90；60/null/95/95（0/15/30/60秒），30秒窗口完整而60秒窗口有缺口，仍触发问题。没有用 last 掩盖此反例。
- 原纯 avg 中间null仍 open/unknown/0恢复；95/85/60、90/70、乱序重复、事务/outbox回滚、实时权限、单位及质量严格拒绝、来源/episode关联删除保护等既有集成保留。

浏览器从真正 event-center 进入、挂载生产共用读取入口。编辑/发布嵌套混合规则 last>90 OR (avg(60s)>90 AND last>90)，独立恢复 last<70；完成正常模板配置/正式writer/同episode跨进程重启/事件历史及当前配置/确认和本地HTTP投递追溯。该浏览器规则允许在 avg 未知但 last 为假时通过 AND 判定问题条件为假；不能把纯 last OR avg 的未知问题条件宣称可恢复。精确裸 OR 反例另由上述真实 MySQL 回归覆盖。

浏览器同时发现长组合证据使事件详情网格横向溢出，修正最小列宽和换行；显示条件加括号保留嵌套语义。三个桌面尺寸及基本焦点通过。无人工听读门禁。

## 基线与冲突

远端真实 base branch agent/15coder1/max-238-release 已到88fc15e2；启动PR API仍返回797ab6b，不能以其缓存值判定。对真实基线执行 merge-tree 得到六处冲突：server.ts、contracts/public-api.test.ts、scheduler/store.ts、templates/binding-service.ts、openapi.json、native-template-configuration.ts。这些源码已从同一88fc producer导入并追加MAX239实现；逐处保留本任务扩展，其余68个基线独有路径全部与88fc的blob完全一致，无额外合成修改。原分支上追加合并，未改base、未重写起点。精确冲突blob及68路径在merge-resolution.json。

新纳入基线的17个commit及其全部tree/blob也纳入新增可达审计；基线签名预扫0命中。最终候选的完整审计与source/head/base、相同tree证明随评论附件交付。用户AGENTS.md修改保持未提交。

验证：正常writer真实MySQL4项；受影响模块466通过/47 gated跳过；前端43项；API/frontend类型、contracts、build/CSP。未变业务源码与既有测试按相同blob复用，不重做已闭合反例。三类实机collector和正式外部通知仍未验收，受控输入/本地HTTP不冒称正式通道。独立复核仍待Chief按准确新SHA执行。
