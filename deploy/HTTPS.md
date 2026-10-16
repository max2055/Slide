# HTTPS / WSS 切换与验证

AI 助手连接由浏览器经 `/agent-ws` 进入 DirectAdapter。普通 HTTP 的
`/api/llm/test` 成功不能证明这条 WebSocket 链路正常。
生产入口使用以下已有拓扑：

```text
浏览器 HTTPS/WSS :443 → tls-edge → frontend:8080 → api:28888
```

前端根据页面协议自动选择同源 `wss://<页面host>/agent-ws`。
启用 HTTPS 页面即可，无需另设 WebSocket 地址或发布宿主 28888。
所有生产安全要求继续遵循 [SECURITY.md](SECURITY.md)。

## 证书与配置

先确认目标主机、部署目录、Compose 项目名/所有 override、env 文件和正在运行的版本。
保留现有镜像、数据库与 Agent 状态卷；TLS 切换不要求升级应用或迁移数据库。
证书由运维管理，证书链和私钥放在仓库外，通过只读挂载提供给 `tls-edge`。
私钥用受限组/ACL 向镜像内非 root 用户授予读取权限，不上传到 Git 或任务附件。

访问域名时证书须有相应 DNS SAN；访问 IP 时须有相应 IP SAN。
证书链必须受实际 Edge 主机信任，并在有效期内。内部 CA 需先按组织流程安装信任链。
忽略证书错误或仅签发未受客户端信任的证书不能作为验收。

在现有、受保护的 env 文件中设置以下值，保留其他配置和秘密：

```dotenv
SLIDE_PUBLIC_ORIGIN=https://slide.example.com
SLIDE_TLS_CERT=/secure/path/fullchain.pem
SLIDE_TLS_KEY=/secure/path/privkey.pem
SLIDE_HTTPS_BIND=0.0.0.0
SLIDE_HTTPS_PORT=443
SLIDE_REDIRECT_BIND=0.0.0.0
SLIDE_HTTP_REDIRECT_PORT=80
SLIDE_HTTP_BIND=127.0.0.1
SLIDE_HTTP_PORT=8080
```

将示例域名/文件路径替换成真实值。此方案使用标准外部 443；现有 HTTP 跳转
`https://$host$request_uri` 不携带自定义 HTTPS 端口，非标准端口须先调整跳转并验证。
保持 API 的 `CORS_ORIGINS`（Compose 从 `SLIDE_PUBLIC_ORIGIN` 注入）与实际 HTTPS origin 一致。

证书检查可输出公开元数据，并比较证书/私钥公钥摘要；不要输出私钥：

```bash
openssl x509 -in "$SLIDE_TLS_CERT" -noout -subject -issuer -dates -ext subjectAltName
openssl x509 -in "$SLIDE_TLS_CERT" -checkend 86400 -noout
openssl x509 -in "$SLIDE_TLS_CERT" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256
openssl pkey -in "$SLIDE_TLS_KEY" -pubout -outform DER | openssl dgst -sha256
```

以上 shell 变量需由运维设置；Compose 的 env 文件不会自动导出它们。
匹配 SAN 和客户端信任仍须通过实际客户端访问验证。

## 切换

操作前按实际对象记录 PID、端口、cwd、启动命令、镜像/Commit、日志位置；
同时确认当前会话、活跃请求和调度队列。备份 env、Compose、全部 override、nginx 配置及
旧证书文件引用，存到仅运维可读的目录（env 含秘密，不上传附件）。
记录 `tls-edge` 是否已经存在，以便区分回滚时恢复旧入口还是停止新增入口。

从真实部署目录、原 Docker context 和 Compose 项目执行。以下 Bash 数组须补齐所有原有 override，
`SLIDE_ENV_FILE`、`SLIDE_COMPOSE_PROJECT` 均为运维确认的实际值：

```bash
: "${SLIDE_ENV_FILE:?set the operator-managed env file}"
: "${SLIDE_COMPOSE_PROJECT:?set the existing Compose project}"
compose=(docker compose --project-name "$SLIDE_COMPOSE_PROJECT" --env-file "$SLIDE_ENV_FILE" -f compose.production.yaml)
"${compose[@]}" config --quiet
# 需要现有 frontend 运行且接入同一 edge 网络，验证证书挂载和 nginx 配置。
"${compose[@]}" run --rm --no-deps tls-edge nginx -t
```

确认当前环境的证书、端口及重启影响处于操作授权内后，逐个切换受影响服务：

```bash
# 只有 origin/CORS 确需变更时才执行；重建 API 会中断连接并涉及 worker/调度接续。
"${compose[@]}" up -d --no-deps --no-build --pull never api
# 只有 diagnostic 8080 绑定确需改为 loopback 时才执行。
"${compose[@]}" up -d --no-deps --no-build --pull never frontend
"${compose[@]}" up -d --no-deps --no-build --pull never tls-edge
"${compose[@]}" exec -T tls-edge nginx -t
"${compose[@]}" ps
```

依赖服务须已在运行。不要以整栈 `down/up` 代替定向操作，也不要顺带更新镜像。
防火墙允许客户端访问 443 和 80；8080 仅 loopback，API 3000/28888 保持内部可达。
客户端入口改为 HTTPS，HTTP 80 应返回 308 并保留路径和查询参数。

## 验证与回滚

在受影响的 Edge 主机确认以下事实：

1. HTTPS 页面无证书错误，SAN/有效期/信任链正确。
2. 连接 URL 为同源 `wss://<页面host>/agent-ws`，101 后有正常认证及双向协议帧。
3. AI 助手能够发送和收到回复，不再持续显示 `network_interrupted`。
4. 执行 [SECURITY.md](SECURITY.md#release-checks) 中的 Edge recovery 资格检查：
   30 次历史/新会话发送及五秒离线恢复；按原安全要求完成目标 Linux/rootless 资格检查。

业务发送沿用当前批准的模型配置与同批测试账本，不能因为 TLS 变更重置累计预算。
健康探针、HTTP LLM 测试、下述回显实验均不能替代这些业务验证。

证书不可信、nginx 验证失败、API 不就绪或消息收发退化时停止放量。
恢复受保护备份中的 env/Compose/override/nginx 配置和旧证书引用，先 `config --quiet`，
再对本次实际改动的服务执行上述带 `--no-deps --no-build --pull never` 的 `up`。
已有 `tls-edge` 恢复原配置；本次首次新增的入口可用 `"${compose[@]}" stop tls-edge` 停止。
回滚后检查原镜像、端口和就绪状态，不删数据卷、不回滚数据库。
若旧入口为不安全明文公网 8080，回滚不自动授权重新对外开放，应报告外部入口不可用。

## 本地代理回归

无需产品凭据或 LLM 即可验证两层原 nginx 配置、证书校验、308 跳转、101 后的 WebSocket 帧：

```bash
python3 scripts/qualification/check-tls-transport.py
```

需要本地 Docker engine、Python 3 和支持 `req -addext` 的 OpenSSL，镜像不存在时 Docker 会拉取固定摘要镜像。
脚本使用临时 IP SAN 证书，在自己的客户端内显式信任；也验证系统默认信任会拒绝该证书。
只发布 loopback 随机端口，创建独立网络和三个临时容器，退出时删除其容器/网络/证书。
临时私钥的实验权限不应复用于真实部署。后端是 HTTP/WebSocket 回显 fixture，
实验结果只证明代理传输，真实 Edge/认证/Agent/断线恢复仍由部署验收确认。
