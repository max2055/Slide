/**
 * 数据库日志采集服务
 * 通过 SQL 查询采集 MySQL/PostgreSQL 错误日志，支持模式检测和 AI 分析触发
 */
import { dbConnection } from './db-connection.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { llmService } from './llm-service.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import mysql from 'mysql2/promise';
import { projectDatabaseLogForModel } from './security/database-log-egress.js';

export interface DetectedPattern {
  pattern: string;
  severity: 'warning' | 'error' | 'critical';
  message: string;
}

export interface DatabaseLog {
  id: number;
  instance_id: number;
  log_level: 'info' | 'warning' | 'error' | 'critical';
  source: 'mysql_slow' | 'mysql_error' | 'pg_log' | 'other';
  message: string;
  raw_content: string;
  detected_patterns: DetectedPattern[] | null;
  collected_at: Date;
  created_at: Date;
}

interface PostgreSQLLogStats {
  xact_rollback: number;
  deadlocks: number;
  temp_files: number;
  blk_read_time: number;
  blk_write_time: number;
  stats_reset: string | null;
}

class DatabaseLogService {
  private lastCollectTime = new Map<number, Date>();
  private pgLastStats = new Map<number, Map<string, PostgreSQLLogStats>>();
  private mysqlCollecting = new Set<number>();

  /**
   * 获取系统数据库连接池
   */
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 主采集入口：遍历所有实例，采集错误日志
   */
  async collectLogs(): Promise<void> {
    const pool = this.getPool();
    if (!pool) {
      console.warn('[日志] 系统数据库未连接，跳过日志采集');
      return;
    }

    const instances = await instanceDatabaseService.getAllInstances();
    if (instances.length === 0) {
      return;
    }

    for (const instance of instances) {
      try {
        if (instance.db_type === 'mysql') {
          await this.collectMySQLErrorLogs(instance);
        } else if (instance.db_type === 'postgresql') {
          await this.collectPostgreSQLLogs(instance);
        }
      } catch (error) {
        console.error(`[日志] 采集实例 ${instance.name} 日志失败:`, error);
      }
    }
  }

  /**
   * MySQL 8.0.22+ error_log 的 LOGGED 是微秒级主键。
   * 用十进制字符串保留子毫秒顺序，并以已落库的连续前缀恢复水位。
   */
  private async collectMySQLErrorLogs(instance: any): Promise<void> {
    const conn = databaseService.getConnection(instance.id);
    if (!conn?.connected || !conn.pool || this.mysqlCollecting.has(instance.id)) return;

    this.mysqlCollecting.add(instance.id);
    const newLogs: DatabaseLog[] = [];
    try {
      const pool = this.getPool();
      if (!pool) throw new Error('系统数据库未连接');
      const [checkResult] = await (conn.pool as mysql.Pool).query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) as cnt FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = 'performance_schema' AND TABLE_NAME = 'error_log'`
      );
      if (!checkResult[0]?.cnt) {
        console.warn(`[日志] [${instance.name}] performance_schema.error_log 不可用，跳过`);
        return;
      }

      const [positions] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT MAX(source_position) AS position FROM database_logs
         WHERE instance_id = ? AND source = 'mysql_error'`, [instance.id]
      );
      const lastPosition = positions[0]?.position;
      // 正序且只推进已确认的行；超过 200 条的尾部留给下一轮，不跳到最新行。
      const [rows] = await (conn.pool as mysql.Pool).query<mysql.RowDataPacket[]>(
        `SELECT CAST(UNIX_TIMESTAMP(LOGGED) AS CHAR) AS source_position,
                ERROR_CODE AS ERROR_NUMBER, PRIO AS ERROR_SEVERITY, DATA AS ERROR_DATA
         FROM performance_schema.error_log
         ${lastPosition == null ? '' : 'WHERE LOGGED > FROM_UNIXTIME(CAST(? AS DECIMAL(20,6)))'}
         ORDER BY LOGGED ASC LIMIT 200`, lastPosition == null ? [] : [lastPosition]
      );
      for (const row of rows) {
        const position = row.source_position;
        if (typeof position !== 'string' || !/^\d{1,14}\.\d{6}$/.test(position)) {
          throw new Error('MySQL 日志源水位无效');
        }
        const message = row.ERROR_DATA ? String(row.ERROR_DATA).substring(0, 1000)
          : `[${row.ERROR_NUMBER}] ${row.ERROR_SEVERITY}`;
        const patterns = this.detectPatterns(message);
        const log: DatabaseLog = {
          id: 0, instance_id: instance.id, source: 'mysql_error',
          log_level: this.mapMySQLSeverity(row.ERROR_SEVERITY), message,
          raw_content: String(row.ERROR_DATA || '').substring(0, 5000),
          detected_patterns: patterns.length ? patterns : null,
          collected_at: new Date(Number(position) * 1000), created_at: new Date(),
        };
        if (await this.insertLog(log, position)) newLogs.push(log);
      }
    } finally {
      this.mysqlCollecting.delete(instance.id);
      // 只分析已确认新插入的行；失败行及幂等重取不产生分析。
      if (newLogs.length) {
        console.log(`[日志] [${instance.name}] 采集 ${newLogs.length} 条 MySQL 错误日志`);
        this.triggerLogAnalysis(newLogs, instance.id).catch((err) => {
          console.error(`[日志] [${instance.name}] AI 分析触发失败:`, err);
        });
      }
    }
  }

  /**
   * 采集 PostgreSQL 日志代理信号（pg_stat_database）
   * PostgreSQL 错误日志写入 OS 文件，不可通过 SQL 直接读取
   */
  private async collectPostgreSQLLogs(instance: any): Promise<void> {
    const conn = databaseService.getConnection(instance.id);
    if (!conn || !conn.connected || !conn.pgClient) {
      return;
    }

    const previousStats = this.pgLastStats.get(instance.id);

    try {
      const result = await conn.pgClient.query(`
        SELECT datname, xact_commit, xact_rollback, deadlocks,
               temp_files, temp_bytes, blk_read_time, blk_write_time, stats_reset
        FROM pg_stat_database
        WHERE datname NOT IN ('template0', 'template1')
      `);

      const newLogs: DatabaseLog[] = [];
      const statsCache = new Map<string, PostgreSQLLogStats>();

      for (const row of result.rows) {
        const rollbacks = Number(row.xact_rollback) || 0;
        const deadlocks = Number(row.deadlocks) || 0;
        const tempFiles = Number(row.temp_files) || 0;
        const blkReadTime = Number(row.blk_read_time) || 0;
        const blkWriteTime = Number(row.blk_write_time) || 0;

        const currentStats: PostgreSQLLogStats = {
          xact_rollback: rollbacks,
          deadlocks,
          temp_files: tempFiles,
          blk_read_time: blkReadTime,
          blk_write_time: blkWriteTime,
          stats_reset: row.stats_reset instanceof Date ? row.stats_reset.toISOString() : row.stats_reset ?? null,
        };
        statsCache.set(row.datname, currentStats);
        const previous = previousStats?.get(row.datname);
        // 新数据库、统计重置或任一计数回退：只建立新基线，不比较不同统计周期。
        if (!previous || previous.stats_reset !== currentStats.stats_reset ||
            rollbacks < previous.xact_rollback || deadlocks < previous.deadlocks ||
            tempFiles < previous.temp_files || blkReadTime < previous.blk_read_time ||
            blkWriteTime < previous.blk_write_time) {
          continue;
        }

        // 事务回滚异常
        if (rollbacks > 0) {
          const lastRollbacks = previous.xact_rollback;
          const delta = rollbacks - Number(lastRollbacks);
          if (delta > 10) {
            const msg = `[${row.datname}] 事务回滚异常增多：+${delta} 次`;
            const patterns = this.detectPatterns(msg);
            newLogs.push({
              id: 0,
              instance_id: instance.id,
              log_level: delta > 50 ? 'error' : 'warning',
              source: 'pg_log',
              message: msg,
              raw_content: JSON.stringify({ datname: row.datname, xact_rollback: rollbacks, delta }),
              detected_patterns: patterns.length > 0 ? patterns : [{ pattern: 'TRANSACTION_ROLLBACK', severity: 'warning', message: '事务回滚异常' }],
              collected_at: new Date(),
              created_at: new Date(),
            });
          }
        }

        // 死锁检测
        if (deadlocks > 0) {
          const lastDeadlocks = previous.deadlocks;
          const delta = deadlocks - Number(lastDeadlocks);
          if (delta > 0) {
            const msg = `[${row.datname}] 检测到死锁：+${delta}`;
            const patterns = this.detectPatterns(msg);
            newLogs.push({
              id: 0,
              instance_id: instance.id,
              log_level: 'warning',
              source: 'pg_log',
              message: msg,
              raw_content: JSON.stringify({ datname: row.datname, deadlocks, delta }),
              detected_patterns: patterns.length > 0 ? patterns : [{ pattern: 'DEADLOCK', severity: 'warning', message: '死锁检测' }],
              collected_at: new Date(),
              created_at: new Date(),
            });
          }
        }

        // 临时文件异常
        if (tempFiles > 100) {
          const lastTempFiles = previous.temp_files;
          const delta = tempFiles - Number(lastTempFiles);
          if (delta > 10) {
            const msg = `[${row.datname}] 临时文件使用异常：+${delta} 个`;
            const patterns = this.detectPatterns(msg);
            newLogs.push({
              id: 0,
              instance_id: instance.id,
              log_level: 'warning',
              source: 'pg_log',
              message: msg,
              raw_content: JSON.stringify({ datname: row.datname, temp_files: tempFiles, delta }),
              detected_patterns: patterns.length > 0 ? patterns : [{ pattern: 'TEMP_FILE_SPIKE', severity: 'warning', message: '临时文件使用异常' }],
              collected_at: new Date(),
              created_at: new Date(),
            });
          }
        }

        // I/O 延迟升高
        if (blkReadTime > 1000 || blkWriteTime > 1000) {
          const lastBlkRead = previous.blk_read_time;
          const deltaRead = blkReadTime - Number(lastBlkRead);
          if (deltaRead > 500) {
            const msg = `[${row.datname}] I/O 延迟升高：读 ${blkReadTime}ms`;
            const patterns = this.detectPatterns(msg);
            newLogs.push({
              id: 0,
              instance_id: instance.id,
              log_level: 'warning',
              source: 'pg_log',
              message: msg,
              raw_content: JSON.stringify({ datname: row.datname, blk_read_time: blkReadTime, delta: deltaRead }),
              detected_patterns: patterns.length > 0 ? patterns : [{ pattern: 'IO_LATENCY', severity: 'warning', message: 'I/O 延迟升高' }],
              collected_at: new Date(),
              created_at: new Date(),
            });
          }
        }
      }

      // 单条批量写入保证这一轮信号全部成功或全部失败；失败时保留旧基线。
      if (newLogs.length > 0) {
        const pool = this.getPool();
        if (!pool) throw new Error('系统数据库未连接');
        await pool.execute(
          `INSERT INTO database_logs
           (instance_id, log_level, source, message, raw_content, detected_patterns, collected_at)
           VALUES ${newLogs.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          newLogs.flatMap(log => [log.instance_id, log.log_level, log.source, log.message,
            log.raw_content, JSON.stringify(log.detected_patterns), log.collected_at])
        );
      }
      // 无异常的成功采集也推进时间与计数基线。
      this.pgLastStats.set(instance.id, statsCache);
      this.lastCollectTime.set(instance.id, new Date());

      if (newLogs.length > 0) {
        console.log(`[日志] [${instance.name}] 采集 ${newLogs.length} 条 PostgreSQL 异常信号`);

        // 触发 AI 分析（fire-and-forget）
        this.triggerLogAnalysis(newLogs, instance.id).catch((err) => {
          console.error(`[日志] [${instance.name}] AI 分析触发失败:`, err);
        });
      }
    } catch (error: any) {
      console.error(`[日志] [${instance.name}] PostgreSQL 日志采集异常:`, error.message);
    }
  }

  /**
   * 插入日志到系统数据库
   */
  private async insertLog(log: DatabaseLog, position: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool) throw new Error('系统数据库未连接');
    try {
      await pool.execute(
        `INSERT INTO database_logs
         (instance_id, log_level, source, message, raw_content, detected_patterns, collected_at, source_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [log.instance_id, log.log_level, log.source, log.message, log.raw_content,
          log.detected_patterns ? JSON.stringify(log.detected_patterns) : null, log.collected_at, position]
      );
      return true;
    } catch (error: any) {
      // 并发收集或写入回执丢失后重取：只接受同一源事件的已持久化记录。
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      const [existing] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM database_logs WHERE instance_id = ? AND source = ? AND source_position = ?`,
        [log.instance_id, log.source, position]
      );
      if (!existing.length) throw error;
      return false;
    }
  }

  /**
   * 映射 MySQL 错误级别到系统日志级别
   */
  private mapMySQLSeverity(severity: string | number): 'info' | 'warning' | 'error' | 'critical' {
    if (typeof severity === 'string') {
      const upper = severity.toUpperCase();
      if (upper.includes('CRIT') || upper.includes('FATAL') || upper.includes('EMERG')) return 'critical';
      if (upper.includes('ERROR') || upper.includes('ERR')) return 'error';
      if (upper.includes('WARN')) return 'warning';
      return 'info';
    }
    if (typeof severity === 'number') {
      if (severity >= 3) return 'critical';
      if (severity === 2) return 'error';
      if (severity === 1) return 'warning';
      return 'info';
    }
    return 'info';
  }

  /**
   * 预定义错误模式检测
   */
  detectPatterns(message: string): DetectedPattern[] {
    const results: DetectedPattern[] = [];
    const upper = message.toUpperCase();

    const patterns: Array<{ regex: RegExp; pattern: string; severity: 'warning' | 'error' | 'critical'; message: string }> = [
      { regex: /OUT\s+OF\s+MEMORY|OOM/, pattern: 'OUT_OF_MEMORY', severity: 'critical', message: '内存不足 (OOM)' },
      { regex: /DISK\s+FULL|NO\s+SPACE\s+LEFT/, pattern: 'DISK_FULL', severity: 'critical', message: '磁盘空间不足' },
      { regex: /TABLE.*FULL/, pattern: 'TABLE_FULL', severity: 'critical', message: '表空间已满' },
      { regex: /CONNECTION\s+REFUSED|CONNECTION\s+TIMEOUT/, pattern: 'CONNECTION_ERROR', severity: 'error', message: '连接被拒绝或超时' },
      { regex: /TOO\s+MANY\s+CONNECTIONS/, pattern: 'TOO_MANY_CONNECTIONS', severity: 'error', message: '连接数过多' },
      { regex: /REPLICATION.*(ERROR|STOPPED|BROKEN)/, pattern: 'REPLICATION_ERROR', severity: 'error', message: '复制异常' },
      { regex: /LOCK\s+WAIT\s+TIMEOUT/, pattern: 'LOCK_TIMEOUT', severity: 'warning', message: '锁等待超时' },
      { regex: /AUTHENTICATION\s+FAILURE/, pattern: 'AUTH_FAILURE', severity: 'warning', message: '认证失败' },
      { regex: /DEADLOCK/, pattern: 'DEADLOCK', severity: 'warning', message: '死锁检测' },
      { regex: /I\/O.*延迟|IO.*LATENCY|TEMP.*FILE.*异常/, pattern: 'IO_LATENCY', severity: 'warning', message: 'I/O 延迟升高' },
      { regex: /事务回滚.*异常|TRANSACTION.*ROLLBACK/, pattern: 'TRANSACTION_ROLLBACK', severity: 'warning', message: '事务回滚异常' },
    ];

    for (const p of patterns) {
      if (p.regex.test(upper) || p.regex.test(message)) {
        results.push({ pattern: p.pattern, severity: p.severity, message: p.message });
      }
    }

    return results;
  }

  /**
   * 触发日志 AI 分析
   */
  async triggerLogAnalysis(logs: DatabaseLog[], instanceId: number, existingAnalysisId?: number): Promise<void> {
    // 筛选 error 或 critical 级别日志
    const errorLogs = logs.filter((l) => l.log_level === 'error' || l.log_level === 'critical');
    if (errorLogs.length === 0) return;

    let analysisId: number;
    if (existingAnalysisId) {
      // 使用预创建的记录（手动分析）
      analysisId = existingAnalysisId;
    } else {
      // 创建 AI 分析记录（自动触发）
      const createResult = await aiAnalysisDatabaseService.createAnalysis({
        analysis_type: 'log_analysis',
        instance_id: instanceId,
        trigger_type: 'auto',
        ttl_minutes: 1440,
      });

      if (!createResult.success || !createResult.analysisId) {
        console.error('[日志] 创建 AI 分析记录失败');
        return;
      }
      analysisId = createResult.analysisId;
    }

    const startTime = Date.now();

    try {
      // 更新状态
      await aiAnalysisDatabaseService.updateStatus(analysisId, 'running');

      // 构建 prompt
      const logContent = errorLogs
        .slice(0, 20)
        .map((log) => {
          let line = `[${projectDatabaseLogForModel(log.log_level)}] [${projectDatabaseLogForModel(log.source)}] ${projectDatabaseLogForModel(log.message)}`;
          if (log.detected_patterns && log.detected_patterns.length > 0) {
            line += `\n  检测模式: ${log.detected_patterns.map((p) => `${projectDatabaseLogForModel(p.pattern)}(${projectDatabaseLogForModel(p.severity)})`).join(', ')}`;
          }
          // 外发仅使用诊断投影；原始日志在本地按现有审计策略保留。
          if (log.raw_content) {
            line += `\n  日志诊断投影: ${projectDatabaseLogForModel(log.raw_content, 500)}`;
          }
          return line;
        })
        .join('\n\n');

      const prompt = `请分析以下数据库错误日志，给出根因分析和处理建议：

## 错误日志（共 ${errorLogs.length} 条，展示前 20 条）

日志已执行保守脱敏：仅保留诊断词、标准错误码及 SQL 结构，标识符、字面量和自由文本已遮蔽。请勿猜测被遮蔽的值；信息不足时说明限制。

${logContent}

请从以下角度分析：
1. **根因分析**：错误的可能原因
2. **影响评估**：对业务的影响程度
3. **处理建议**：具体的修复步骤
4. **预防措施**：如何避免类似问题
5. **紧急程度**：是否需要立即处理`;

      const systemPrompt = `你是一位资深数据库专家（DBA），擅长分析数据库错误日志和故障排查。请用中文回复。请以结构化的方式给出分析结论，包含根因、影响、建议、预防措施。`;

      const llmResult = await llmService.chatWithTracking(
        [{ role: 'user', content: prompt }],
        {
          system: systemPrompt,
          purpose: 'log_analysis',
          sessionId: `log-analysis-${analysisId}`,
          instanceId,
          maxTokens: 4096,
        }
      );

      const duration_ms = Date.now() - startTime;

      if (llmResult.success && llmResult.content) {
        const usage = {
          input_tokens: llmResult.usage?.input_tokens || 0,
          output_tokens: llmResult.usage?.output_tokens || 0,
          cost_usd: llmResult.usage?.cost_usd || 0,
          provider: llmResult.provider || 'unknown',
          model: llmResult.model || 'unknown',
        };

        await aiAnalysisDatabaseService.completeAnalysis(analysisId, {
          result: {
            raw_content: llmResult.content,
            log_count: errorLogs.length,
            log_summary: errorLogs.slice(0, 5).map((l) => ({
              level: l.log_level,
              source: l.source,
              message: l.message,
            })),
            duration_ms: llmResult.duration_ms,
          },
          usage,
          duration_ms,
        });

        console.log(`[日志] AI 分析 #${analysisId} 完成 (${duration_ms}ms)`);
      } else {
        await aiAnalysisDatabaseService.failAnalysis(analysisId, llmResult.error || 'LLM 分析失败');
        console.error(`[日志] AI 分析 #${analysisId} 失败: ${llmResult.error}`);
      }
    } catch (error: any) {
      await aiAnalysisDatabaseService.failAnalysis(analysisId, error.message);
      console.error(`[日志] AI 分析 #${analysisId} 异常:`, error.message);
    }
  }

  /**
   * 查询日志列表（按实例/时间/级别过滤）
   */
  async getLogs(instanceId: number, options?: {
    level?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
    offset?: number;
    strict?: boolean;
  }): Promise<{ logs: DatabaseLog[]; total: number }> {
    const pool = this.getPool();
    if (!pool) {
      if (options?.strict) throw new Error('LOGS_UNAVAILABLE');
      return { logs: [], total: 0 };
    }

    try {
      let where = 'WHERE instance_id = ?';
      const params: any[] = [instanceId];

      if (options?.level) {
        where += ' AND log_level = ?';
        params.push(options.level);
      }
      if (options?.startTime) {
        where += ' AND collected_at >= ?';
        params.push(options.startTime);
      }
      if (options?.endTime) {
        where += ' AND collected_at <= ?';
        params.push(options.endTime);
      }

      // 获取总数
      const [countRows] = await pool.execute(
        `SELECT COUNT(*) as cnt FROM database_logs ${where}`,
        params
      ) as any;
      const total = countRows[0]?.cnt || 0;

      // 获取数据
      let sql = `
        SELECT id, instance_id, log_level, source, message, raw_content,
               detected_patterns, collected_at, created_at
        FROM database_logs ${where}
        ORDER BY collected_at DESC
      `;

      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const [rows] = await pool.execute(sql, params) as any;

      const logs = rows.map((row: any) => this.parseRow(row));
      return { logs, total };
    } catch (error) {
      console.error('[日志] 查询日志列表失败:', error);
      if (options?.strict) throw new Error('LOGS_QUERY_FAILED', { cause: error });
      return { logs: [], total: 0 };
    }
  }

  /**
   * 获取日志统计
   */
  async getLogsStats(instanceId: number, hours: number = 24): Promise<any> {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);

      // 总数 + 按级别统计
      const [levelRows] = await pool.execute(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN log_level = 'info' THEN 1 ELSE 0 END) as info,
          SUM(CASE WHEN log_level = 'warning' THEN 1 ELSE 0 END) as warning,
          SUM(CASE WHEN log_level = 'error' THEN 1 ELSE 0 END) as error,
          SUM(CASE WHEN log_level = 'critical' THEN 1 ELSE 0 END) as critical
         FROM database_logs
         WHERE instance_id = ? AND collected_at >= ?`,
        [instanceId, since]
      ) as any;

      const total = levelRows[0]?.total || 0;
      const byLevel = {
        info: levelRows[0]?.info || 0,
        warning: levelRows[0]?.warning || 0,
        error: levelRows[0]?.error || 0,
        critical: levelRows[0]?.critical || 0,
      };

      // 按模式统计
      const [patternRows] = await pool.execute(
        `SELECT detected_patterns FROM database_logs
         WHERE instance_id = ? AND collected_at >= ? AND detected_patterns IS NOT NULL`,
        [instanceId, since]
      ) as any;

      const patternCount: Record<string, number> = {};
      for (const row of patternRows) {
        if (row.detected_patterns) {
          try {
            const patterns = typeof row.detected_patterns === 'string'
              ? JSON.parse(row.detected_patterns)
              : row.detected_patterns;
            if (Array.isArray(patterns)) {
              for (const p of patterns) {
                patternCount[p.pattern] = (patternCount[p.pattern] || 0) + 1;
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      }
      const byPattern = Object.entries(patternCount)
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      // 按小时趋势
      const [trendRows] = await pool.execute(
        `SELECT DATE_FORMAT(collected_at, '%Y-%m-%d %H:00:00') as time_slot,
                COUNT(*) as cnt
         FROM database_logs
         WHERE instance_id = ? AND collected_at >= ?
         GROUP BY time_slot
         ORDER BY time_slot ASC`,
        [instanceId, since]
      ) as any;

      const trend = trendRows.map((r: any) => ({
        time: r.time_slot,
        count: Number(r.cnt),
      }));

      return { total, by_level: byLevel, by_pattern: byPattern, trend };
    } catch (error) {
      console.error('[日志] 获取日志统计失败:', error);
      return null;
    }
  }

  /**
   * 解析行数据，处理 JSON 字段
   */
  private parseRow(row: any): DatabaseLog {
    if (row.detected_patterns && typeof row.detected_patterns === 'string') {
      try {
        row.detected_patterns = JSON.parse(row.detected_patterns);
      } catch {
        row.detected_patterns = null;
      }
    }
    return row as DatabaseLog;
  }
}

// 单例
export const databaseLogService = new DatabaseLogService();
