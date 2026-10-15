MAX-175 R5 隔离验收执行预览

源码基线：PR189 / 4fee273c588fde7d0f67a195ecf4bf0ed1a8e68b。初始计划仅增加本任务测试与报告；真实正常流进一步确认相对时间窗口有1ms空尾桶问题，因此在既有semantic-metrics.ts写锁内统一时钟并补回归。后端和其余产品文件不改。

目标为任务自有 `slide-max175-live-target` 容器，真实 CentOS Stream 9，基础镜像固定 digest `sha256:4fdfb367402535024cd7703a67e4549ca3b0a0ee05081e06d89e24dce3a3827a`。Dockerfile 安装实际 OpenSSH、Net-SNMP、procps/iproute、systemd-journald、Python；记录构建后的 RPM 精确版本与镜像 ID。容器不是厂商交换机，也不是完整 systemd 主机；不修改 os-release，不提供伪造命令或 OID。

执行命令（从 frontend）：

```sh
docker build -t slide-max175-live-target:r5 e2e/fixtures/max175-live-target
MAX175_LIVE_TARGET=1 pnpm exec playwright test e2e/max175-live-evidence.spec.ts --workers=1 --reporter=line
```

脚本创建带MAX-175标签的独占bridge（本机Docker的internal网络不发布端口，未使用），启动同名任务容器，限制512MiB/1CPU/128PID，端口只映射loopback22175/16175UDP/18175。不会挂载宿主目录或开启 privileged，不连接共享 Docker 网络。既有任务自有 MySQL `slide-max175-mysql` 只映射 loopback33175；测试使用新随机 schema，不操作共享平台数据。密码和 SNMP community 随机生成，通过 stdin 配置容器，只保留内存及容器短期配置，删除容器即销毁，不进入报告、命令参数、源码或日志。

边界：生产 SSH 目标策略固定拒绝 loopback，不更改或绕过正式服务策略。沿用仓库 `host.mysql.test.ts` 的资格测试模式，测试连接层直接创建真实 SSH 客户端，后续执行、诊断解析、采集包、标准化、持久化、查询与页面使用生产实现。此连接接缝必须在证据中注明，不能据此宣布正式在线目标授权、调度、部署或完整服务契约已验。SNMP 使用生产 SnmpClient / 真实 Net-SNMP IF-MIB。

采集：生产固定只读命令（uname、systemctl、ss、ps、journalctl、/proc/net/dev；既有指标 top/free/df/findmnt 等）；Net-SNMP 只开放 system/IF-MIB 读取；向容器 HTTP 下载2MiB文件产生可追溯接口流量。使用真实 logger 分别写入journald和rsyslog，作为带任务标记的warning工作负载，不预置诊断响应。systemctl 无 PID1 时按真实 partial 保留，不把日志成功升级为完整健康。实际Linux发现11个接口，任务配置max_rows=16、max_series_per_resource=512，均在既有平台限制内；MySQL仅采集连接/上限/估算空间，不伪造计数器生命周期。

验证：先核身份/版本/端口，再跑两次有间隔采样，核计数增量、正式查询非空、页面显示真实观测时间及值；390/768/1440 明暗截图。无自动诊断 GET，显式按钮调用诊断服务并消费真实 SSH 返回；缓存缺失/失败与正常采样分开记录。

影响：仅拉取/构建镜像、启动任务容器和测试进程、创建任务schema；局部HTTP流量，产品模型0。停止条件为目标身份不符、端口冲突、凭据泄露风险、输出超限、超时或发现共享连接；立即终止受影响步骤，不扩大能力或替换结果。

清理：测试 finally 关闭确切 SSH/HTTP/API/Vite 句柄并删除本次schema；按确切容器ID核对label后停止并删除本轮容器及独占网络，停止此前已停的任务MySQL恢复原状态。保留镜像/版本/清理日志作可复现证据。共享 SSH/SNMP 实机、部署/重启、在线 binding/采集/Provider 均无本轮新增授权，不执行。

发现的最小后端写锁请求（尚未执行）：`apps/db-ops-api/src/server-diagnostic-service.ts`中的固定journalctl命令把`--since=-5 minutes`拆成两个shell参数。真实CentOS252报`Failed to add match 'minutes': Invalid argument`；同一日志、同一账号的单参数`--since=-5 minutes`探针可读。最小方案仅给固定时间字面值加引号`--since="-5 minutes"`，补命令参数回归和真实journald读取，不新增接口或采集能力；需Chief先协调该文件及专属后端测试所有权。本轮仅验证已有真实rsyslog fallback，必须保留`JOURNAL_UNAVAILABLE_FALLBACK_MESSAGES`/partial，不能宣布journald正常通过。

共享环境最小预览（未执行）：由环境所有者先指定一个已授权的服务器ID（CentOS/RHEL/麒麟、可读journald账号）和一个已授权网络设备ID（厂商/固件/SNMP版本/现有有效绑定）；只对这些ID执行一次显式诊断POST及既有配置的两次受限采样，再只读查指标/接口。不开全局调度、不换Provider、不部署/重启、不新增binding；若当前没有有效绑定，单独给绑定差异预览再批。需要审批的是确切在线对象和这几次采集副作用，而非本轮隔离复验。现阶段无获准共享ID，不使用历史凭据、不试探共享目标。
