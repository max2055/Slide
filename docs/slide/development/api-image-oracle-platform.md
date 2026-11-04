# API 镜像 Oracle 客户端架构

`apps/db-ops-api/Dockerfile` 当前仅支持 `linux/arm64`。随构建上下文提供的 Oracle Instant Client 19.19 是 ARM64 包；`linux/amd64` 及其他架构在共享基础阶段退出非 0，不能生成可用生产镜像。所有阶段继承同一检查后的基础镜像，检查实际 Debian 架构，不能通过覆盖 TARGETARCH 绕过。

构建上下文需包含 Oracle 官方 Basic 包：
`oracle-client-build/instantclient-basic-linux.arm64-19.19.0.0.0dbru.zip`。
官方下载入口：https://www.oracle.com/database/technologies/instant-client/linux-arm-aarch64-downloads.html 。客户端不入库；不要用不同版本包重命名代替。

从仓库根目录构建（Docker daemon 需支持运行 ARM64）：

```bash
RELEASE_OUTPUT_DIR=/Users/max/Coding/40-Slide/outputs docker buildx build --platform linux/arm64 --load -f apps/db-ops-api/Dockerfile -t slide-max278:arm64 .
```

生产阶段以 UID/GID 10001 初始化实际 Oracle thick 驱动，加载失败或仍为 thin 时构建失败。构建后可再次无网络初始化，不需要连接数据库：

```bash
docker run --rm --network none --entrypoint node slide-max278:arm64 -e "const o=require('oracledb'); o.initOracleClient({libDir:process.env.NODE_ORACLEDB_CLIENT_LIB_DIR}); if(o.thin) throw new Error('thick required'); console.log(process.arch, o.thin, o.oracleClientVersionString)"
```

拒绝路径（预期退出非 0，包含 `linux/amd64 is unsupported`）：

```bash
RELEASE_OUTPUT_DIR=/Users/max/Coding/40-Slide/outputs docker buildx build --platform linux/amd64 --target supported-platform -f apps/db-ops-api/Dockerfile .
```

此限制适用于引用该 Dockerfile 的 Compose 服务。AMD64 主机需显式选择 ARM64 仿真且自行验证性能，不能将 AMD64 原生支持视为已有能力。新增 AMD64 支持需要提供匹配客户端并在实际镜像内完成 thick 初始化验证。此检查只验证驱动加载，不代表 Oracle 数据库连接或生产发布验收。
