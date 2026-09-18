# 验收记录 v1

2026-09-18，源码基线 `f9c1de747890a10d059765aac32712fa4e270372`。本项仅新增 `docs/slide/metrics-v2/v1/`。分支/交付提交和 PR 链接记录在 MAX-63 最终评论（避免文件自引用提交 hash）。

|验收项|证据|结果|
|---|---|---|
|版本化逐项映射|mapping.md + inventory.json；按 target_type 检查旧ID列|64 个注册身份覆盖|
|provider与实时字段交叉核验|verify.py 从四个 provider switch 与 RealtimeMetrics/额外发射字段提取|65 个 provider 分支、70 个实时字段覆盖|
|单位/口径/作用域/维度/类型/来源/成本|mapping.md；每行C/E/I分类和保留/别名/拆分/废弃理由；registry 原元数据独立快照|完成；SQL成本为源码静态分析而非时延实测|
|旧API与消费方|consumers.md；inventory.json.references 中55个匹配文件及行号；source_sha256保护语义源码变化|实时/历史、图表、告警、评分、Agent、报告/基线均记录|
|三类代表与Core Profile|README.md Core Profile；fixtures.json|DB uptime + DM pool扩展、Server文件系统/网络、IF-MIB接口流量/状态|
|可映射与不可映射|fixtures.json + verify.py|32/64位流量等价、proc/SNMP方向流量比较；QPS/大小/连接口径拒绝合并|
|脱敏|fixture纯合成ID/版本/设备名、无连接地址/用户/密钥/业务SQL|通过字段敏感项检查；人工确认未读取生产采样|
|不重做已有修复|README.md记录四个已合并修复；变更只在文档目录|完成|

执行命令（仓库根目录）：

```text
python3 docs/slide/metrics-v2/v1/verify.py
PASS: 64 registry identities; 65 provider cases; 70 realtime fields; 55 referenced files; 3 resource fixtures; mapping coverage, source paths, arithmetic and negative cases
git diff --cached --check
无输出，退出码 0
```

校验脚本只验证盘点/fixture的一致性与算术，不替代未来转换器测试和真实集成。它不导入后端、不连接控制库/目标数据库/SSH/SNMP，不触碰配置。当前交付所需离线验证不依赖开发服务。

可选验证未执行：真实引擎/网络设备回放、部署库自定义定义导出、生产访问日志消费方核验。它们不是本项代表fixture盘点的阻塞；不据此声称运行时已支持V2。fixture的gap阈值300秒仅为样例策略，不提前冻结MAX-64/66的全局阈值。

回退：撤回本目录新增提交；无需回滚schema、服务或配置。合并 main 前下游依赖未满足；本项交付后等待审阅，不等待 MAX-64 实现。

## CI 目录兼容修复（2026-09-18）

PR #74 的 backend CI 因新增目录不符合现有文档归档规则失败；产物已迁移至 `docs/slide/metrics-v2/v1/`，同步更新命令路径及校验脚本的仓库根目录定位，保留原目录门禁。

- 修复前本地复现 `phase-94-docs-structure.test.ts` 的同一失败。
- 修复后 `pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts`：11/11 通过。
- `python3 docs/slide/metrics-v2/v1/verify.py`：原盘点与 fixture 校验通过。
- `pnpm --filter slide-api test`：261 个测试文件通过、4 个跳过；2267 项通过、55 项跳过。
