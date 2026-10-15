## MAX-175 R8：固定日志投影与截断质量

沿原分支及草稿PR189实施，不合并。R7真实日志POST503与原证据包保留；R4 F1/F2、R5时间窗口、R6引号及未变六前端证据继续有效。本轮只改原诊断服务及专属测试、probe、报告。

### 改动与边界

- journalctl固定投影为MESSAGE、PRIORITY、_SYSTEMD_UNIT、SYSLOG_IDENTIFIER、_PID；journalctl自动时间元数据仍由真实主机返回，不使用本机时间覆盖。
- 消费共享parser原有truncated：完整行截断为partial / JOURNAL_OUTPUT_TRUNCATED；半行截断保留partial / JOURNAL_JSON_MALFORMED，同时保留truncated。日志section、别名、缓存与整体质量不能回到good。
- 小输出完整日志仍为good。空、畸形、fallback各自原因不混同。
- 保持5分钟、warning、200行、15秒、128KiB单段、512KiB总量、64KiB共享解析限额。投影后仍超传输限额继续安全失败，不改共享parser、SSH、HTTP hook、权限或脱敏。

### 本地验证

专属回归先红：缺固定投影的2项shell argv断言、完整行截断错误good的1项断言失败。修复后运行：

```
pnpm --filter slide-api exec vitest run src/server-diagnostic-service.max175.test.ts src/server-diagnostic-service.test.ts src/linux-host-evidence-service.test.ts src/ssh-session-pool-output.test.ts src/ssh-session-pool.security.test.ts src/diagnostic-evidence-adapters.test.ts
```

6文件43项通过，其中专属11项覆盖真实shell参数、小输出good、恰好64KiB完整、超过64KiB完整行截断、半行截断、独立畸形JSON、真实SSH输出guard恰好128KiB及多1字节、fatal无fallback与已有fallback脱敏。

前端MAX-175-review-regression.test.ts共19项通过，保留支持OS/无缓存下进入、切页、刷新、切对象不发隐式GET；显式POST、权限门禁以及响应body延迟时对象切换/撤权/断开清理。后端typecheck、contracts通过。新增probe后再次typecheck通过。未变化完整前端1078项、build/CSP和既有浏览器矩阵复用已审证据，未因汇报重复执行。

### 真实主机只读探针

同一成员授权的Kylin V11/systemd服务器；使用生产target policy、pinned SSH与生产共享parser，无凭据字面值。生产固定200行投影命令退出0，输出104037字节，stderr 0；解析保留131条、malformedLines=1、truncated=true，所有保留条目有原始时间，级别为warning/error。

独立的单行只读探针输出410字节，解析1条、malformedLines=0、truncated=false，保留时间及warning。这是小输出与元数据的SSH/parser补充证据，单行probe不是生产200行配置，也不能替代完整service/HTTP/页面正常流。小输出service good另由专属单测证明。无新增远端标记或配置操作。

### 正式POST与页面

正式浏览器日志路径1/1通过，1440/768/390px明暗共6张新图。完整正式Fastify、JWT/实时权限、生产target policy与pinned SSH，未覆盖HTTP或SSH传输。仅1次显式POST /api/servers/1/collect-diagnostics，返回200；进入、刷新、切页均无诊断GET，pageerrors为空。

services/ports/processes/interfaces为good（分别27/5/20/2条）；日志131条、partial / JOURNAL_JSON_MALFORMED / truncated=true，整体partial/truncated，六组页面显示真实消息、原始时间、partial、截断标记与原因。未降低原生产200行配置，未以partial代替完整good。POST到可见的本次单样本为1254ms，不代表性能验收。库存保持offline、资源观测未知，没有把读取成功伪造成在线健康。

远端date -u为2026-10-15T15:45:06Z，保留日志原始时间首条2026-10-15T22:57:19.016Z，比读取时刻晚。此为实际源日志时间现象；未改主机时钟/OS/日志，也未以本机读取时间覆盖日志时间，不据此判断日志新鲜或系统正常。

首次尝试停在任务MySQL初始化；Docker控制接口及握手超时，未进入远端诊断采集，不计产品失败或正常业务通过。停止已核cwd/PID的本任务初始化子进程；首轮环境失败日志单列保留，不覆盖R7产品503失败历史。Docker恢复后补充有界初始化超时及有界就绪检查，仅补跑日志路径1次，不重跑未变指标矩阵。

产品验收源码提交2b8cfeb3；实际浏览器记录HEAD为028ca7d3（产品源码相同），仅MySQL就绪等待的本地专属测试改动随后纳入交付，实际执行文件hash记入清单。专属只读探针新增后typecheck通过；未因该测试准备时限调整重复远端采集。本轮正式测试还按原隔离准备流程执行2轮任务自有指标采样与1条warning标记，指标不再重复截图；无共享调度资格。新schema/API/Vite/SSH由测试回收，任务MySQL恢复exited；首次及成功轮schema按确切名称再次查询均不存在（cleanup-final.log），任务容器再次停止，3175/29775/5195无残留监听。未启用显式开关的安全默认运行2 skipped，单列且不计业务通过。

### CI及剩余门禁

R7 a694760a真实完整14项成功，含plan/security、各qualification、release-artifact、ci-gate；此结论不继承到R8新head。交付时回读新head实际全部checks，并续设原实际子checks、15astra、原交付线程、1800秒/timeout wake。

厂商SNMP设备、正式共享在线调度/binding、完整Agent链路、人工读屏及性能未完成。服务器测试授权不外推这些操作。无共享部署重启、Provider修改或产品模型调用，父账本188299不变；182固定c102不扩。PR继续draft，in_review仅交增量审核，不表示整体业务齐备。

证据包仅含脱敏实际文件，排除原始API日志、JWT/trace和原始journal。清单逐项对应ZIP，凭据不入包。六前端及共享安全层源码hash用于核对未变范围。
