/**
 * 用户偏好服务
 *
 * 管理 user_preferences 表中 per-user UI 个性化配置的读写。
 * 遵循 scoring-config-service.ts 的模式（单例 + getPool + 默认值合并）。
 */
import mysql from 'mysql2/promise';
import { dbConnection } from './db-connection.js';

export interface UserPreferences {
  // Visual
  fontDensity: 'compact' | 'standard' | 'comfortable';
  sidebarPosition: 'left' | 'right';
  reduceAnimations: boolean;
  accentColor: string;
  borderRadius: number;

  // Layout
  defaultTab: string;
  visibleTabs: string[];
  navWidth: number;

  // Data display
  defaultPageSize: number;
  dateFormat: 'relative' | 'absolute';
  timezone: string;

  // Behavior
  autoRefreshEnabled: boolean;
  autoRefreshInterval: number;
  notificationEnabled: boolean;
  notifySeverity: string[];
  defaultModel: string;

  // Chat
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;

  // Theme
  theme: string;
  themeMode: string;
  locale: string;
  btnPalette?: Record<string, string>;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  fontDensity: 'standard',
  sidebarPosition: 'left',
  reduceAnimations: false,
  accentColor: '#409eff',
  borderRadius: 50,

  defaultTab: 'dashboard',
  visibleTabs: [],
  navWidth: 220,

  defaultPageSize: 50,
  dateFormat: 'absolute',
  timezone: '',

  autoRefreshEnabled: true,
  autoRefreshInterval: 30,
  notificationEnabled: true,
  notifySeverity: ['critical', 'warning'],
  defaultModel: '',

  chatFocusMode: false,
  chatShowThinking: true,
  chatShowToolCalls: true,

  theme: 'claw',
  themeMode: 'system',
  locale: '',
};

class UserPreferenceService {
  private getPool(): mysql.Pool | null {
    return dbConnection.getPool();
  }

  private isConnected(): boolean {
    return dbConnection.isConnected();
  }

  /**
   * 获取用户偏好
   *
   * 从 user_preferences 表读取已显式保存的值。
   *
   * @param userId - 用户ID
   * @returns 已保存的偏好对象；未保存或存储不可用时返回 null
   */
  async getPreferences(userId: number): Promise<Partial<UserPreferences> | null> {
    const pool = this.getPool();
    if (!pool) {
      return null;
    }

    try {
      const [rows] = (await pool.execute(
        `SELECT preferences FROM user_preferences WHERE user_id = ?`,
        [userId],
      )) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        const prefs = typeof rows[0].preferences === 'string'
          ? JSON.parse(rows[0].preferences)
          : rows[0].preferences;
        return prefs && typeof prefs === 'object' ? prefs : null;
      }

      return null;
    } catch (error) {
      console.error('获取用户偏好失败:', error);
      return null;
    }
  }

  /**
   * 保存用户偏好
   *
   * @param userId - 用户ID
   * @param preferences - 待保存的偏好（部分/完整均可，会与默认值合并后存储）
   * @returns 保存结果
   */
  async savePreferences(
    userId: number,
    preferences: Partial<UserPreferences>,
  ): Promise<{ success: boolean; error?: string }> {
    const pool = this.getPool();
    if (!pool) {
      return { success: false, error: '数据库未连接' };
    }

    try {
      // 先获取现有偏好，与新偏好合并
      const existing = await this.getPreferences(userId);
      const merged = { ...DEFAULT_PREFERENCES, ...(existing ?? {}), ...preferences };

      await pool.execute(
        `INSERT INTO user_preferences (user_id, preferences)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE preferences = VALUES(preferences)`,
        [userId, JSON.stringify(merged)],
      );
      return { success: true };
    } catch (error: any) {
      console.error('保存用户偏好失败:', error);
      return { success: false, error: error.message };
    }
  }
}

// 单例
export const userPreferenceService = new UserPreferenceService();
