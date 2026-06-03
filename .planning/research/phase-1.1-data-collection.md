# Phase 1: 完善后端数据采集 - 研究

**Researched:** 2026/04/21
**Domain:** Node.js/TypeScript 定时任务调度与数据库监控采集
**Confidence:** HIGH

## Summary

本研究针对 Slide 项目的 M1.Phase 1 - 完善后端数据采集阶段。项目已有一个基础的 `monitorCollector` 使用 `setInterval` 实现 30 秒间隔的监控指标采集，但缺少慢查询采集（每 5 分钟）和容量数据采集（每 1 小时）的定时任务，且缺少任务管理 API。

**Primary recommendation:** 引入 `cron` 库（kelektiv/node-cron）替换 `setInterval`，实现多速率定时采集任务，并新增采集任务管理 API（启动/停止/状态查询）。

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| 定时采集任务调度 | API / Backend | — | 服务端后台任务，独立于请求周期 |
| 监控指标采集 | API / Backend | Database / Storage | 从目标数据库读取指标，写入系统数据库 |
| 慢查询采集 | API / Backend | Database / Storage | 从目标数据库 performance_schema 读取 |
| 容量数据采集 | API / Backend | Database / Storage | 从目标数据库 information_schema 读取 |
| 采集任务管理 API | API / Backend | — | RESTful API 控制采集任务生命周期 |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `cron` | 4.4.0 | 定时任务调度（cron 语法） | Node.js 生态标准，支持标准 crontab 语法，TypeScript 类型定义完善 |
| `mysql2` | 3.20.0 | MySQL 数据库连接池 | 项目已在用，支持 Promise API |
| `pg` | 8.20.0 | PostgreSQL 客户端 | 项目已在用 |
| `oracledb` | 6.10.0 | Oracle/达梦数据库客户端 | 项目已在用 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/cron` | bundled | TypeScript 类型定义 | 使用 cron 库时自动包含 |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `cron` | `node-cron` | node-cron 更轻量，但 API 不如 cron 丰富 |
| `cron` | `setInterval` | setInterval 无需依赖，但不支持 cron 语法，管理复杂 |
| `cron` | `node-schedule` | node-schedule 功能更强，但依赖更多，体积更大 |
| `cron` | `fastify-cron` | 与 Fastify 集成，但项目不需要 Fastify 插件模式 |

**Recommendation:** 使用 `cron`（kelektiv/node-cron）— 标准 crontab 语法，TypeScript 支持好，维护活跃。

**Installation:**
```bash
cd /Users/max/Library/CloudStorage/OneDrive-个人/03-Coding/39-Slide/apps/db-ops-api
npm install cron
```

**Version verification:**
```bash
npm view cron version
# 4.4.0 (verified)
```

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    server.ts (Fastify)                          │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────────────────────┐    │
│  │  HTTP Routes    │    │      monitorCollector           │    │
│  │                 │    │  ┌───────────────────────────┐  │    │
│  │ /api/health     │    │  │  CronJob (metrics)        │  │    │
│  │ /api/alerts     │    │  │  "*/30 * * * * *"         │  │    │
│  │ /api/metrics/:id│    │  │                           │  │    │
│  │ /api/database/… │    │  │  CronJob (slow_queries)   │  │    │
│  │                 │    │  │  "*/5 * * * * *"          │  │    │
│  │ POST /api/      │    │  │                           │  │    │
│  │  collector/     │◄───┼──┤  CronJob (capacity)       │  │    │
│  │  start          │    │  │  "0 * * * * *"            │  │    │
│  │ POST /api/      │    │  │                           │  │    │
│  │  collector/     │────┤  │  Job Registry             │  │    │
│  │  stop           │    │  │  - running: boolean       │  │    │
│  │ GET /api/       │    │  │  - jobs: Map<name, Job>   │  │    │
│  │  collector/     │    │  │  - lastRun: Map           │  │    │
│  │  status         │    │  │  - nextRun: Map           │  │    │
│  └─────────────────┘    │  └───────────┬───────────────┘  │    │
│                         └──────────────┼──────────────────┘    │
└─────────────────────────────────────────┼───────────────────────┘
                                          │
                     ┌────────────────────┼────────────────────┐
                     │                    │                    │
              ┌──────▼───────┐   ┌────────▼────────┐  ┌────────▼────────┐
              │  database-   │   │  metrics-       │  │  instance-      │
              │  service.ts  │   │  database-      │  │  database-      │
              │              │   │  service.ts     │  │  service.ts     │
              │ • getMetrics │   │ • recordMetrics │  │ • getAllInstances│
              │ • getSlowQ.  │   │ • getLatest     │  │ • updateHealth  │
              │ • getCapacity│   │                 │  │                  │
              └──────┬───────┘   └────────┬────────┘  └────────┬────────┘
                     │                    │                    │
              ┌──────▼────────────────────▼────────────────────▼────────┐
              │              System Database (MySQL)                     │
              │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
              │  │metrics_    │  │slow_queries│  │instance_pool_stats │ │
              │  │history     │  │            │  │                    │ │
              │  └────────────┘  └────────────┘  └────────────────────┘ │
              └─────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                │             │             │
         ┌──────▼──────┐ ┌───▼────┐ ┌──────▼──────┐
         │  MySQL DB   │ │ Pg DB  │ │ Oracle/DM   │
         │(production) │ │(prod)  │ │ (prod)      │
         └─────────────┘ └────────┘ └─────────────┘
```

### Recommended Project Structure

```
apps/db-ops-api/
├── server.ts                      # 启动采集服务
├── src/
│   ├── monitor-collector.ts       # 定时采集服务（重构）
│   ├── database-service.ts        # 数据库连接与采集方法
│   ├── metrics-database-service.ts # 指标数据写入服务
│   ├── instance-database-service.ts # 实例管理服务
│   └── types/
│       └── collector.ts           # 采集任务类型定义（新增）
└── package.json
```

### Pattern 1: Multi-Rate Cron Job Scheduling
**What:** 使用 cron 库创建多个不同速率的定时任务

**When to use:** 当需要不同采集频率（30 秒、5 分钟、1 小时）时

**Example:**
```typescript
// Source: https://github.com/kelektiv/node-cron/blob/main/README.md
import { CronJob } from 'cron';

class MonitorCollector {
  private jobs: Map<string, CronJob> = new Map();
  private running = false;

  start() {
    if (this.running) return;

    // metrics 采集 - 每 30 秒
    const metricsJob = new CronJob(
      '*/30 * * * * *',  // cron 语法（6 段，含秒）
      () => this.collectMetrics(),
      null,
      true  // start immediately
    );
    this.jobs.set('metrics', metricsJob);

    // 慢查询采集 - 每 5 分钟
    const slowQueryJob = new CronJob(
      '0 */5 * * * *',  // 每 5 分钟第 0 秒
      () => this.collectSlowQueries(),
      null,
      true
    );
    this.jobs.set('slowQueries', slowQueryJob);

    // 容量数据采集 - 每 1 小时
    const capacityJob = new CronJob(
      '0 0 * * * *',  // 每小时整点
      () => this.collectCapacity(),
      null,
      true
    );
    this.jobs.set('capacity', capacityJob);

    this.running = true;
  }

  stop() {
    this.jobs.forEach((job) => job.stop());
    this.jobs.clear();
    this.running = false;
  }

  getStatus() {
    return {
      running: this.running,
      jobs: Array.from(this.jobs.entries()).map(([name, job]) => ({
        name,
        running: job.running,
        lastRun: job.lastDate(),
        nextRun: job.nextDates()[0],
      })),
    };
  }
}
```

### Pattern 2: Task Management API
**What:** 提供 RESTful API 控制采集任务

**When to use:** 需要动态启停采集任务时

**Example:**
```typescript
// 启动采集
fastify.post('/api/collector/start', async (request, reply) => {
  const { type } = request.body as { type?: 'metrics' | 'slowQueries' | 'capacity' | 'all' };
  try {
    if (type === 'all' || !type) {
      monitorCollector.start();
    } else {
      monitorCollector.startJob(type);
    }
    reply.send({ success: true, message: '采集任务已启动' });
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});

// 停止采集
fastify.post('/api/collector/stop', async (request, reply) => {
  const { type } = request.body as { type?: 'metrics' | 'slowQueries' | 'capacity' | 'all' };
  try {
    if (type === 'all' || !type) {
      monitorCollector.stop();
    } else {
      monitorCollector.stopJob(type);
    }
    reply.send({ success: true, message: '采集任务已停止' });
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});

// 获取状态
fastify.get('/api/collector/status', async (request, reply) => {
  try {
    const status = monitorCollector.getStatus();
    reply.send(status);
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});
```

### Anti-Patterns to Avoid
- **不要在 CronJob 中执行长时间阻塞操作** — onTick 回调应该快速返回，长时间操作应使用 Promise 并处理错误
- **不要忘记错误处理** — 每个采集任务必须有 try-catch，避免单个任务失败导致整个采集停止
- **不要硬编码时区** — 使用 `timeZone: 'Asia/Shanghai'` 明确指定时区，避免本地时间与服务器时间不一致
- **不要忘记清理资源** — 调用 `stop()` 时确保所有 CronJob 都正确停止

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 定时任务调度 | 自己用 `setInterval` + 时间戳计算 | `cron` 库 | cron 语法标准，支持复杂调度（如每小时/每天），时区处理正确 |
| 任务状态追踪 | 自己维护运行状态 | `CronJob` 内置 API | `job.running`、`job.lastDate()`、`job.nextDates()` 已提供 |
| 并发控制 | 自己用 flag 控制 | `waitForCompletion: true` | cron 库支持等待前一个任务完成再执行下一次 |
| 错误重试 | 自己实现重试逻辑 | onTick 内实现 + 日志 | 定时任务本身会按周期重试，只需记录错误 |

**Key insight:** `setInterval` 看似简单，但无法处理复杂调度（如"每小时整点"），且缺少状态查询 API。`cron` 库仅增加 ~50KB 依赖，但提供完整的调度能力。

## Runtime State Inventory

> 此阶段为功能增强，不涉及重命名/迁移，无运行时状态需要迁移。

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | 无 | — |
| Live service config | 无 | — |
| OS-registered state | 无 | — |
| Secrets/env vars | 无 | — |
| Build artifacts | 无 | — |

## Common Pitfalls

### Pitfall 1: Cron 语法错误
**What goes wrong:** 使用 5 段 cron 语法（分时时日月周）而非 6 段（含秒）

**Why it happens:** 传统 crontab 是 5 段，但 `cron` 库默认支持 6 段（含秒）

**How to avoid:** 始终使用 6 段语法，明确指定秒字段。例如：
- `*/30 * * * * *` = 每 30 秒
- `0 */5 * * * *` = 每 5 分钟第 0 秒
- `0 0 * * * *` = 每小时整点

**Warning signs:** 任务执行频率与预期不符

### Pitfall 2: 时区问题
**What goes wrong:** 服务器时区与预期不一致，导致采集时间偏移

**Why it happens:** `cron` 默认使用本地时区，但服务器可能是 UTC

**How to avoid:** 创建 CronJob 时明确指定 `timeZone: 'Asia/Shanghai'`

**Warning signs:** 日志时间戳与预期时间差 8 小时

### Pitfall 3: 未处理的 Promise 拒绝
**What goes wrong:** 异步采集函数抛出未捕获的 Promise 拒绝，导致进程崩溃

**Why it happens:** onTick 回调是异步函数，但未用 try-catch 包裹

**How to avoid:** 
```typescript
const job = new CronJob(
  '* * * * * *',
  async () => {
    try {
      await this.collect();
    } catch (error) {
      console.error('采集失败:', error);
    }
  }
);
```

### Pitfall 4: 重复启动导致多个实例
**What goes wrong:** 多次调用 `start()` 创建多个相同任务的 CronJob 实例

**Why it happens:** 没有检查任务是否已在运行

**How to avoid:** 使用 `running` 标志或在 Map 中检查是否已存在同名任务

## Code Examples

### 创建带时区的 CronJob
```typescript
// Source: https://github.com/kelektiv/node-cron/blob/main/README.md
import { CronJob } from 'cron';

const job = new CronJob(
  '0 */5 * * * *',  // 每 5 分钟
  async () => {
    try {
      await collectSlowQueries();
      console.log('慢查询采集完成');
    } catch (error) {
      console.error('慢查询采集失败:', error);
    }
  },
  null,  // onComplete
  true,  // start immediately
  'Asia/Shanghai'  // timeZone
);
```

### 获取任务下次执行时间
```typescript
// Source: https://github.com/kelektiv/node-cron/blob/main/README.md
const nextDates = job.nextDates(3);  // 获取未来 3 次执行时间
console.log(nextDates.map(d => d.toISOString()));
// ['2026-04-21T10:05:00.000Z', '2026-04-21T10:10:00.000Z', ...]
```

### 动态启动/停止单个任务
```typescript
// 启动特定任务
startJob(type: 'metrics' | 'slowQueries' | 'capacity') {
  const job = this.jobs.get(type);
  if (job && !job.running) {
    job.start();
    console.log(`已启动采集任务：${type}`);
  }
}

// 停止特定任务
stopJob(type: 'metrics' | 'slowQueries' | 'capacity') {
  const job = this.jobs.get(type);
  if (job && job.running) {
    job.stop();
    console.log(`已停止采集任务：${type}`);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `setInterval(fn, 30000)` | `CronJob('*/30 * * * * *', fn)` | 持续 | 支持更复杂的调度语法 |
| 单一采集间隔 | 多速率采集（30 秒/5 分/1 小时） | Phase 1 | 不同数据类型采用合理采集频率 |
| 手动管理定时器 | `CronJob` 内置状态管理 | Phase 1 | 可查询下次执行时间、上次执行时间 |
| 无任务管理 API | RESTful API 控制启停 | Phase 1 | 运维人员可动态控制采集 |

**Deprecated/outdated:**
- `setInterval` 用于生产级定时任务：缺少状态查询、时区支持、复杂调度能力

## Assumptions Log

> 列表中的所有声明均为 [ASSUMED]，需要用户确认。

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | 项目使用 6 段 cron 语法（含秒）而非传统 5 段 | Pattern 1 | 任务执行频率可能与预期不符 |
| A2 | 采集时区应为 'Asia/Shanghai' | Pattern 1 | 采集时间可能偏移 8 小时 |
| A3 | 慢查询采集 5 分钟间隔是合理的 | Summary | 可能过于频繁或不够频繁 |
| A4 | 容量数据 1 小时采集间隔是合理的 | Summary | 可能过于频繁或不够频繁 |

## Open Questions

1. **采集频率是否需要动态配置？**
   - What we know: 当前硬编码 30 秒/5 分钟/1 小时
   - What's unclear: 是否需要通过 API 或配置文件动态调整
   - Recommendation: Phase 1 先硬编码，Phase 2 可从 `system_config` 表读取配置

2. **是否需要采集失败告警？**
   - What we know: 当前只记录错误日志
   - What's unclear: 是否需要连续失败 N 次后触发告警
   - Recommendation: Phase 1 只记录日志，告警功能在后续阶段实现

3. **慢查询采集是否需要去重？**
   - What we know: `metricsDatabaseService.recordSlowQuery` 已有基于 `sql_hash` 的去重逻辑
   - What's unclear: 是否需要在采集层再次去重
   - Recommendation: 依赖服务层去重即可，采集层无需重复

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | v20.x+ | — |
| TypeScript | Build | ✓ | 5.3.2 | — |
| MySQL | Target DB | ✓ | 8.0+ | — |
| PostgreSQL | Target DB | ✓ | 14+ | — |
| Oracle | Target DB | ✗ | — | 跳过 Oracle 采集 |
| 达梦 | Target DB | ✗ | — | 跳过达梦采集 |
| `cron` npm 包 | Scheduler | ✗ | — | 需安装 |

**Missing dependencies with no fallback:**
- `cron` npm 包 — 需要运行 `npm install cron`

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 |
| Config file | 未在 package.json 中发现 vitest.config.* |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | metrics 每 30 秒采集 | unit | `vitest run tests/collector.test.ts` | ❌ Wave 0 |
| DATA-02 | 慢查询每 5 分钟采集 | unit | `vitest run tests/collector.test.ts` | ❌ Wave 0 |
| DATA-03 | 容量数据每小时采集 | unit | `vitest run tests/collector.test.ts` | ❌ Wave 0 |
| DATA-04 | 采集任务管理 API | integration | `vitest run tests/collector-api.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** 全绿后方可 `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/monitor-collector.test.ts` — 采集任务单元测试
- [ ] `tests/collector-api.test.ts` — 管理 API 集成测试
- [ ] `vitest.config.ts` — Vitest 配置文件（如果不存在）

## Security Domain

> 此阶段为内部定时任务，不直接暴露于外部请求，但仍需注意：

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | 管理 API 需 JWT 验证 |
| V3 Session Management | no | — |
| V4 Access Control | yes | 仅 admin/dba 角色可控制采集 |
| V5 Input Validation | yes | 验证 type 参数枚举值 |
| V6 Cryptography | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| 未授权访问管理 API | Spoofing | JWT 中间件验证 |
| 参数注入攻击 | Tampering | 验证 type 参数为枚举值 |
| 信息泄露 | Information Disclosure | 状态 API 不暴露敏感配置 |

## Sources

### Primary (HIGH confidence)
- `/kelektiv/node-cron` (Context7) - CronJob API 文档、示例代码
- `https://github.com/kelektiv/node-cron/blob/main/README.md` - 官方 README
- 项目现有代码 `monitor-collector.ts` - 当前采集逻辑
- 项目现有代码 `database-service.ts` - 数据采集方法

### Secondary (MEDIUM confidence)
- `npm view cron version` - 包版本验证

### Tertiary (LOW confidence)
- 无

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - 基于项目现有依赖和官方文档
- Architecture: HIGH - 基于现有代码分析和 cron 库文档
- Pitfalls: MEDIUM - 基于 cron 库常见问题和项目经验

**Research date:** 2026/04/21
**Valid until:** 2026/07/21 - cron 库 API 稳定，3 个月内不会重大变更
