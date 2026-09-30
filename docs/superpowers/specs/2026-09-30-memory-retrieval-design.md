# MAX-102 有预算的记忆检索

基线 main `0e80676bb956bdbf4deb266e17c260346b75984a`。MAX-99 #104、MAX-101 #105 已合并；复用 ContextBlock reference 投影和 MemoryPipeline 来源契约。原工作树的用户改动保留；独立分支实现。范围按 Issue v1，硬预算未设定，实测资源遥测不可用，不委派代理。

先 workspace/actor/session 或显式共享过滤，再筛选 active、有证据且来源有效的记录；uncertain/conflict/negate 不作为确认记忆；显式共享后的跨 owner 同 kind/subject 矛盾也排除，不能由排序决定谁被确认。按 kind/subject 可选过滤、BM25 词项相关度、updatedAt、稳定 ID 排序。中文使用连续汉字二元组，英文/SQL 标识符使用归一化词项。不引入 embedding 或额外 LLM 请求。纯 recency 简单但容易遗失旧的相关记录，用作基线；子串匹配对多词查询弱，选择 BM25。

每个请求仅投影有限记录，包含稳定 ID、来源 ID/hash 和证据标签。token 上限使用现有 UTF-8 保守估计，计入整个 C2 synthetic reference pair（含 JSON escaping/角色封装），标明方法而非声称真实 tokenizer 实测。超限记录跳过，不截断引用证据。权限过滤先于 IDF 统计，顺序稳定；查询空或无匹配返回空。扫描上限或读取/校验失败明确空降级，不回退全文。

ContextBuilder 增加请求范围参数和检索回调，参考块仅本次请求存活。DirectAdapter 的认证 chat 传入服务端 scope；无 actor 的 invoke 无权读取业务记忆，仍通过同一投影入口返回空。BusinessMemoryService 校验 chat ownership，复用 M1 store 和 canonical source reader。日志仅记录记录/来源 ID、计数和预算，不记录查询/正文/异常文本，不改审批、工具注册、canonical、恢复/累计预算或 settlement。

人工 MEMORY.md 不自动继承 cwd 的权限：仅在明确配置 owner scope 且请求 scope 相等时按段落/行检索，标 legacy/unknown、uncertain、reference；已通过 memory.import 导入的人工引用复用既有私有 scope。两种参考均纳入同一个 count/token 上限。原文件不覆盖，无参数 getMemoryContext 返回空。

验收：冻结 ≥200 条有 scope/状态/冲突的记录与 ≥50 条标 relevant IDs 的 query；输出 Recall@5、precision、全量与纯 recency 对照、输入估计和 ≥50% 中位缩减；每请求不超限、来源/权限负例返回零、确定性、审批边界不变。focused tests 后运行 agent-core/backend test/typecheck 和相关 lint；隔离真实 MySQL/认证 WS 请求捕获 provider input（受控 provider，不新增付费调用），真实供应商不可用时明确标注。PR 交付，CI 条件唤醒后核验当前 head/全部门禁再自动合并。
