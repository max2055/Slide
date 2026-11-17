# 入口与恢复验证接续

从0c322187接续，本轮不操作共享资源、不启动Reviewer。原R1/R2和技能问题保持关闭，R3仍待独立复核。

## 七个回退入口的结论与修复

| 入口 | 启用与连接路径 | 隔离及修复 |
|---|---|---|
| consistency-checker.mysql.test.ts | METRICS_TEST_MYSQL_PORT → 三个beforeAll → createConnection | 随机/任务schema并不隔离数据库账号；每个hook先要求密码变量已定义 |
| metrics/rollout/coordinator.mysql.test.ts | METRICS_TEST_MYSQL_PORT → beforeAll → root/pool及后续连接 | 同一显式密码用于后续连接；自建docker入口run-metrics-rollout显式注入空值 |
| notification-records-http.test.ts | NOTIFICATION_RECORDS_TEST_MYSQL_PORT → 单个显式真实it → createPool | 常规HTTP单测可继续不读私有环境；真实分支先检查密码，再认证夹具/建池 |
| operations/actions/plan-service.mysql.test.ts | OPERATIONS/AGENT_RUN端口 → beforeAll → admin/create schema/pool | run-operations-actions与run-investigation-rollout本已显式空值；检查仅在hook内，不使默认收集失败 |
| schema-database-service.large.mysql.test.ts | MAX539_MYSQL_TEST=1 → beforeAll → SNAPSHOT配置/建池 | 除既有端口/用户要求外补密码存在性要求 |
| sql-audit-service.mysql.test.ts | SQL_AUDIT_MYSQL_TEST=1 → beforeAll → SQL_AUDIT配置/建池 | 除既有端口/用户要求外补密码存在性要求 |
| frontend/e2e-real/server-inspection.spec.ts | playwright.server-inspection-real.config.ts → beforeAll → SLIDE_TEST配置/建池/任务schema/API | 补连接前密码存在性要求，不改产品UI；真实业务测试仍依赖明确目标 |

所有回退实际都是空字符串，不是写死的旧公开秘密。修复为拒绝undefined，保留显式空字符串，避免破坏自建无密码容器的合法输入。只有已核实自建容器的metrics包装入口新增显式空值；未对全部脚本广泛填入默认变量。变量已存在不证明资源授权或端点隔离，真实执行仍需manifest/owner目标核对，不能据此自动连接。

六个后端文件通过实际Vitest入口、显式启用和缺密码环境验证，均返回对应变量缺失错误。该负例验证不需要数据库连接；不当作真实SQL、权限/采集成功。前端入口本轮只核对源码/配置与前置位置，未启动真实浏览器/数据库。

## 字体与历史恢复

OTF 17个表逐项检查offset/length在文件边界内、记录表内容哈希；未解码CFF字形程序，不能承诺不存在任意隐藏数据。先前223图像OCR有限证据可复用，不重复执行。

本轮尝试全部本地refs的bundle/create/verify及mirror恢复。bundle验证宣称complete并不能覆盖当前仓库的shallow缺失：恢复实际遇到缺失父对象a1e9f5b161789f322a4bf4456208a955a684f8e3（子commit 1c50eafb978cbfd1b842294bdd7be2ebfd1a23f4），原mirror恢复失败。保留shallow边界的另一个独占恢复及fsck单列记录，不将其称为完整远端历史闭包。原7个blob映射、641路径commit、LFS与外部refs边界不扩大。

## A1–F1

B2补了七个显式入口缺配置拒绝和自建metrics包装兼容；六个后端实际负例通过。A1/D2的453字面值有效来源、构建变量/源映射仍未逐项完成，不能用词法标签关闭。E1本地恢复尝试新增shallow父对象缺口证据，完整远端/隐藏ref及全历史恢复仍缺。C1–C3真实轮换/数据账本/业务未执行；B1注入和两次claim依赖不变。D1原缺陷状态不变，F1当前候选CI/发布物须独立匹配，已有watch不重置。完整运行摘要与受限证据在项目outputs/max-681-convergence，不能认定本轮所有技术收敛完成。
