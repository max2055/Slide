/**
 * 告警升级服务
 * 每 5 分钟自动检查未处理告警并升级等级（warning→error→critical→p0）
 * 支持手动升级和升级规则 CRUD。
 */
import mysql from 'mysql2/promise';
import { ALERT_LEVELS } from './alert-levels.js';
import { CronJob } from 'cron';
import { dbConnection } from './db-connection';
import { alertDatabaseService } from './alert-database-service';
import { enqueueNotificationTransition } from './notification-transition.js';
import { actorContextService, ActorAuthenticationError, type ActorContext } from './auth/actor-context.js';
import { canManageResource } from './resources/resource-service.js';

interface EscalationRule {
  id: number;
  name: string;
  from_level: string;
  to_level: string;
  trigger_condition: string;
  trigger_value: number;
  enabled: boolean;
}

class AlertEscalationService {
  private escalationJob: CronJob | null = null;
  private running = false;
  private lastRun: Date | null = null;
  private escalatedCount = 0;

  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  /**
   * 启动自动升级 CronJob（每 5 分钟）
   */
  start(): void {
    if (this.running) return;

    this.escalationJob = new CronJob(
      '0 */5 * * * *',
      async () => {
        try {
          const result = await this.checkEscalations();
          this.lastRun = new Date();
          this.escalatedCount += result.escalated;
          if (result.escalated > 0) {
            console.log(`🔺 自动升级: ${result.escalated} 条告警已升级`);
          }
        } catch (error) {
          console.error('告警升级失败:', error);
        }
      },
      null,
      true,
      'Asia/Shanghai', undefined, false, undefined, false, true
    );

    this.running = true;
    console.log('✅ 告警升级任务已启动（每 5 分钟）');
  }

  async stop(): Promise<void> {
    if (this.escalationJob) {
      const job = this.escalationJob;
      this.escalationJob = null;
      this.running = false;
      await job.stop();
      console.log('🛑 告警升级任务已停止');
    }
  }

  getStatus(): { running: boolean; lastRun: Date | null; escalatedCount: number } {
    return { running: this.running, lastRun: this.lastRun, escalatedCount: this.escalatedCount };
  }

  /**
   * 检查并执行自动升级
   */
  async checkEscalations(): Promise<{ escalated: number }> {
    const pool = this.getPool();
    if (!pool) return { escalated: 0 };

    const rules = await this.getEscalationRules(true);
    let totalEscalated = 0;

    for (const rule of rules) {
      const minutes = rule.trigger_value;
      // 查询需要升级的告警：等级匹配且超过指定时间未处理
      const [alerts] = await pool.execute(
        `SELECT id, level FROM alerts
         WHERE status IN ('unread', 'read', 'acknowledged')
           AND level = ?
           AND created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
           AND id NOT IN (
             SELECT alert_id FROM alert_event_logs
             WHERE action = 'escalated'
               AND JSON_EXTRACT(details, '$.from_level') = ?
               AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
           )`,
        [rule.from_level, minutes, rule.from_level, minutes]
      ) as any;

      if (!Array.isArray(alerts) || alerts.length === 0) continue;

      for (const alert of alerts) {
        try {
          const result = await this.transition(alert.id,rule.to_level,undefined,rule.from_level,rule.id);
          if (result.changed) totalEscalated++;
        } catch (error) {
          console.error(`升级告警 ${alert.id} 失败:`, error);
        }
      }
    }

    return { escalated: totalEscalated };
  }

  /**
   * 手动升级指定告警
   */
  async manualEscalation(alertId:number,newLevel:string,actor?:ActorContext):Promise<{success:boolean;error?:string;changed?:boolean}> {
    try { return {success:true,...await this.transition(alertId,newLevel,actor)}; }
    catch(e) {return {success:false,error:e instanceof ActorAuthenticationError?'ESCALATION_AUTH':e instanceof Error&&e.message.startsWith('ESCALATION_')?e.message:'ESCALATION_STATE_UNKNOWN'};}
  }
  private async transition(alertId:number,newLevel:string,actor?:ActorContext,expected?:string,ruleId?:number){
    const levels=ALERT_LEVELS;
    if(!levels.includes(newLevel))throw Error('ESCALATION_LEVEL');
    const pool=this.getPool();if(!pool)throw Error('ESCALATION_UNAVAILABLE');
    const c=await pool.getConnection();let reusable=false;
    try{
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
      const [rows]=await c.execute<any[]>('SELECT * FROM alerts WHERE id=? FOR UPDATE',[alertId]);
      if(!rows.length)throw Error('ESCALATION_NOT_FOUND');const a=rows[0];
      if(!levels.includes(a.level))throw Error('ESCALATION_LEVEL');
      const authorize=async(lock=false)=>{
        if(!actor)return;const live=await actorContextService.revalidateActorOn(c as any,actor,actor.requestId,lock);
        const ref=a.instance_id?{type:'instance' as const,id:Number(a.instance_id)}:a.server_id?{type:'server' as const,id:Number(a.server_id)}:a.network_device_id?{type:'network_device' as const,id:Number(a.network_device_id)}:null;
        if(!(live.permissions.includes('*')||live.permissions.includes('alert:manage'))||!ref||!canManageResource(live,ref))throw Error('ESCALATION_FORBIDDEN');
      };
      await authorize();
      const changed=(!expected||a.level===expected)&&!['resolved','closed'].includes(a.status)&&a.level!==newLevel;
      if(changed){
        if(levels.indexOf(newLevel)<=levels.indexOf(a.level))throw Error('ESCALATION_DIRECTION');
        await c.execute('UPDATE alerts SET level=? WHERE id=?',[newLevel,alertId]);
        await c.execute("INSERT INTO alert_event_logs(alert_id,action,actor_id,details) VALUES(?,'escalated',?,?)",[alertId,actor?.userId??null,JSON.stringify({from_level:a.level,to_level:newLevel,rule_id:ruleId??null,auto_escalated:!actor})]);
        await enqueueNotificationTransition(c,alertId,{id:`escalation-${newLevel}`,phase:'escalation',at:new Date().toISOString(),from_level:a.level,to_level:newLevel});
      }
      await authorize(true);await c.commit();reusable=true;return {changed};
    }catch(e){try{await c.rollback();reusable=true;}catch{}throw e;}finally{if(reusable)c.release();else c.destroy();}
  }

  async getEscalationRules(enabled?: boolean): Promise<EscalationRule[]> {
    const pool = this.getPool();
    if (!pool) return [];

    try {
      let sql = 'SELECT id, name, from_level, to_level, trigger_condition, trigger_value, enabled FROM escalation_rules';
      const params: any[] = [];
      if (enabled !== undefined) {
        sql += ' WHERE enabled = ?';
        params.push(enabled ? 1 : 0);
      }
      sql += ' ORDER BY id';

      const [rows] = await pool.execute(sql, params) as any;
      return rows.map((r: any) => ({ ...r, enabled: Boolean(r.enabled) }));
    } catch (error) {
      console.error('获取升级规则失败:', error);
      return [];
    }
  }

  async createEscalationRule(data: {
    name: string;
    from_level: string;
    to_level: string;
    trigger_condition: string;
    trigger_value: number;
    enabled?: boolean;
  }): Promise<{ success: boolean; ruleId?: number; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute(
        `INSERT INTO escalation_rules (name, from_level, to_level, trigger_condition, trigger_value, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [data.name, data.from_level, data.to_level, data.trigger_condition, data.trigger_value, data.enabled !== false ? 1 : 0]
      ) as any;
      return { success: true, ruleId: result.insertId };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async updateEscalationRule(ruleId: number, data: {
    name?: string;
    from_level?: string;
    to_level?: string;
    trigger_condition?: string;
    trigger_value?: number;
    enabled?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const updates: string[] = [];
      const values: any[] = [];
      if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
      if (data.from_level !== undefined) { updates.push('from_level = ?'); values.push(data.from_level); }
      if (data.to_level !== undefined) { updates.push('to_level = ?'); values.push(data.to_level); }
      if (data.trigger_condition !== undefined) { updates.push('trigger_condition = ?'); values.push(data.trigger_condition); }
      if (data.trigger_value !== undefined) { updates.push('trigger_value = ?'); values.push(data.trigger_value); }
      if (data.enabled !== undefined) { updates.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }

      if (updates.length === 0) return { success: true };
      values.push(ruleId);

      const [result] = await pool.execute(`UPDATE escalation_rules SET ${updates.join(', ')} WHERE id = ?`, values) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '升级规则不存在' };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async deleteEscalationRule(ruleId: number): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    try {
      const [result] = await pool.execute('DELETE FROM escalation_rules WHERE id = ?', [ruleId]) as any;
      if (result.affectedRows === 0) {
        return { success: false, error: '升级规则不存在' };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async createDefaultRules(): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    try {
      const [rows] = await pool.execute('SELECT COUNT(*) as cnt FROM escalation_rules') as any;
      if (rows[0].cnt > 0) return;

      await pool.execute(
        `INSERT INTO escalation_rules (name, from_level, to_level, trigger_condition, trigger_value, enabled) VALUES
         ('Warning → Error (30min)', 'warning', 'error', 'timeout_minutes', 30, 1),
         ('Error → Critical (30min)', 'error', 'critical', 'timeout_minutes', 30, 1),
         ('Critical → P0 (60min)', 'critical', 'p0', 'timeout_minutes', 60, 1)`
      );
      console.log('✅ 已创建 3 条默认升级规则');
    } catch (error) {
      console.error('创建默认升级规则失败:', error);
    }
  }
}

export const alertEscalationService = new AlertEscalationService();
