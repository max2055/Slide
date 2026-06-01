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

class DatabaseLogService {
  private lastCollectTime = new Map<number, Date>();
  private pgLastStats = new Map<number, Record<string, any>>();

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
   * 采集 MySQL 错误日志（performance_schema.log_error）
   */
  private async collectMySQLErrorLogs(instance: any): Promise<void> {
    const conn = databaseService.getConnection(instance.id);
    if (!conn || !conn.connected || !conn.pool) {
      return;
    }

    const lastTime = this.lastCollectTime.get(instance.id);

    try {
      // 检查 performance_schema.log_error 是否可用
      const [checkResult] = await (conn.pool as any).query(
        `SELECT COUNT(*) as cnt FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = 'performance_schema' AND TABLE_NAME = 'log_error'`
      );
      const tableExists = checkResult[0]?.cnt > 0;
      if (!tableExists) {
        console.warn(`[日志] [${instance.name}] performance_schema.log_error 不可用，跳过`);
        return;
      }

      // 采集新日志
      let query = `
        SELECT LOGGED, ERROR_NUMBER, ERROR_SEVERITY, ERROR_DATA
        FROM performance_schema.log_error
        ORDER BY LOGGED DESC
        LIMIT 200
      `;
      const params: any[] = [];

      if (lastTime) {
        query = `
          SELECT LOGGED, ERROR_NUMBER, ERROR_SEVERITY, ERROR_DATA
          FROM performance_schema.log_error
          WHERE LOGGED > ?
          ORDER BY LOGGED DESC
          LIMIT 200
        `;
        params.push(lastTime);
      }

      const [rows] = await (conn.pool as any).query(query, params);
      if (!Array.isArray(rows) || rows.length === 0) {
        return;
      }

      // 存储到系统数据库
      let count = 0;
      for (const row of rows) {
        const logLevel = this.mapMySQLSeverity(row.ERROR_SEVERITY);
        const message = row.ERROR_DATA
          ? String(row.ERROR_DATA).substring(0, 2000)
          : `[${row.ERROR_NUMBER}] ${row.ERROR_SEVERITY}`;
        const patterns = this.detectPatterns(message);
        const collectedAt = row.LOGGED instanceof Date ? row.LOGGED : new Date(row.LOGGED);

        await this.insertLog({
          instance_id: instance.id,
          log_level: logLevel,
          source: 'mysql_error',
          message: message.substring(0, 1000),
          raw_content: String(row.ERROR_DATA || '').substring(0, 5000),
          detected_patterns: patterns.length > 0 ? patterns : null,
          collected_at: collectedAt,
        });
        count++;
      }

      this.lastCollectTime.set(instance.id, new Date());
      console.log(`[日志] [${instance.name}] 采集 ${count} 条 MySQL 错误日志`);

      // 触发 AI 分析（fire-and-forget）
      if (count > 0) {
        const newLogs = rows.slice(0, 20).map((row: any) => ({
          id: 0,
          instance_id: instance.id,
          log_level: this.mapMySQLSeverity(row.ERROR_SEVERITY),
          source: 'mysql_error' as const,
          message: (row.ERROR_DATA ? String(row.ERROR_DATA).substring(0, 1000) : `[${row.ERROR_NUMBER}] ${row.ERROR_SEVERITY}`),
          raw_content: row.ERROR_DATA ? String(row.ERROR_DATA).substring(0, 5000) : '',
          detected_patterns: null as DetectedPattern[] | null,
          collected_at: row.LOGGED instanceof Date ? row.LOGGED : new Date(row.LOGGED),
          created_at: new Date(),
        }));
        this.triggerLogAnalysis(newLogs, instance.id).catch((err) => {
          console.error(`[日志] [${instance.name}] AI 分析触发失败:`, err);
        });
      }
    } catch (error: any) {
      console.error(`[日志] [${instance.name}] MySQL 错误日志采集异常:`, error.message);
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

    const lastTime = this.lastCollectTime.get(instance.id);
    const isFirstCollection = !lastTime;

    try {
      const result = await conn.pgClient.query(`
        SELECT datname, xact_commit, xact_rollback, deadlocks,
               temp_files, temp_bytes, blk_read_time, blk_write_time
        FROM pg_stat_database
        WHERE datname NOT IN ('template0', 'template1')
      `);

      const newLogs: DatabaseLog[] = [];

      for (const row of result.rows) {
        const rollbacks = Number(row.xact_rollback) || 0;
        const deadlocks = Number(row.deadlocks) || 0;
        const tempFiles = Number(row.temp_files) || 0;
        const blkReadTime = Number(row.blk_read_time) || 0;
        const blkWriteTime = Number(row.blk_write_time) || 0;

        // 事务回滚异常
        if (rollbacks > 0 && !isFirstCollection) {
          const lastRollbacks = lastTime ? this.pgLastStats.get(instance.id)?.[row.datname]?.xact_rollback || 0 : 0;
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
        if (deadlocks > 0 && !isFirstCollection) {
          const lastDeadlocks = lastTime ? this.pgLastStats.get(instance.id)?.[row.datname]?.deadlocks || 0 : 0;
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
        if (tempFiles > 100 && !isFirstCollection) {
          const lastTempFiles = lastTime ? this.pgLastStats.get(instance.id)?.[row.datname]?.temp_files || 0 : 0;
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
        if ((blkReadTime > 1000 || blkWriteTime > 1000) && !isFirstCollection) {
          const lastBlkRead = lastTime ? this.pgLastStats.get(instance.id)?.[row.datname]?.blk_read_time || 0 : 0;
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

      // 更新缓存统计
      const statsCache: Record<string, any> = {};
      for (const row of result.rows) {
        statsCache[row.datname] = {
          xact_rollback: row.xact_rollback,
          deadlocks: row.deadlocks,
          temp_files: row.temp_files,
          blk_read_time: row.blk_read_time,
        };
      }
      this.pgLastStats.set(instance.id, statsCache);

      // 存储日志
      if (newLogs.length > 0) {
        for (const log of newLogs) {
          await this.insertLog(log);
        }
        this.lastCollectTime.set(instance.id, new Date());
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
  private async insertLog(log: {
    instance_id: number;
    log_level: string;
    source: string;
    message: string;
    raw_content: string;
    detected_patterns: DetectedPattern[] | null;
    collected_at: Date;
  }): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    try {
      await pool.execute(
        `INSERT INTO database_logs
         (instance_id, log_level, source, message, raw_content, detected_patterns, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          log.instance_id,
          log.log_level,
          log.source,
          log.message,
          log.raw_content,
          log.detected_patterns ? JSON.stringify(log.detected_patterns) : null,
          log.collected_at,
        ]
      );
    } catch (error) {
      console.error('[日志] 插入日志记录失败:', error);
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
          let line = `[${log.log_level}] [${log.source}] ${log.message}`;
          if (log.detected_patterns && log.detected_patterns.length > 0) {
            line += `\n  检测模式: ${log.detected_patterns.map((p) => `${p.pattern}(${p.severity})`).join(', ')}`;
          }
          // 脱敏：只截取 raw_content 前 500 字符
          if (log.raw_content) {
            line += `\n  原始内容: ${log.raw_content.substring(0, 500)}`;
          }
          return line;
        })
        .join('\n\n');

      const prompt = `请分析以下数据库错误日志，给出根因分析和处理建议：

## 错误日志（共 ${errorLogs.length} 条，展示前 20 条）

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
  }): Promise<{ logs: DatabaseLog[]; total: number }> {
    const pool = this.getPool();
    if (!pool) return { logs: [], total: 0 };

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
