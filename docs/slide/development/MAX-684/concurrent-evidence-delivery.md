# MAX-684 已审取证候选：一次原并发入口交付

本次仅提交已独立复核通过的四文件取证改动及本文，不改产品、serve-e2e.sh或tracker。MF-T1/T2按独立报告关闭，旧候选FAIL保持历史；原signal-term/watchdog根因仍未知。本地一次并发通过不代表根因修复或新CI成功，整体验收仍BLOCKED。

## 版本与范围

- PR：max2055/Slide #1010，main base `451ab8c9969f18d94f17392a74301294de82b5e1`。
- 实施起点：`718e24afa9462e738d45d0c8c272ff51e12a864d`。
- 已审并实施的patch SHA256：`81491538a71ae3ecd98f9d58943823ed1ac2dadba12a3672b6d4a1dd7f63746e`。
- 原Reviewer报告提交：`d79eeb73bed0d96e86b8aa05b3e1df6ec6bc847b`，报告路径为同目录failure-evidence-rereview-718e24-patch81491538.md（该报告保存在Reviewer分支，不声称已合入本分支）。
- 经认证CLI下载复核附件，2,251,244字节、SHA256 `c4f4eb125e4162471d896d41b8e3f9878a0029981c41673a3c5b024c6d49ce34`，CRC通过；内含作者新包及补丁，补丁/四文件索引与应用后字节一致。
- 已有AGENTS.md差异保留，不纳入提交。最终提交和远端回读结果见本次Issue交付及附件provenance.json；不会用裸718代表取证候选。

四个已审代码文件的SHA256：

- `.github/workflows/ci.yml`：`8779d3955d40bbbb8dba9bae649d8821f5e3a9a5143eeb096f828e94ce22931b`
- `scripts/qualification/serve-e2e.supervisor.test.sh`：`7cf915aba1b225766b4f37a32abeb01ad400f0a2a3158e31de6a5cc3dd974fae`
- `scripts/qualification/serve-e2e-evidence.py`：`181f0e9c803e08e483c80c1d8975af1607f8988bbbb04da7b81ed59354c05215`
- `tests/qualification/serve-e2e-supervisor.test.mjs`：`ebe0d924bd95b1ec6135bcef18731e74091363a17a6c9e327e5557e42511f190`

## 一次原并发命令与结果

```bash
node --test tests/qualification/*.test.mjs
```

九文件由原shell glob展开，默认Node并发，无--test-concurrency覆盖，无用例过滤/重跑；所有测试、信号、12秒watchdog、120秒监督mjs计时器、清理/旁路/launcher断言不变。次数锁entry-once.json记录唯一一次执行。

实际结果：**143/143 PASS，FAIL0、SKIP0、CANCEL0，wrapper/Node退出0，总18.364秒**。真实MySQL夹具DML回滚/DDL独立阶段通过（12.448秒）；证据持久化隔离guard包装通过（3.287秒），其内部8项TS测试全部通过。监督单文件在同次并发中通过，原mjs明确断言child exit0，因此监督child也为0；采集EVIDENCE_ERROR为0。成功时按已审语义删除专用监督证据目录，没有失败trace/上传artifact，不故意制造业务失败获取产物。

## 环境、预检及差异

独占Linux容器，Ubuntu24.04.5/aarch64、Bash5.2.21、Node24.22.2、Python3.12.3、pnpm11.19.0；冻结锁安装依赖，忽略安装构建脚本后已实际验证bcrypt原生模块、tsx转换和业务模块导入。真实测试MySQL为本机已有mysql:8.4镜像新建的随机环回端口独占容器；无平台3306/共享3308访问，无模型/目标设备调用。

原CI watchdog进程表显示CPU0–3，本容器也只开放CPU0–3，Node实测availableParallelism=4，保持默认并发。没有声称Docker Desktop内核、主机负载与GitHub hosted ARM镜像完全相同。

Docker Desktop的端口发布由宿主代理承接；runner内--network host无法直接连到发布端口，但host.docker.internal可达。仅在任务环境加专用Docker CLI/环回转发器：记录本任务创建容器ID，port查询时核对ID，仅转发该容器原始随机127.0.0.1端口到宿主同端口；不改docker port返回值、测试脚本、SQL、超时或断言，使用真实MySQL。清理时只处理账本中本任务容器/转发器，其他容器保持原样。此环境适配的源码、身份账本和预检随Issue附件交付，不进入产品仓库。

前置失败单列：现成镜像缺依赖，已完成冻结锁安装；第一次TS预检从仓库根解析tsx失败，实际原测试从API cwd加载，修正预检cwd后真实SQL及业务TS导入通过。初次host-network连接ECONNREFUSED由Docker Desktop转发边界导致；上述均发生在唯一九文件入口前，不计业务通过或原卡点复现。未循环九文件或单文件碰绿。

## 检查、证据与限制

- 完整并发日志、entry-once/exit、环境、预检、独占MySQL原子性证据/清理账本、逐文件哈希在Issue附件；不把仅本机路径作为交付。
- pnpm11.19.0原ci:source-policy脚本检查通过，使用verify-deps-before-run=false仅避免为纯Git检查在宿主安装无关依赖，不跳过检查本身；提交前diff和候选字节核对通过。
- 单文件/故障注入、树外会话排除、512KiB/8MiB上限和首错传播按原独立复核有效证据复用，不重复审未变字节。
- signal_observed只为原trap赋值生效后的首个DEBUG边界，非精确进入时刻。Linux目标匹配后清除BASH_ENV；Mac3.2可继续导出无动作片段，不能泛称所有平台unset；Bash4仅代码分支证据。
- trace扰动或截断、本地一次并发通过均不能证明原根因修复。上传workflow仍仅在原native-audit失败时运行；本地归档不是GitHub上传，本轮未实际发生上传时继续记未验证。
- G1 Linux TLS/SQL/browser/runtime、startup阶段、历史401/fatal因果未知与内部观测限制、BODY焦点基线和豁免按原范围保持，不恢复人工读屏/VoiceOver。

后续正常push仅触发常规CI，单次读取新head/base/draft和run链接即交接，不轮询/重跑旧CI、不新增任务/订阅。必需检查与ci-gate成功前不整体放行，不合并、部署或关闭#1009。
