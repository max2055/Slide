/**
 * Slide - Database Operations API
 */
import apiClient from './index.js';

// 数据库实例管理
export const databaseAPI = {
  // 获取实例列表
  getInstances(params?: { page?: number; limit?: number; status?: string }) {
    return apiClient.get<DatabaseInstanceListResponse>('/database/instances', { params });
  },

  // 获取实例详情
  getInstance(id: string) {
    return apiClient.get<{ instance: DatabaseInstance }>(`/database/instances/${id}`);
  },

  // 创建实例
  createInstance(data: CreateDatabaseInstanceRequest) {
    return apiClient.post<DatabaseInstance>('/database/instances', data);
  },

  // 更新实例
  updateInstance(id: string, data: UpdateDatabaseInstanceRequest) {
    return apiClient.put<DatabaseInstance>(`/database/instances/${id}`, data);
  },

  // 删除实例
  deleteInstance(id: string) {
    return apiClient.delete<{ id: string }>(`/database/instances/${id}`);
  },

  // 测试连接
  testConnection(id: string | 'new', data?: {
    name?: string;
    db_type?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  }) {
    if (id === 'new' && data) {
      // 测试新连接（实例尚未保存）
      return apiClient.post<{ success: boolean; message: string }>(
        '/database/instances/test-connection', data
      );
    }
    // 测试已有实例的连接 - 使用 GET 方法
    return apiClient.get<{ success: boolean; message: string }>(
      `/database/instances/${id}/test-connection`
    );
  },

  // 获取实例监控指标
  getMetrics(id: string, params?: { startTime?: string; endTime?: string; metrics?: string[] }) {
    return apiClient.get<MetricsResponse>(`/database/instances/${id}/metrics`, { params: params as any });
  },
};

// 健康检查
export const healthAPI = {
  // 执行健康检查
  checkHealth(instanceId: string) {
    return apiClient.get<HealthCheckResult>(`/database/${instanceId}/health`);
  },

  // 获取健康评分历史
  getHealthHistory(
    instanceId: string,
    params?: { days?: number; startDate?: string; endDate?: string }
  ) {
    return apiClient.get<HealthHistoryResponse>(`/health/${instanceId}/history`, { params });
  },
};

// 慢查询分析
export const slowQueryAPI = {
  // 获取慢查询列表
  getSlowQueries(
    instanceId: string,
    params?: { limit?: number; offset?: number; minTime?: number }
  ) {
    return apiClient.get<SlowQueryListResponse>(
      `/database/instances/${instanceId}/slow-queries`,
      { params }
    );
  },

  // 分析慢查询
  analyzeSlowQuery(instanceId: string, data: { sql: string; explain?: boolean }) {
    return apiClient.post<SlowQueryAnalysis>(
      `/database/instances/${instanceId}/slow-queries/analyze`,
      data
    );
  },

  // 获取执行计划
  getExplainPlan(instanceId: string, sql: string) {
    return apiClient.post<ExplainPlanResponse>(`/database/instances/${instanceId}/explain`, {
      sql,
    });
  },
};

// 故障诊断
export const faultAPI = {
  // 诊断故障
  diagnose(instanceId: string, faultType: string) {
    return apiClient.post<FaultDiagnosisResult>('/fault/diagnose', {
      instance_id: instanceId,
      fault_type: faultType,
    });
  },

  // 自动修复
  autoHeal(instanceId: string, faultType: string, params?: Record<string, unknown>) {
    return apiClient.post<FaultHealResult>('/fault/heal', {
      instance_id: instanceId,
      fault_type: faultType,
      ...params,
    });
  },

  // 获取故障历史
  getFaultHistory(instanceId: string, params?: { limit?: number; offset?: number }) {
    return apiClient.get<FaultHistoryResponse>(`/fault/${instanceId}/history`, { params });
  },
};

// 监控
export const monitorAPI = {
  // 获取实时监控数据
  getRealtimeMetrics(instanceId: string) {
    return apiClient.get<RealtimeMetricsResponse>(`/monitor/${instanceId}/realtime`);
  },

  // 获取历史趋势
  getHistoryMetrics(
    instanceId: string,
    params?: {
      startTime?: string;
      endTime?: string;
      metrics?: string[];
      interval?: string;
    }
  ) {
    return apiClient.get<HistoryMetricsResponse>(`/monitor/${instanceId}/history`, { params: params as any });
  },
};

// 报表
export const reportAPI = {
  // 生成报表
  generateReport(type: string, params?: Record<string, unknown>) {
    return apiClient.post<ReportResult>(`/reports/${type}`, params);
  },

  // 获取报表列表
  getReportList(params?: { page?: number; limit?: number; type?: string }) {
    return apiClient.get<ReportListResponse>('/reports', { params });
  },

  // 下载报表
  downloadReport(id: string) {
    return apiClient.get<Blob>(`/reports/${id}/download`, {
      responseType: 'blob',
    } as unknown as RequestInit);
  },
};

// 告警管理
export const alertAPI = {
  // 获取告警列表
  getAlertList(params?: {
    page?: number;
    limit?: number;
    level?: string;
    status?: string;
    instanceId?: string;
  }) {
    return apiClient.get<AlertListResponse>('/alerts', { params });
  },

  // 获取未读告警数
  getUnreadCount() {
    return apiClient.get<{ count: number }>('/alerts/unread-count');
  },

  // 获取最近告警
  getRecentAlerts(params?: { limit?: number }) {
    return apiClient.get<AlertListResponse>('/alerts/recent', { params });
  },

  // 获取告警总数（用于布局组件显示）
  getAlertCount() {
    return apiClient.get<{ count: number }>('/alerts/count');
  },

  // 标记全部已读
  markAllAsRead() {
    return apiClient.post<{ success: boolean }>('/alerts/mark-all-read');
  },

  // 标记单个告警已读
  markAsRead(id: string) {
    return apiClient.post<{ success: boolean }>(`/alerts/${id}/read`);
  },

  // 解决告警
  resolveAlert(id: string) {
    return apiClient.post<{ success: boolean }>(`/alerts/${id}/resolve`);
  },

  // 删除告警
  deleteAlert(id: string) {
    return apiClient.delete<{ success: boolean }>(`/alerts/${id}`);
  },
};

// Skill 执行
export const skillAPI = {
  // 执行 Skill
  executeSkill(skillName: string, args?: Record<string, unknown>) {
    return apiClient.post<SkillExecutionResult>('/skills/execute', {
      skill_name: skillName,
      args,
    });
  },

  // 获取 Skill 状态
  getSkillStatus(executionId: string) {
    return apiClient.get<SkillStatus>(`/skills/${executionId}/status`);
  },

  // 获取 Skill 结果
  getSkillResult(executionId: string) {
    return apiClient.get<SkillResult>(`/skills/${executionId}/result`);
  },

  // 获取 Skills 列表
  getSkillsList() {
    return apiClient.get<SkillListResponse>('/skills/list');
  },
};

// Agent Chat
export const agentAPI = {
  // 发送聊天消息
  chat(message: string, instanceId?: string) {
    return apiClient.post<AgentChatResponse>('/agent/chat', {
      message,
      instance_id: instanceId,
    });
  },
};

// ==================== 类型定义 ====================

export interface DatabaseInstance {
  id: number;  // 后端使用 Integer 主键
  name: string;
  host: string;
  port: number;
  db_type: string;  // 改为 db_type 匹配后端
  version?: string;
  username: string;
  environment: string;  // 添加 environment
  status: 'healthy' | 'warning' | 'critical' | 'running' | 'stopped' | 'error' | 'unknown';
  health_score: number;
  created_at?: string;
  updated_at?: string;
  is_active?: boolean;
  tenant_id?: number;
  created_by?: number;
}

export interface DatabaseInstanceListResponse {
  instances: DatabaseInstance[];
  total: number;
  page?: number;
  limit?: number;
}

export interface CreateDatabaseInstanceRequest {
  name: string;
  host: string;
  port: number;
  type: 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mariadb' | 'other';
  username: string;
  password: string;
  database?: string;
}

export interface UpdateDatabaseInstanceRequest {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database_name?: string;
  environment?: string;
  db_type?: string;
  max_connections?: number;
  connection_timeout_ms?: number;
  description?: string;
  tags?: any;
}

export interface MetricsResponse {
  instance_id: string;
  metrics: {
    cpu_usage?: number;
    memory_usage?: number;
    disk_usage?: number;
    connections?: number;
    qps?: number;
    tps?: number;
  };
  timestamp: string;
}

export interface HealthCheckResult {
  instance_id?: string;
  health_score: number;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  checks: HealthCheckItem[];
  metrics?: {
    connections?: { current: number; max: number; usage: number };
    uptime?: string;
    version?: string;
    slow_queries?: number;
    qps?: number;
    tps?: number;
  };
  issues?: Array<{ level: string; title: string; suggestion: string }>;
  timestamp?: string;
}

export interface HealthCheckItem {
  name: string;
  status: 'ok' | 'warning' | 'error';
  score: number;
  message?: string;
}

export interface HealthHistoryResponse {
  instance_id: string;
  dates: string[];
  scores: number[];
}

export interface SlowQuery {
  id: string;
  instance_id: string;
  sql_text: string;
  sql_text_short: string;
  avg_time_ms: number;
  max_time_ms: number;
  execution_count: number;
  total_time_ms: number;
  first_seen: string;
  last_seen: string;
}

export interface SlowQueryListResponse {
  slow_queries: SlowQuery[];
  total: number;
}

export interface SlowQueryAnalysis {
  sql: string;
  analysis: string;
  suggestions: string[];
  risk_level: 'low' | 'medium' | 'high' | 'critical';
}

export interface ExplainPlanResponse {
  plan: ExplainPlanItem[];
}

export interface ExplainPlanItem {
  id: number;
  select_type: string;
  table: string;
  type: string;
  possible_keys: string[];
  key: string;
  key_len: string;
  ref: string;
  rows: number;
  extra: string;
}

export interface FaultDiagnosisResult {
  instance_id: string;
  fault_type: string;
  diagnosis: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestions: string[];
  auto_heal_possible: boolean;
}

export interface FaultHealResult {
  instance_id: string;
  fault_type: string;
  success: boolean;
  message: string;
}

export interface FaultHistoryResponse {
  faults: FaultRecord[];
  total: number;
}

export interface FaultRecord {
  id: string;
  instance_id: string;
  fault_type: string;
  severity: string;
  status: 'pending' | 'diagnosing' | 'healing' | 'resolved' | 'failed';
  created_at: string;
  resolved_at?: string;
}

export interface RealtimeMetricsResponse {
  instance_id: string;
  db_type?: string;  // 数据库类型
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  connections: number;
  max_connections?: number;
  qps: number;
  tps: number;
  active_transactions: number;
  slow_queries: number;
  // MySQL 特有指标
  innodb_buffer_pool_hit_rate?: number;  // InnoDB 缓冲池命中率
  innodb_row_lock_time_avg?: number;     // 行锁等待平均时间 (ms)
  innodb_deadlocks?: number;              // 死锁数量
  binlog_cache_hit_rate?: number;         // 二进制日志缓存命中率
  tmp_table_on_disk?: number;             // 磁盘临时表数量
  thread_cache_hit_rate?: number;         // 线程缓存命中率
  replication_lag?: number;               // 复制延迟 (秒)
  replication_status?: 'running' | 'stopped' | 'error';  // 复制状态
  // PostgreSQL 特有指标
  xact_commit?: number;                   // 事务提交数
  xact_rollback?: number;                 // 事务回滚数
  tup_returned?: number;                  // 返回行数
  tup_fetched?: number;                   // 抓取行数
  tup_inserted?: number;                  // 插入行数
  tup_updated?: number;                   // 更新行数
  tup_deleted?: number;                   // 删除行数
  blk_read?: number;                      // 磁盘读取块数
  blk_hit?: number;                       // 缓存命中块数
  cache_hit_rate?: number;                // 缓存命中率
  deadlock_count?: number;                // 死锁数量
  lock_wait_count?: number;               // 锁等待数量
  temp_files?: number;                    // 临时文件数量
  temp_bytes?: number;                    // 临时文件字节数
  // Oracle 特有指标
  pga_cache_hit_rate?: number;            // PGA 缓存命中率
  library_cache_hit_rate?: number;        // 库缓存命中率
  dictionary_cache_hit_rate?: number;     // 数据字典缓存命中率
  shared_pool_hit_rate?: number;          // 共享池命中率
  redo_log_space_requests?: number;       // 重做日志空间请求
  enqueue_deadlocks?: number;             // 队列死锁数量
  pga_memory_usage_mb?: number;           // PGA 内存使用 (MB)
  sga_memory_usage_mb?: number;           // SGA 内存使用 (MB)
  tablespace_usage_percent?: number;      // 表空间使用率
  active_sessions?: number;               // 活动会话数
  wait_events?: Array<{ name: string; waits: number; time_ms: number }>; // 等待事件
  // 达梦特有指标
  dm_buffer_hit_rate?: number;            // 缓冲池命中率
  dm_lock_wait?: number;                  // 锁等待数量
  dm_deadlock_count?: number;             // 死锁数量
  dm_paged_memory_usage?: number;         // 页内存使用
  dm_os_memory_usage?: number;            // 操作系统内存使用
  timestamp: string;
}

export interface HistoryMetricsResponse {
  instance_id: string;
  metrics: {
    timestamp: string;
    cpu_usage?: number;
    memory_usage?: number;
    disk_usage?: number;
    connections?: number;
    qps?: number;
    tps?: number;
  }[];
}

export interface ReportResult {
  id: string;
  type: string;
  status: 'generating' | 'completed' | 'failed';
  url?: string;
  created_at: string;
}

export interface ReportListResponse {
  reports: ReportResult[];
  total: number;
}

export interface Alert {
  id: string;
  instance_id: string;
  instance_name?: string;
  title: string;
  description: string;
  level: 'info' | 'warning' | 'critical';
  status: 'unread' | 'read' | 'resolved';
  type: string;
  created_at: string;
  resolved_at?: string;
  time?: string; // 兼容前端显示
}

export interface AlertListResponse {
  alerts: Alert[];
  total: number;
}

export interface SkillExecutionResult {
  execution_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message?: string;
}

export interface SkillStatus {
  execution_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  message?: string;
}

export interface SkillResult {
  execution_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

export interface SkillListResponse {
  skills: SkillInfo[];
  total: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface AgentChatResponse {
  message: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
  };
}

// ==================== DB-Ops Skills API ====================

export interface DbOpsSkillMetadata {
  name: string;
  description: string;
  category: string;
  toolCount: number;
  toolNames: string[];
}

export interface DbOpsSkillMetadataResponse {
  skills: DbOpsSkillMetadata[];
  total: number;
}

export interface DbOpsToolGroupsResponse {
  groups: Record<string, string[]>;
}

export interface DbOpsSkillDetails {
  name: string;
  description: string;
  category: string;
  toolCount: number;
  tools: Array<{
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
  markdown?: string;
  sourceCode?: string;
}

export interface SourceFile {
  name: string;
  content: string;
}

export interface DbOpsSkillDetailsResponse {
  name: string;
  description: string;
  category: string;
  toolCount: number;
  tools: Array<{
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
  hasMarkdown: boolean;
  hasSourceCode: boolean;
  markdown?: string;
  sourceCode?: string;
  sourceFiles?: SourceFile[];  // 支持多个源文件
}

export interface DbOpsExecuteRequest {
  tool_name: string;
  args?: Record<string, unknown>;
}

export interface DbOpsExecuteResponse {
  success: boolean;
  tool_name: string;
  skill_name?: string;
  result?: unknown;
  error?: string;
}

export interface DbOpsBatchExecuteRequest {
  tools: Array<{ tool_name: string; args?: Record<string, unknown> }>;
}

export interface DbOpsBatchExecuteResponse {
  results: Array<{
    tool_name: string;
    skill_name?: string;
    success: boolean;
    result?: unknown;
    error?: string;
  }>;
  total: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  senderLabel?: string | null;
  relatedTool?: string;
  relatedSkill?: string;
  llmContext?: {
    userInput: string;
    systemPrompt?: string;
    toolDecision: {
      toolName: string;
      parameters: Record<string, unknown>;
      reason?: string;
    } | null;
    rawResponse?: string;
  };
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export const dbOpsSkillsAPI = {
  // 获取 Skills 元数据
  getMetadata() {
    return apiClient.get<DbOpsSkillMetadataResponse>('/db-skills/metadata');
  },

  // 获取工具分组
  getGroups() {
    return apiClient.get<DbOpsToolGroupsResponse>('/db-skills/groups');
  },

  // 获取技能详情（包括 SKILL.md 内容和源代码）
  getDetails(skillName: string) {
    return apiClient.get<DbOpsSkillDetailsResponse>(`/db-skills/${skillName}/details`);
  },

  // 执行工具
  executeTool(toolName: string, args?: Record<string, unknown>) {
    return apiClient.post<DbOpsExecuteResponse>('/db-skills/execute', {
      tool_name: toolName,
      args,
    } as DbOpsExecuteRequest);
  },

  // 批量执行工具
  batchExecuteTools(tools: Array<{ tool_name: string; args?: Record<string, unknown> }>) {
    return apiClient.post<DbOpsBatchExecuteResponse>('/db-skills/batch-execute', {
      tools,
    } as DbOpsBatchExecuteRequest);
  },
};

// ==================== Chat API ====================

export interface ChatRequest {
  message: string;
  sessionId?: string;
  instanceId?: number;
  mode?: 'chat' | 'skill' | 'enhanced';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export interface ChatResponse {
  message: ChatMessage;
  sessionId: string;
  relatedTool?: string;
  relatedSkill?: string;
}

export interface EnhancedChatResponse {
  message: ChatMessage;
  sessionId: string;
  relatedTools?: string[];
  confidence?: number;
  analysisType?: string;
  executedTool?: {
    name: string;
    result: unknown;
    parameters?: Record<string, unknown>;
  };
  llmContext?: {
    userInput: string;
    systemPrompt?: string;
    toolDecision: {
      toolName: string;
      parameters: Record<string, unknown>;
      reason?: string;
    } | null;
    rawResponse?: string;
  };
}

export const chatAPI = {
  // 发送聊天消息（复用 agentAPI，扩展功能）
  chat(message: string, instanceId?: number) {
    return apiClient.post<AgentChatResponse>('/agent/chat', {
      message,
      instanceId,
    });
  },

  // AI 增强 Chat - 使用 Agent Chat 接口
  enhancedChat(message: string, instanceId?: number, sessionId?: string) {
    const body: Record<string, unknown> = {
      message,
      session_id: sessionId,
    };
    // Only include instance_id if provided (avoid sending undefined)
    if (instanceId !== undefined) {
      body.instance_id = instanceId;
    }
    return apiClient.post<EnhancedChatResponse>('/agent/chat', body);
  },

  // 发送消息（带流式响应）
  sendMessage(sessionId: string, message: string, signal?: AbortSignal) {
    return apiClient.post<EnhancedChatResponse>('/agent/chat', {
      session_id: sessionId,
      message,
    }, { signal });
  },

  // 获取会话列表
  getSessions() {
    return apiClient.get<{ sessions: ChatSession[]; total: number }>('/chat/sessions');
  },

  // 获取单个会话详情（包括消息）
  getSession(sessionId: string) {
    return apiClient.get<{ session: ChatSession; messages: ChatMessage[] }>(`/chat/sessions/${sessionId}`);
  },

  // 创建新会话
  createSession(title?: string, instanceId?: number) {
    return apiClient.post<ChatSession>('/chat/sessions', { title, instanceId });
  },

  // 删除会话
  deleteSession(sessionId: string) {
    return apiClient.delete<{ success: boolean }>(`/chat/sessions/${sessionId}`);
  },

  // 执行 Skills 并通过 Chat 返回结果
  executeSkillChat(toolName: string, toolArgs?: Record<string, unknown>, instanceId?: number) {
    return apiClient.post<ChatResponse>('/chat/skill', {
      message: `执行工具：${toolName}`,
      mode: 'skill',
      toolName,
      toolArgs,
      instanceId,
    } as ChatRequest);
  },
};
