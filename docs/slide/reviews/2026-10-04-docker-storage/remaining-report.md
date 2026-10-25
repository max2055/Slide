# Docker Data 目录剩余空间复核

观察时间：2026-10-04T03:21:29.028Z（UTC）。本次仅检查；没有再次清理。使用 Docker 与系统排障技能核对宿主机实际分配空间、Docker 对象占用及引用关系。

## 79 GB 在哪里

- `/Users/max/Library/Containers/com.docker.docker/Data` 实测分配约 **77.25 GB**（du -k，十进制换算）。
- `vms/0/data/Docker.raw` 实际分配约 **77.21 GB**，占几乎全部空间。
- Docker.raw 逻辑长度 **494.33 GB**，是稀疏虚拟磁盘长度，不代表实际占用。
- `Data/log` 约 **46.08 MB**，其他宿主目录不足 1 MB；清理这些不是主要收益来源。
- Docker 内镜像约 **58.36 GB**，卷约 **14.68 GB**，容器可写层约 **4.76 GB**，构建缓存 **0**。这些与实际分配量接近，差异受统计口径、稀疏文件、文件系统及活跃写入影响；没有证据表明还有几十 GB 的旧构建缓存尚待清理。
- 用户看到的 79 GB 与当前 77.25 GB 存在时点/计量差异，未对用户所用显示工具作进一步验证。

## 按收益排序的候选

均已确认当前容器引用数为 0。镜像删除不删除数据库卷，但会失去本地该版本的直接启动/离线回滚能力；未来需重新拉取或构建。表中“独占”指 Docker Size - SharedSize，不将共享层重复累加。

|候选|独占空间|判断|
|---|---:|---|
|`container-registry.oracle.com/database/free:latest`（8a8084193724）|13.51 GB|若近期无需 Oracle Free 测试，可优先删除|
|`gvenzl/oracle-free:slim`（8f9a8225cc43）|2.27 GB|若近期无需该 Oracle Free 版本，可删除|
|无标签镜像 `dae84b979298`|2.01 GB|无容器引用；无保留需求时可优先删除|
|`slide-verify/api-dependencies:51c3652`|0.53 GB|旧验证镜像，无保留需求时可删除|
|5 个 Decorix 镜像|至少 8.25 GB|其他项目镜像，确认不再需要后清理；含 latest，不能一律视为过期|
|40 个 `slide-release/*` 镜像|至少 1.97 GB|2026-09-04～2026-09-24 历史版本；先决定保留的发布/回滚版本|
|其他未引用基础/工具镜像|约 1.32 GB 独占空间|按是否仍需离线使用逐项确认|

两个 Oracle Free 镜像不是 `oracle19c` 容器正在引用的 `anuragmanchanda/oracle_db19:latest`；删除候选 Oracle Free 镜像不涉及 oracle19c 的现有数据库。两个 Oracle Free + 无标签 + 旧验证镜像的独占空间合计约 **18.32 GB**。

Decorix 候选标签为 `goal-final`、`goal-audit`、`latest`（同一镜像另有 `local-api-security` 标签）、`scene-data-integrity`、`release-foundation`。5 个镜像的表观大小相加约 12.95 GB，但至少 8.25 GB 为独占，不能把 12.95 GB 直接视为必然释放量。

全部 60 个未引用镜像独占空间共约 **29.86 GB**，已经包含以上各类，不能再叠加一次。

## 数据卷与容器

- 剩余 **48 个旧匿名孤儿卷，共 8.44 GB**，创建于 2026-05-03～2026-09-30。均无引用，但缺少来源标签；可能包含旧数据库内容，应识别用途后再清理。
- 6 个已停止的历史测试容器及其卷约 **1.45 GB**，见原调查报告的精确容器/卷映射。确认不需要历史测试数据后可定向清理。
- `mysql_data` 无引用但用途不明，约 **225 MB**，保留待确认。
- `slide_mysql-data` 与 `slide_agent-state` 是无引用空卷，删除没有空间收益。
- **oracle19c 的约 4.70 GB 位于容器可写层，没有挂载数据卷。不能把“已停止”视为可丢弃。** 其引用的 Oracle 19c 镜像约 8.57 GB 同样保留。
- Slide/TSDRM/MySQL 正在使用的数据、其他项目仍被容器引用的数据继续保留。

## 建议的下一步范围

最小的高收益批次是两个未使用 Oracle Free 镜像、无标签镜像与旧验证镜像，合计约 18.32 GB 独占空间；适用前提是这些本地镜像不再承担离线使用/回滚用途。再按项目确认 Decorix 和 Slide 历史版本。旧数据库卷放在最后，按用途和备份决定。

不要直接删除 `Docker.raw` 或重置 Docker Desktop：那里包含所有现存 Docker 数据。若之后清理对象后仍出现明显“逻辑使用下降、物理分配未下降”，再单独检查磁盘回收；当前未执行压缩、重置或磁盘迁移。

精确镜像 ID、标签、大小、引用数与旧卷清单：[remaining-candidates.json](remaining-candidates.json)。本次没有删除任何对象。

