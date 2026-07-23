import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { notificationDatabaseService } from '../../apps/db-ops-api/src/notification-database-service.js';
import { notificationService } from '../../apps/db-ops-api/src/notification-service.js';
import type { PendingAlert } from '../../apps/db-ops-api/src/notification-database-service.js';

const recipient = process.env.QUALIFICATION_SMTP_TO;
const password = process.env.QUALIFICATION_SMTP_PASSWORD;
if (!recipient || !password) throw new Error('email qualification credentials are required');

// The enclosing runner creates an isolated database. Never inherit the
// repository's intentionally invalid example key when testing credential-at-rest behavior.
process.env.ENCRYPTION_KEY = 'qualification-encryption-secret-2026-07-19-not-production';

if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
const pool = dbConnection.getPool();
if (!pool) throw new Error('qualification database pool unavailable');

const suffix = `${Date.now()}-${process.pid}`;
let alertId: number | undefined;
let channelId: number | undefined;

try {
  const [alertResult] = await pool.execute(
    `INSERT INTO alerts (alert_type, level, title, message, metric_name, metric_value, threshold_value)
     VALUES ('availability', 'critical', ?, ?, 'qualification_email_delivery', '1', '0')`,
    [`Qualification email delivery ${suffix}`, 'This is an authorized Slide notification-delivery qualification test.'],
  ) as any;
  alertId = Number(alertResult.insertId);

  const created = await notificationDatabaseService.createChannel({
    name: `Qualification SMTP ${suffix}`,
    type: 'email',
    enabled: true,
    config: {
      smtp_host: 'smtp-mail.outlook.com',
      smtp_port: 587,
      smtp_username: recipient,
      password,
      from: recipient,
      to: recipient,
      smtp_secure: false,
    },
  });
  if (!created.success || !created.channelId) throw new Error(`email channel creation failed: ${created.error ?? 'unknown error'}`);
  channelId = created.channelId;

  const [storedRows] = await pool.execute<Array<{ config: string }>>(
    'SELECT config FROM notification_channels WHERE id = ?', [channelId],
  );
  const storedConfig = typeof storedRows[0]?.config === 'string' ? JSON.parse(storedRows[0].config) : storedRows[0]?.config;
  if (!storedConfig?.password_encrypted || storedConfig.password) {
    throw new Error('SMTP credential was not encrypted before database storage');
  }

  const channel = await notificationDatabaseService.getChannelById(channelId);
  if (!channel) throw new Error('email channel readback failed');
  const alert: PendingAlert = {
    id: alertId,
    instance_id: null,
    alert_type: 'availability',
    level: 'critical',
    title: `Qualification email delivery ${suffix}`,
    message: 'This is an authorized Slide notification-delivery qualification test.',
    metric_name: 'qualification_email_delivery',
    metric_value: '1',
    threshold_value: '0',
    tags: null,
    created_at: new Date(),
    instance_name: null,
    instance_host: null,
  };

  await notificationService.deliverAlertToChannel(alert, channel);
  const [records] = await pool.execute<Array<{ status: string; sent_at: Date | null; error: string | null }>>(
    `SELECT status, sent_at, error FROM notification_records
     WHERE alert_id = ? AND channel_id = ? ORDER BY id DESC LIMIT 1`,
    [alertId, channelId],
  );
  const record = records[0];
  if (!record || record.status !== 'sent' || !record.sent_at || record.error) {
    throw new Error('successful SMTP delivery was not persisted as a sent notification record');
  }

  console.log(`email delivery invariant valid: alert=${alertId} channel=${channelId} status=${record.status} sent_at=${record.sent_at.toISOString()}`);
} finally {
  await dbConnection.close();
}
