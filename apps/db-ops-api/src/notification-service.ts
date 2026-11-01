import { dbConnection } from './db-connection.js';
import { enqueueNotificationTransition } from './notification-transition.js';
import { maintenanceBlocksDelivery } from './maintenance-notification.js';
/**
 * 通知推送服务
 * 每 10 秒轮询 alerts 表，发现未推送的告警，匹配通知渠道，格式化消息并发送
 */
import { setTimeout as delay } from 'node:timers/promises';
import { CronJob } from 'cron';
import * as crypto from 'crypto';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import nodemailer from 'nodemailer';
import { notificationDatabaseService } from './notification-database-service';
import type { PendingAlert, NotificationChannel } from './notification-database-service';
import { validateEmailChannelConfig } from './notification-channel-config.js';
import { decryptData } from './db-connection';
import { exchangeMicrosoftSmtpRefreshToken } from './smtp-oauth2.js';
import { signFeishuWebhookPayload } from './feishu-webhook.js';
import { resolveOutboundTarget, OutboundPolicyError } from './security/outbound-policy.js';
import { isAlertEligibleForChannel } from './workflows/notification-dispatch.js';

export function createPinnedLookup(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export class NotificationService {
  private pollingJob: CronJob | null = null;
  private running = false;
  private lastRun: Date | null = null;
  // 内存中已处理的告警 key（实例+等级+指标），防止短时间内重复推送
  private processedKeys = new Map<string, number>();
  private readonly STORM_WINDOW_MS = 5 * 60 * 1000; // 5 分钟

  /**
   * 启动轮询
   */
  start(): void {
    if (this.running) {
      console.log('⚠️ 通知推送服务已在运行中');
      return;
    }

    try {
      this.pollingJob = new CronJob(
        '*/10 * * * * *', // 每 10 秒
        async () => {
          try {
            await this.pollLoop();
            this.lastRun = new Date();
          } catch (error) {
            console.error('通知轮询失败:', error);
          }
        },
        null,
        true,
        'Asia/Shanghai'
      );

      this.running = true;
      console.log('✅ 通知推送任务已启动（每 10 秒）');
    } catch (error) {
      console.error('启动通知推送服务失败:', error);
      this.running = false;
    }
  }

  /**
   * 停止轮询
   */
  stop(): void {
    if (this.pollingJob) {
      this.pollingJob.stop();
      this.pollingJob = null;
      this.running = false;
      console.log('🛑 通知推送任务已停止');
    }
  }

  /**
   * 轮询循环
   */
  async pollLoop(): Promise<void> {
    try {
      const pendingAlerts = await notificationDatabaseService.getPendingAlerts();
      if (pendingAlerts.length === 0) {
        return;
      }

      console.log(`📬 发现 ${pendingAlerts.length} 条待推送告警`);

      const enabledChannels = await notificationDatabaseService.getEnabledChannels();
      if (enabledChannels.length === 0) {
        console.log('⚠️ 没有已启用的通知渠道');
        return;
      }

      for (const alert of pendingAlerts) {
        // 告警风暴保护：内存去重
        const stormKey = this.getStormKey(alert);
        const lastProcessed = this.processedKeys.get(stormKey);
        if (lastProcessed && Date.now() - lastProcessed < this.STORM_WINDOW_MS) {
          console.log(`⏭️ 跳过告警风暴: ${alert.title}`);
          continue;
        }

        // DB 层面去重检查
        const hasRecent = await notificationDatabaseService.hasRecentNotification(
          alert.instance_id,
          alert.level,
          alert.metric_name,
          5
        );
        if (hasRecent) {
          console.log(`⏭️ DB 去重跳过: ${alert.title}`);
          continue;
        }

        const matchedChannels = this.routeAlert(alert, enabledChannels);
        if (matchedChannels.length === 0) {
          console.log(`⚠️ 告警 ${alert.id} 没有匹配的渠道（level=${alert.level}）`);
          continue;
        }

        // Same durable maintenance decision as the workflow delivery path.
        if (await maintenanceBlocksDelivery(alert.id)) {
          await notificationDatabaseService.markAlertAsNotified(alert.id);
          continue;
        }

        for (const channel of matchedChannels) {
          if (!isAlertEligibleForChannel(alert, channel)) continue;
          const message = this.buildMessage(
            channel.type,
            alert,
            alert.instance_name,
            alert.instance_host
          );

          const result = await this.sendWithRetry(channel, message);
          if (result.success) {
            this.processedKeys.set(stormKey, Date.now());
            await notificationDatabaseService.recordNotification({
              alert_id: alert.id,
              channel_id: channel.id,
              status: 'sent',
              sent_at: new Date(),
            });
          } else {
            await notificationDatabaseService.recordNotification({
              alert_id: alert.id,
              channel_id: channel.id,
              status: 'failed',
              error: result.error || '未知错误',
            });
          }
        }
      }
    } catch (error) {
      console.error('轮询循环异常:', error);
    }
  }

  /** Sends one durable workflow delivery attempt. Failures intentionally
   * propagate to WorkerRuntime so its persistent retry/dead-letter policy owns recovery. */
  async deliverAlertToChannel(alert: PendingAlert, channel: NotificationChannel, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!channel.enabled) return;
    const message = this.buildMessage(channel.type, alert, alert.instance_name, alert.instance_host);
    const result = await this.send(channel, message, signal);
    if (!result.success) throw new Error(result.error || 'NOTIFICATION_DELIVERY_FAILED');
    signal?.throwIfAborted();
    const recorded = await notificationDatabaseService.recordNotification({
      alert_id: alert.id,
      channel_id: channel.id,
      status: 'sent',
      sent_at: new Date(),
    });
    if (!recorded.success) throw new Error(recorded.error || 'NOTIFICATION_AUDIT_WRITE_FAILED');
  }

  /**
   * 生成告警风暴 key
   */
  private getStormKey(alert: PendingAlert): string {
    return `${alert.instance_id ?? 'none'}:${alert.level}:${alert.metric_name ?? 'none'}`;
  }

  /**
   * 路由告警到匹配渠道
   * level 匹配规则：
   * - info → info
   * - warning → info, warning
   * - error → info, warning, error
   * - critical → info, warning, error, critical
   */
  routeAlert(alert: PendingAlert, channels: NotificationChannel[]): NotificationChannel[] {
    const levelOrder = ['info', 'warning', 'error', 'critical'];
    const alertLevelIndex = levelOrder.indexOf(alert.level);

    return channels.filter((ch) => {
      const channelSeverity = ch.config?.severity || 'info';
      const channelLevelIndex = levelOrder.indexOf(channelSeverity);

      // 渠道的 severity 级别要能覆盖 alert 的级别
      // 例如：渠道 severity=warning 能接收 warning/error/critical
      //      渠道 severity=info 能接收所有
      return channelLevelIndex <= alertLevelIndex;
    });
  }

  /**
   * 构建通知消息
   */
  buildMessage(
    channelType: string,
    alert: PendingAlert,
    instanceName?: string | null,
    instanceHost?: string | null
  ): any {
    const vars: Record<string, string> = {
      alert_id: String(alert.id),
      alert_title: alert.title,
      alert_level: alert.level,
      alert_type: alert.alert_type,
      instance_name: instanceName || '未知实例',
      instance_host: instanceHost || 'N/A',
      metric_name: alert.metric_name || 'N/A',
      metric_value: alert.metric_value || 'N/A',
      threshold: alert.threshold_value || 'N/A',
      created_at: alert.created_at instanceof Date
        ? alert.created_at.toISOString()
        : String(alert.created_at),
    };

    const replace = (template: string): string => {
      return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || `{${key}}`);
    };

    switch (channelType) {
      case 'dingtalk': {
        const title = `[${alert.level.toUpperCase()}] ${alert.title}`;
        const text = replace(
          `### [${alert.level.toUpperCase()}] ${alert.title}\n\n` +
          `- **实例**: ${instanceName || '未知实例'} (${instanceHost || 'N/A'})\n` +
          `- **类型**: ${alert.alert_type}\n` +
          `- **等级**: ${alert.level}\n` +
          `- **指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
          `- **阈值**: ${alert.threshold_value || 'N/A'}\n` +
          `- **时间**: {created_at}\n\n` +
          `${alert.message}`
        );
        return {
          msgtype: 'markdown',
          markdown: { title, text },
          at: { isAtAll: false },
        };
      }

      case 'wecom': {
        const content = replace(
          `### [${alert.level.toUpperCase()}] ${alert.title}\n\n` +
          `> **实例**: ${instanceName || '未知实例'}\n` +
          `> **主机**: ${instanceHost || 'N/A'}\n` +
          `> **类型**: ${alert.alert_type}\n` +
          `> **等级**: ${alert.level}\n` +
          `> **指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
          `> **阈值**: ${alert.threshold_value || 'N/A'}\n` +
          `> **时间**: {created_at}\n\n` +
          `${alert.message}`
        );
        return {
          msgtype: 'markdown',
          markdown: { content },
        };
      }

      case 'feishu': {
        const colorMap: Record<string, string> = {
          info: 'blue',
          warning: 'orange',
          error: 'red',
          critical: 'red',
        };
        return {
          msg_type: 'interactive',
          card: {
            header: {
              title: {
                tag: 'plain_text',
                content: `[${alert.level.toUpperCase()}] ${alert.title}`,
              },
              template: colorMap[alert.level] || 'blue',
            },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: replace(
                    `**实例**: ${instanceName || '未知实例'} (${instanceHost || 'N/A'})\n` +
                    `**类型**: ${alert.alert_type}\n` +
                    `**等级**: ${alert.level}\n` +
                    `**指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
                    `**阈值**: ${alert.threshold_value || 'N/A'}\n` +
                    `**时间**: {created_at}`
                  ),
                },
              },
              {
                tag: 'div',
                text: {
                  tag: 'plain_text',
                  content: alert.message,
                },
              },
            ],
          },
        };
      }

      case 'email':
        return {
          subject: `[${alert.level.toUpperCase()}] ${alert.title}`,
          text: replace(
            `告警等级: ${alert.level}\n` +
            `实例: ${instanceName || '未知实例'} (${instanceHost || 'N/A'})\n` +
            `类型: ${alert.alert_type}\n` +
            `指标: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
            `阈值: ${alert.threshold_value || 'N/A'}\n` +
            `时间: {created_at}\n\n` +
            `${alert.message}`
          ),
        };

      case 'webhook':
      default: {
        return {
          alert_id: alert.id,
          instance_name: instanceName || '未知实例',
          instance_host: instanceHost || 'N/A',
          alert_type: alert.alert_type,
          level: alert.level,
          title: alert.title,
          message: alert.message,
          metric_value: alert.metric_value,
          threshold_value: alert.threshold_value,
          created_at: alert.created_at instanceof Date
            ? alert.created_at.toISOString()
            : String(alert.created_at),
          url: `${instanceHost || 'N/A'}:${alert.id}`,
        };
      }
    }
  }

  /**
   * 构建带钉钉签名的 URL
   */
  private buildSignedUrl(webhookUrl: string, secret?: string): string {
    if (!secret) {
      return webhookUrl;
    }

    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
    const encodedSign = encodeURIComponent(sign);

    const separator = webhookUrl.includes('?') ? '&' : '?';
    return `${webhookUrl}${separator}timestamp=${timestamp}&sign=${encodedSign}`;
  }

  /**
   * 发送通知
   */
  async send(channel: NotificationChannel, message: any, signal?: AbortSignal, businessKey?: string, retryDeadline?: number): Promise<{ success: boolean; error?: string }> {
    signal?.throwIfAborted();
    if (channel.type === 'email') {
      if (!this.isValidEmailConfiguration(channel.config)) {
        return { success: false, error: 'EMAIL_CONFIGURATION_INVALID' };
      }
      try {
        if (businessKey) await this.sendEmail(channel.config, message, channel.id, signal, businessKey);
        else await this.sendEmail(channel.config, message, channel.id, ...(signal ? [signal] : []));
        signal?.throwIfAborted();
        return { success: true };
      } catch {
        signal?.throwIfAborted();
        return { success: false, error: 'EMAIL_DELIVERY_FAILED' };
      }
    }

    const webhookUrl = channel.config?.webhook_url;
    if (!webhookUrl) {
      return { success: false, error: '渠道未配置 webhook_url' };
    }

    try {
      const target = await resolveOutboundTarget(webhookUrl);
      signal?.throwIfAborted();
      const secret = this.getWebhookSecret(channel.config);
      const url = channel.type === 'dingtalk' ? this.buildSignedUrl(webhookUrl, secret) : webhookUrl;
      const payload = channel.type === 'feishu' && secret
        ? signFeishuWebhookPayload(message, secret)
        : message;
      if (retryDeadline !== undefined && Date.now() >= retryDeadline) throw new Error('DELIVERY_RETENTION_EXPIRED');
      const stableKey = channel.type === 'webhook' && channel.config.idempotency_contract === 'receiver-deduplicates' ? businessKey : undefined;
      const response = stableKey
        ? await this.postJsonToVerifiedTarget(url, target.addresses, payload, signal, stableKey)
        : await this.postJsonToVerifiedTarget(url, target.addresses, payload, ...(signal ? [signal] : []));

      signal?.throwIfAborted();
      if (response.statusCode >= 300 && response.statusCode < 400) {
        return { success: false, error: 'OUTBOUND_REDIRECT_DENIED' };
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { success: false, error: `OUTBOUND_HTTP_${response.statusCode}` };
      }

      let result: any = {};
      try { result = response.body ? JSON.parse(response.body) : {}; } catch { result = {}; }
      // 检查各平台的错误码
      if (result.errcode !== undefined && result.errcode !== 0) {
        return { success: false, error: result.errmsg || `平台错误码: ${result.errcode}` };
      }
      if (result.code !== undefined && result.code !== 0) {
        return { success: false, error: result.msg || `平台错误码: ${result.code}` };
      }

      return { success: true };
    } catch (error: any) {
      signal?.throwIfAborted();
      if (error instanceof OutboundPolicyError) return { success: false, error: error.reasonCode };
      return { success: false, error: 'OUTBOUND_REQUEST_FAILED' };
    }
  }

  private isValidEmailConfiguration(config: NotificationChannel['config']): boolean {
    return validateEmailChannelConfig(config).valid;
  }

  private async sendEmail(
    config: NotificationChannel['config'],
    message: { subject?: string; text?: string },
    channelId?: number,
    signal?: AbortSignal,
    businessKey?: string,
  ): Promise<void> {
    signal?.throwIfAborted();
    const port = Number(config.smtp_port);
    let auth: { user: string; pass: string } | { type: 'OAuth2'; user: string; accessToken: string };
    if (config.smtp_auth === 'oauth2') {
      const oauth = await exchangeMicrosoftSmtpRefreshToken({
          tenant: config.oauth2_tenant!,
          clientId: config.oauth2_client_id!,
          refreshToken: decryptData(config.oauth2_refresh_token_encrypted!),
      });
      signal?.throwIfAborted();
      if (oauth.refreshToken && channelId !== undefined) {
        const persisted = await notificationDatabaseService.updateOAuth2RefreshToken(channelId, oauth.refreshToken);
        if (!persisted.success) throw new Error('OAUTH_REFRESH_TOKEN_PERSIST_FAILED');
      }
      auth = { type: 'OAuth2', user: config.smtp_username!, accessToken: oauth.accessToken };
    } else {
      auth = { user: config.smtp_username!, pass: this.getSmtpPassword(config) };
    }
    signal?.throwIfAborted();
    const transport = nodemailer.createTransport({
      host: config.smtp_host!,
      port,
      secure: config.smtp_secure === true || port === 465,
      requireTLS: config.smtp_require_tls ?? port !== 465,
      auth,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
    try {
      signal?.throwIfAborted();
      await transport.sendMail({
        ...(businessKey ? { messageId: `<${crypto.createHash('sha256').update(businessKey).digest('hex')}@slide.local>` } : {}),
        from: config.from!,
        to: config.to!,
        subject: message.subject || '数据库运维助手通知',
        text: message.text || '',
      });
    } finally {
      transport.close();
    }
  }

  private getSmtpPassword(config: NotificationChannel['config']): string {
    if (config.password) return config.password;
    return decryptData(config.password_encrypted!);
  }

  private getWebhookSecret(config: NotificationChannel['config']): string | undefined {
    if (typeof config.secret_encrypted === 'string' && config.secret_encrypted.length > 0) {
      return decryptData(config.secret_encrypted);
    }
    return typeof config.secret === 'string' && config.secret.length > 0 ? config.secret : undefined;
  }

  /** Pin requests to validated DNS results while retaining TLS hostname verification. */
  private postJsonToVerifiedTarget(urlText: string, addresses: string[], message: unknown, signal?: AbortSignal, businessKey?: string): Promise<{ statusCode: number; body: string }> {
    signal?.throwIfAborted();
    const url = new URL(urlText);
    const payload = JSON.stringify(message);
    const address = addresses[0];
    return new Promise((resolve, reject) => {
      const request = https.request({
        signal,
        protocol: 'https:', hostname: url.hostname, port: 443,
        path: `${url.pathname}${url.search}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(businessKey ? { 'Idempotency-Key': businessKey } : {}) },
        servername: url.hostname, rejectUnauthorized: true,
        lookup: createPinnedLookup(address),
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
      });
      request.setTimeout(10_000, () => request.destroy(new Error('OUTBOUND_TIMEOUT')));
      request.once('error', reject);
      request.end(payload);
    });
  }

  /**
   * 带重试的发送，最多 3 次，指数退避
   * delay = 5000 * 3^(attempt-1) → 5s, 15s, 45s
   */
  async sendWithRetry(
    channel: NotificationChannel,
    message: any,
    attempt: number = 1,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }> {
    signal?.throwIfAborted();
    const maxAttempts = 3;

    try {
      const result = await this.send(channel, message, ...(signal ? [signal] : []));
      signal?.throwIfAborted();
      if (result.success) {
        return result;
      }

      if (attempt >= maxAttempts) {
        return { success: false, error: `重试 ${maxAttempts} 次后仍失败: ${result.error}` };
      }

      // 指数退避
      const delayMs = 5000 * Math.pow(3, attempt - 1);
      console.log(`⏳ 发送失败，${delayMs / 1000}s 后重试（第 ${attempt + 1} 次）: ${channel.name}`);
      await delay(delayMs, undefined, { signal });

      return this.sendWithRetry(channel, message, attempt + 1, signal);
    } catch (error: any) {
      signal?.throwIfAborted();
      if (attempt >= maxAttempts) {
        return { success: false, error: `重试 ${maxAttempts} 次后仍失败: ${error.message}` };
      }

      const delayMs = 5000 * Math.pow(3, attempt - 1);
      await delay(delayMs, undefined, { signal });

      return this.sendWithRetry(channel, message, attempt + 1, signal);
    }
  }

  /**
   * 发送升级通知到所有已启用的通知渠道
   * 兼容入口：只写入现有持久工作流，不直接调用外部传输
   */
  async sendEscalationNotification(alertId: number, fromLevel: string, toLevel: string): Promise<void> {
    const pool = dbConnection.getPool();
    if (!pool) throw Error('DELIVERY_STORE_UNAVAILABLE');
    const c = await pool.getConnection();
    try { await c.beginTransaction();
      await enqueueNotificationTransition(c,alertId,{id:`escalation-${toLevel}`,phase:'escalation',at:new Date().toISOString(),from_level:fromLevel,to_level:toLevel});
      await c.commit();
    } catch(e) { await c.rollback();throw e; } finally {c.release();}
  }

  /**
   * 构建审批通知消息
   */
  buildApprovalMessage(
    channelType: string,
    approvalData: {
      action: 'approve' | 'reject';
      notes?: string;
      sqlSummary: string;
      instanceName: string;
      submitTime: string;
      reviewerName: string;
      riskLevel: string;
    }
  ): any {
    const actionLabel = approvalData.action === 'approve' ? '已通过' : '已驳回';
    const title = `[审批${approvalData.action === 'approve' ? '通过' : '驳回'}] ${approvalData.instanceName}`;
    const summary = approvalData.sqlSummary.substring(0, 100);

    switch (channelType) {
      case 'dingtalk': {
        const text =
          `### ${title}\n\n` +
          `- **结果**: ${actionLabel}\n` +
          `- **审批人**: ${approvalData.reviewerName}\n` +
          `- **实例**: ${approvalData.instanceName}\n` +
          `- **风险等级**: ${approvalData.riskLevel}\n` +
          `- **提交时间**: ${approvalData.submitTime}\n` +
          (approvalData.notes ? `- **备注**: ${approvalData.notes}\n` : '') +
          `\n\`\`\`sql\n${summary}\n\`\`\``;
        return {
          msgtype: 'markdown',
          markdown: { title, text },
          at: { isAtAll: false },
        };
      }

      case 'wecom': {
        const content =
          `### ${title}\n\n` +
          `> **结果**: ${actionLabel}\n` +
          `> **审批人**: ${approvalData.reviewerName}\n` +
          `> **实例**: ${approvalData.instanceName}\n` +
          `> **风险等级**: ${approvalData.riskLevel}\n` +
          `> **提交时间**: ${approvalData.submitTime}\n` +
          (approvalData.notes ? `> **备注**: ${approvalData.notes}\n` : '') +
          `\n\`\`\`sql\n${summary}\n\`\`\``;
        return {
          msgtype: 'markdown',
          markdown: { content },
        };
      }

      case 'feishu': {
        const template = approvalData.action === 'approve' ? 'green' : 'red';
        const mdContent =
          `**实例**: ${approvalData.instanceName}\n` +
          `**结果**: ${actionLabel}\n` +
          `**审批人**: ${approvalData.reviewerName}\n` +
          `**风险等级**: ${approvalData.riskLevel}\n` +
          `**提交时间**: ${approvalData.submitTime}\n` +
          (approvalData.notes ? `**备注**: ${approvalData.notes}\n` : '');
        return {
          msg_type: 'interactive',
          card: {
            header: {
              title: { tag: 'plain_text', content: title },
              template,
            },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: mdContent } },
              { tag: 'hr' },
              { tag: 'note', elements: [{ tag: 'plain_text', content: summary }] },
            ],
          },
        };
      }

      case 'email':
        return {
          subject: title,
          text: `结果: ${actionLabel}\n` +
            `审批人: ${approvalData.reviewerName}\n` +
            `实例: ${approvalData.instanceName}\n` +
            `风险等级: ${approvalData.riskLevel}\n` +
            `提交时间: ${approvalData.submitTime}\n` +
            (approvalData.notes ? `备注: ${approvalData.notes}\n` : '') +
            `\nSQL 摘要:\n${summary}`,
        };

      case 'webhook':
      default: {
        return {
          type: 'approval',
          action: approvalData.action,
          instance_name: approvalData.instanceName,
          result: actionLabel,
          reviewer: approvalData.reviewerName,
          risk_level: approvalData.riskLevel,
          submit_time: approvalData.submitTime,
          notes: approvalData.notes || null,
          sql_summary: summary,
        };
      }
    }
  }

  /**
   * 获取服务状态
   */
  getStatus(): { running: boolean; lastRun: Date | null } {
    return {
      running: this.running,
      lastRun: this.lastRun,
    };
  }
}

// 单例
export const notificationService = new NotificationService();
