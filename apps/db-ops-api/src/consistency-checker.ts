/**
 * Consistency Checker — cross-table integrity checks for system health monitoring.
 * Provides `GET /api/health/consistency` data source (10 checks + readiness).
 */
import { dbConnection } from './db-connection';
import * as net from 'net';
import { aggregateHealth, type HealthTruth } from './health-truth.js';

// ── Types ────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'deferred';

export interface ConsistencyCheck {
  id: string;
  label: string;
  category: string;
  status: CheckStatus;
  severity: 'info' | 'minor' | 'major' | 'critical';
  summary: string;
  details?: unknown;
  recommendation?: string;
}

export interface ReadinessStatus {
  db_connected: boolean;
  db_reachable: boolean;
  llm_provider: boolean;
  cron_running: boolean;
  agent_engine: boolean;
}

export interface ConsistencyResponse {
  timestamp: string;
  summary: { pass: number; warn: number; fail: number; deferred: number; total: number };
  checks: ConsistencyCheck[];
  readiness: ReadinessStatus;
}

// ── ConsistencyChecker ───────────────────────────────────

export class ConsistencyChecker {
  async resourceHealthTruth(): Promise<HealthTruth> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');
    const [rows] = await pool.execute(`
      SELECT di.id, di.health_status, MAX(mh.recorded_at) AS latest_metric
      FROM database_instances di
      LEFT JOIN metrics_history mh ON mh.instance_id = di.id
      WHERE di.status = 'active'
      GROUP BY di.id, di.health_status
    `) as any;
    const total = rows.length;
    const available = rows.filter((row: any) => row.health_status === 'healthy').length;
    const fresh = rows.filter((row: any) => row.latest_metric && Date.now() - new Date(row.latest_metric).getTime() <= 10 * 60_000).length;
    const status = (good: number): import('./health-truth.js').HealthStatus => total === 0 ? 'unknown' : good === total ? 'healthy' : good / total <= 0.2 ? 'critical' : 'degraded';
    return aggregateHealth({
      controlPlane: { status: 'healthy', numerator: 1, denominator: 1 },
      managedAvailability: { status: status(available), numerator: available, denominator: total },
      dataFreshness: { status: status(fresh), numerator: fresh, denominator: total },
      workflow: { status: 'unknown', numerator: 0, denominator: 0 },
    });
  }
  // ── Safe wrapper ─────────────────────────────────────

  async _checkSafe(
    fn: () => Promise<ConsistencyCheck>,
    id: string,
    label: string,
    category: string,
  ): Promise<ConsistencyCheck> {
    try {
      return await fn();
    } catch (err: any) {
      return {
        id,
        label,
        category,
        status: 'fail',
        severity: 'critical',
        summary: `检查异常: ${err.message}`,
        recommendation: '请检查服务日志和数据库连接',
      };
    }
  }

  // ── 1. Instance count match ──────────────────────────

  async _checkInstanceCountMatch(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [rows] = await pool.execute(
      'SELECT COUNT(*) as active_count, COALESCE(SUM(data_size_gb), 0) as total_data_size FROM database_instances WHERE status = ?',
      ['active'],
    ) as any;

    const activeCount = Number(rows[0]?.active_count || 0);
    if (activeCount > 0) {
      return {
        id: 'instance_count_match',
        label: '活跃实例数量',
        category: 'instance',
        status: 'pass',
        severity: 'info',
        summary: `当前活跃实例 ${activeCount} 个`,
      };
    }
    return {
      id: 'instance_count_match',
      label: '活跃实例数量',
      category: 'instance',
      status: 'fail',
      severity: 'critical',
      summary: '无活跃实例',
      recommendation: '请添加数据库实例',
    };
  }

  // ── 2. Capacity sum match ────────────────────────────

  async _checkCapacitySumMatch(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [instRows] = await pool.execute(
      'SELECT COALESCE(SUM(data_size_gb), 0) as inst_total FROM database_instances WHERE status = ?',
      ['active'],
    ) as any;
    const instTotal = Number(instRows[0]?.inst_total || 0);

    // Get per-instance capacity vs DB record
    const [perInst] = await pool.execute(
      `SELECT di.id, di.name, di.data_size_gb as inst_size,
              COALESCE(ch.total_size_gb, -1) as cap_size,
              ch.recorded_at as cap_ts
       FROM database_instances di
       LEFT JOIN (
         SELECT ch1.instance_id, ch1.total_size_gb, ch1.recorded_at
         FROM capacity_history ch1
         INNER JOIN (
           SELECT instance_id, MAX(recorded_at) as max_ts
           FROM capacity_history GROUP BY instance_id
         ) latest ON ch1.instance_id = latest.instance_id AND ch1.recorded_at = latest.max_ts
       ) ch ON di.id = ch.instance_id
       WHERE di.status = 'active'`,
      [],
    ) as any;

    // Only sum instances that have capacity records (to avoid mixing in stale data)
    let capTotal = 0;
    const gaps: { id: number; name: string; inst_size: number; cap_size: number; cap_ts: string | null }[] = [];
    for (const r of perInst) {
      const instSize = Number(r.inst_size || 0);
      const capSize = Number(r.cap_size || 0);
      if (r.cap_ts && capSize >= 0) {
        capTotal += capSize;
        if (Math.abs(instSize - capSize) > 0.5) {
          gaps.push({ id: r.id, name: r.name, inst_size: instSize, cap_size: capSize, cap_ts: r.cap_ts });
        }
      } else if (instSize > 0) {
        gaps.push({ id: r.id, name: r.name, inst_size: instSize, cap_size: -1, cap_ts: null });
      }
    }

    const delta = Math.abs(instTotal - capTotal);
    if (gaps.length === 0 && delta < 1) {
      return {
        id: 'capacity_sum_match',
        label: '容量数据一致性',
        category: 'capacity',
        status: 'pass',
        severity: 'info',
        summary: `实例总容量 ${instTotal.toFixed(1)}GB 与容量历史 ${capTotal.toFixed(1)}GB 一致`,
      };
    }
    if (gaps.length > 0) {
      const gapDetails = gaps.map(g =>
        `${g.name}: DB=${g.inst_size}GB, cap=${g.cap_size < 0 ? 'none' : g.cap_size + 'GB'}`).join('; ');
      return {
        id: 'capacity_sum_match',
        label: '容量数据一致性',
        category: 'capacity',
        status: 'warn',
        severity: 'minor',
        summary: `${gaps.length} 个实例容量数据不一致`,
        details: gaps,
        recommendation: `运行容量采集或检查实例连接：${gapDetails}`,
      };
    }
    return {
      id: 'capacity_sum_match',
      label: '容量数据一致性',
      category: 'capacity',
      status: 'warn',
      severity: 'minor',
      summary: `实例总容量 ${instTotal.toFixed(1)}GB 与容量历史 ${capTotal.toFixed(1)}GB 偏差 ${delta.toFixed(1)}GB`,
      recommendation: '检查容量采集是否正常运行',
    };
  }

  // ── 3. Metrics freshness ─────────────────────────────

  async _checkMetricsFreshness(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [rows] = await pool.execute(
      'SELECT MAX(recorded_at) as latest FROM metrics_history',
      [],
    ) as any;

    const latest = rows[0]?.latest;
    if (!latest) {
      return {
        id: 'metrics_freshness',
        label: '指标采集新鲜度',
        category: 'metrics',
        status: 'fail',
        severity: 'info',
        summary: '暂无指标数据（新系统）',
        recommendation: '等待指标采集任务运行或手动触发采集',
      };
    }

    const ageMs = Date.now() - new Date(latest).getTime();
    const ageMin = ageMs / 60000;

    if (ageMin <= 10) {
      return {
        id: 'metrics_freshness',
        label: '指标采集新鲜度',
        category: 'metrics',
        status: 'pass',
        severity: 'info',
        summary: `最新指标 ${ageMin.toFixed(1)} 分钟前`,
      };
    }
    if (ageMin <= 60) {
      return {
        id: 'metrics_freshness',
        label: '指标采集新鲜度',
        category: 'metrics',
        status: 'warn',
        severity: 'minor',
        summary: `最新指标 ${ageMin.toFixed(0)} 分钟前（超过 10 分钟阈值）`,
        recommendation: '检查指标采集频率是否正常',
      };
    }
    return {
      id: 'metrics_freshness',
      label: '指标采集新鲜度',
      category: 'metrics',
      status: 'fail',
      severity: 'major',
      summary: `最新指标 ${(ageMin / 60).toFixed(1)} 小时前`,
      recommendation: '指标采集可能已停止，请检查采集服务',
    };
  }

  // ── 4. Alert rule metric refs ────────────────────────

  async _checkAlertRuleMetricRefs(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [rows] = await pool.execute(
      `SELECT ar.id, ar.name, ar.metric_name
       FROM alert_rules ar
       LEFT JOIN metric_definitions md ON ar.metric_name = md.id
       WHERE md.id IS NULL AND ar.metric_name IS NOT NULL`,
      [],
    ) as any;

    const count = rows.length;
    if (count === 0) {
      return {
        id: 'alert_rule_metric_refs',
        label: '告警规则指标引用',
        category: 'alert',
        status: 'pass',
        severity: 'info',
        summary: '所有告警规则的指标引用均有效',
      };
    }
    return {
      id: 'alert_rule_metric_refs',
      label: '告警规则指标引用',
      category: 'alert',
      status: 'fail',
      severity: 'major',
      summary: `${count} 条告警规则引用了无效指标`,
      details: rows.map((r: any) => ({ id: r.id, name: r.name, metric_name: r.metric_name })),
      recommendation: '请修复告警规则中引用的无效指标名',
    };
  }

  // ── 5. Event member status match ─────────────────────

  async _checkEventMemberStatusMatch(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [rows] = await pool.execute(
      `SELECT ae.id, ae.event_id, ae.title, ae.status as event_status, COUNT(aem.id) as open_members
       FROM alert_events ae
       JOIN alert_event_members aem ON ae.id = aem.event_id
       JOIN alerts a ON aem.alert_id = a.id
       WHERE ae.status IN (?, ?) AND a.status NOT IN (?, ?)
       GROUP BY ae.id, ae.event_id, ae.title, ae.status`,
      ['resolved', 'closed', 'resolved', 'closed'],
    ) as any;

    const count = rows.length;
    if (count === 0) {
      return {
        id: 'event_member_status_match',
        label: '告警事件-成员状态一致',
        category: 'alert',
        status: 'pass',
        severity: 'info',
        summary: '所有告警事件与其成员告警状态一致',
      };
    }
    return {
      id: 'event_member_status_match',
      label: '告警事件-成员状态一致',
      category: 'alert',
      status: 'fail',
      severity: 'major',
      summary: `${count} 个已关闭事件存在 open 状态的成员告警`,
      details: rows.map((r: any) => ({
        event_id: r.event_id,
        title: r.title,
        event_status: r.event_status,
        open_members: r.open_members,
      })),
      recommendation: '请检查并修复已关闭事件中的成员告警状态',
    };
  }

  // ── 6. RBAC orphan records ───────────────────────────

  async _checkRbacOrphanRecords(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [rolePermRows] = await pool.execute(
      `SELECT rp.id FROM role_permissions rp
       LEFT JOIN roles r ON rp.role_id = r.id
       WHERE r.id IS NULL`,
      [],
    ) as any;

    const [userRoleRows] = await pool.execute(
      `SELECT ur.id FROM user_roles ur
       LEFT JOIN users u ON ur.user_id = u.id
       WHERE u.id IS NULL`,
      [],
    ) as any;

    const totalOrphans = rolePermRows.length + userRoleRows.length;
    if (totalOrphans === 0) {
      return {
        id: 'rbac_orphan_records',
        label: 'RBAC 悬空记录',
        category: 'rbac',
        status: 'pass',
        severity: 'info',
        summary: '无悬空的 role_permissions 或 user_roles 记录',
      };
    }
    return {
      id: 'rbac_orphan_records',
      label: 'RBAC 悬空记录',
      category: 'rbac',
      status: 'warn',
      severity: 'minor',
      summary: `${totalOrphans} 条悬空记录（role_permissions: ${rolePermRows.length}, user_roles: ${userRoleRows.length}）`,
      recommendation: '请清理悬空的 role_permissions 或 user_roles 记录',
    };
  }

  // ── 7. Cron hung/stalled jobs ────────────────────────

  async _checkCronHungJobs(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [hungRows] = await pool.execute(
      `SELECT cj.id, cj.name, cjl.started_at
       FROM cron_jobs cj
       JOIN cron_job_logs cjl ON cj.id = cjl.job_id AND cjl.status = ?
       WHERE cj.enabled = TRUE AND cjl.started_at < NOW() - INTERVAL 10 MINUTE`,
      ['running'],
    ) as any;

    const [stalledRows] = await pool.execute(
      `SELECT id, name, next_run_at
       FROM cron_jobs
       WHERE enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at < NOW()`,
      [],
    ) as any;

    const hungCount = hungRows.length;
    const stalledCount = stalledRows.length;
    if (hungCount === 0 && stalledCount === 0) {
      return {
        id: 'cron_hung_jobs',
        label: '定时任务状态检查',
        category: 'cron',
        status: 'pass',
        severity: 'info',
        summary: '所有定时任务正常运行',
      };
    }

    const parts: string[] = [];
    if (hungCount > 0) parts.push(`${hungCount} 个任务悬挂超过 10 分钟`);
    if (stalledCount > 0) parts.push(`${stalledCount} 个任务超过预定执行时间`);

    return {
      id: 'cron_hung_jobs',
      label: '定时任务状态检查',
      category: 'cron',
      status: hungCount > 0 ? 'fail' : 'warn',
      severity: hungCount > 0 ? 'major' : 'minor',
      summary: parts.join('；'),
      details: {
        hung: hungRows.map((r: any) => ({ id: r.id, name: r.name, started_at: r.started_at })),
        stalled: stalledRows.map((r: any) => ({ id: r.id, name: r.name, next_run_at: r.next_run_at })),
      },
      recommendation: hungCount > 0
        ? '请检查 cron 执行器或手动复位悬挂任务'
        : '请检查 cron 执行器调度是否正常',
    };
  }

  // ── 8. Chat session stats ────────────────────────────

  async _checkChatSessionStats(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [rows] = await pool.execute(
      `SELECT cs.id, cs.session_id, cs.message_count as stored_count,
              COUNT(cm.id) as actual_count,
              cs.last_message_at as stored_last_msg,
              MAX(cm.created_at) as actual_last_msg
       FROM chat_sessions cs
       LEFT JOIN chat_messages cm ON cs.session_id = cm.session_id
       GROUP BY cs.id, cs.session_id, cs.message_count, cs.last_message_at`,
      [],
    ) as any;

    const mismatches: any[] = [];
    let deferredSessions = 0; // DirectAdapter sessions don't maintain aggregates
    let emptySessions = 0; // sessions with 0 actual messages but residual metadata
    for (const r of rows) {
      const storedCount = Number(r.stored_count || 0);
      const actualCount = Number(r.actual_count || 0);
      const storedLast = r.stored_last_msg ? new Date(r.stored_last_msg).getTime() : null;
      const actualLast = r.actual_last_msg ? new Date(r.actual_last_msg).getTime() : null;

      if (storedCount !== actualCount || storedLast?.toString() !== actualLast?.toString()) {
        // DirectAdapter sessions never update message_count — known behavior
        if (storedCount === 0 && actualCount > 0) {
          deferredSessions++;
        } else if (actualCount === 0 && storedCount === 0 && storedLast && !actualLast) {
          // Empty sessions with residual last_message_at after message deletion
          emptySessions++;
        } else {
          mismatches.push({
            session_id: r.session_id,
            stored_count: storedCount,
          actual_count: actualCount,
          stored_last_msg: r.stored_last_msg,
          actual_last_msg: r.actual_last_msg,
        });
      }
      }
    }

    if (mismatches.length === 0 && deferredSessions === 0 && emptySessions === 0) {
      return {
        id: 'chat_session_stats',
        label: 'Chat 会话统计一致性',
        category: 'chat',
        status: 'pass',
        severity: 'info',
        summary: '所有 Chat 会话的消息计数和时间戳一致',
      };
    }

    const parts: string[] = [];
    if (mismatches.length > 0) parts.push(`${mismatches.length} 个会话统计数据不一致`);
    if (deferredSessions > 0) parts.push(`${deferredSessions} 个 DirectAdapter 会话不维护计数`);
    if (emptySessions > 0) parts.push(`${emptySessions} 个空会话残留元数据`);

    return {
      id: 'chat_session_stats',
      label: 'Chat 会话统计一致性',
      category: 'chat',
      status: mismatches.length > 0 ? 'warn' : 'pass',
      severity: mismatches.length > 0 ? 'minor' : 'info',
      summary: parts.join('；'),
      details: { mismatches, deferred_sessions: deferredSessions, empty_sessions: emptySessions },
      recommendation: mismatches.length > 0 ? '会话统计数据不一致，可运行修复脚本重建计数' : '非功能性残留数据，不影响功能',
    };
  }

  // ── 9. Approval event integrity ──────────────────────

  async _checkApprovalEventIntegrity(): Promise<ConsistencyCheck> {
    const pool = dbConnection.getPool();
    if (!pool) throw new Error('数据库未连接');

    const [orphanRows] = await pool.execute(
      `SELECT ar.id FROM approval_requests ar
       WHERE ar.status IN (?, ?)
       AND NOT EXISTS (
         SELECT 1 FROM approval_events ae
         WHERE ae.request_id = ar.id AND ae.event_type IN (?, ?)
       )`,
      ['approved', 'executed', 'approved', 'executed'],
    ) as any;

    const [oldPendingRows] = await pool.execute(
      `SELECT id, created_at FROM approval_requests
       WHERE status = ? AND created_at < NOW() - INTERVAL 7 DAY`,
      ['pending'],
    ) as any;

    const orphanCount = orphanRows.length;
    const oldPendingCount = oldPendingRows.length;

    if (orphanCount === 0 && oldPendingCount === 0) {
      return {
        id: 'approval_event_integrity',
        label: '审批事件完整性',
        category: 'approval',
        status: 'pass',
        severity: 'info',
        summary: '所有审批请求的事件记录完整',
      };
    }

    const parts: string[] = [];
    if (orphanCount > 0) parts.push(`${orphanCount} 个已批准/执行请求缺少对应事件`);
    if (oldPendingCount > 0) parts.push(`${oldPendingCount} 个请求待处理超过 7 天`);

    return {
      id: 'approval_event_integrity',
      label: '审批事件完整性',
      category: 'approval',
      status: orphanCount > 0 ? 'fail' : 'warn',
      severity: orphanCount > 0 ? 'major' : 'minor',
      summary: parts.join('；'),
      details: {
        orphaned_approvals: orphanRows.map((r: any) => ({ id: r.id })),
        old_pending: oldPendingRows.map((r: any) => ({ id: r.id, created_at: r.created_at })),
      },
      recommendation: orphanCount > 0
        ? '请检查审批请求的事件记录是否丢失'
        : '请处理超期的待审批请求',
    };
  }

  // ── 10. Notification deferred ────────────────────────

  async _checkNotificationDeferred(): Promise<ConsistencyCheck> {
    return {
      id: 'notification_closure',
      label: '通知闭环完成性',
      category: 'notification',
      status: 'deferred',
      severity: 'info',
      summary: '通知闭环检查已推迟到下一 phase 实现',
      recommendation: '通知发送链路（钉钉/企微/飞鹰/webhook）需在后续 phase 完整实现',
    };
  }

  // ── Readiness check ──────────────────────────────────

  async _checkReadiness(): Promise<ReadinessStatus> {
    const dbConnected = dbConnection.isConnected();

    let dbReachable = false;
    if (dbConnected) {
      try {
        const pool = dbConnection.getPool();
        if (pool) {
          await pool.execute('SELECT 1', []);
          dbReachable = true;
        }
      } catch {
        dbReachable = false;
      }
    }

    let llmProvider = false;
    if (dbConnected) {
      try {
        const pool = dbConnection.getPool();
        if (pool) {
          const [rows] = await pool.execute(
            'SELECT id FROM llm_providers WHERE enabled = TRUE LIMIT 1',
            [],
          ) as any;
          llmProvider = rows.length > 0;
        }
      } catch {
        llmProvider = false;
      }
    }

    let cronRunning = false;
    if (dbConnected) {
      try {
        const pool = dbConnection.getPool();
        if (pool) {
          const [rows] = await pool.execute(
            'SELECT id FROM cron_jobs WHERE enabled = TRUE LIMIT 1',
            [],
          ) as any;
          cronRunning = rows.length > 0;
        }
      } catch {
        cronRunning = false;
      }
    }

    let agentEngine = false;
    try {
      const wsUrl = process.env.AGENT_WS_URL || 'ws://127.0.0.1:28888/ws';
      const url = new URL(wsUrl);
      const host = url.hostname || '127.0.0.1';
      const port = parseInt(url.port || '28888', 10);

      agentEngine = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const timeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 2000);

        socket.connect(port, host, () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(true);
        });

        socket.on('error', () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(false);
        });
      });
    } catch {
      agentEngine = false;
    }

    return { db_connected: dbConnected, db_reachable: dbReachable, llm_provider: llmProvider, cron_running: cronRunning, agent_engine: agentEngine };
  }

  // ── Run all checks ───────────────────────────────────

  async runAllChecks(): Promise<ConsistencyResponse> {
    const checks: ConsistencyCheck[] = await Promise.all([
      this._checkSafe(() => this._checkInstanceCountMatch(), 'instance_count_match', '活跃实例数量', 'instance'),
      this._checkSafe(() => this._checkCapacitySumMatch(), 'capacity_sum_match', '容量数据一致性', 'capacity'),
      this._checkSafe(() => this._checkMetricsFreshness(), 'metrics_freshness', '指标采集新鲜度', 'metrics'),
      this._checkSafe(() => this._checkAlertRuleMetricRefs(), 'alert_rule_metric_refs', '告警规则指标引用', 'alert'),
      this._checkSafe(() => this._checkEventMemberStatusMatch(), 'event_member_status_match', '告警事件-成员状态一致', 'alert'),
      this._checkSafe(() => this._checkRbacOrphanRecords(), 'rbac_orphan_records', 'RBAC 悬空记录', 'rbac'),
      this._checkSafe(() => this._checkCronHungJobs(), 'cron_hung_jobs', '定时任务状态检查', 'cron'),
      this._checkSafe(() => this._checkChatSessionStats(), 'chat_session_stats', 'Chat 会话统计一致性', 'chat'),
      this._checkSafe(() => this._checkApprovalEventIntegrity(), 'approval_event_integrity', '审批事件完整性', 'approval'),
      this._checkSafe(() => this._checkNotificationDeferred(), 'notification_closure', '通知闭环完成性', 'notification'),
    ]);

    const pass = checks.filter(c => c.status === 'pass').length;
    const warn = checks.filter(c => c.status === 'warn').length;
    const fail = checks.filter(c => c.status === 'fail').length;
    const deferred = checks.filter(c => c.status === 'deferred').length;

    const readiness = await this._checkReadiness();

    return {
      timestamp: new Date().toISOString(),
      summary: { pass, warn, fail, deferred, total: checks.length },
      checks,
      readiness,
    };
  }
}

// ── Singleton ───────────────────────────────────────────

export const consistencyChecker = new ConsistencyChecker();
