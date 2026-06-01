/**
 * LLM 服务模块 - 重构版
 * 纯数据库驱动，支持用量追踪和智能路由
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { llmDatabaseService, LLMProvider, ModelInfo } from './llm-database-service.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface LLMResponse {
  success: boolean;
  content?: string;
  usage?: LLMUsage;
  model?: string;
  provider?: string;
  duration_ms?: number;
  error?: string;
}

export interface ChatOptions {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  // 能力需求
  requiresFunctionCall?: boolean;
  requiresVision?: boolean;
  minContextWindow?: number;
  // 追踪信息
  userId?: number | null;
  sessionId?: string;
  instanceId?: number | null;
  purpose?: 'sql_analysis' | 'fault_diagnosis' | 'health_check' | 'chat' | string;
}

export interface ProviderClient {
  name: string;
  type: 'anthropic' | 'openai' | 'ollama' | 'azure';
  client: Anthropic | OpenAI | null;
  config: LLMProvider;
}

class LLMService {
  private providerClients: Map<string, ProviderClient> = new Map();
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProviderName: string | null = null;
  private initialized = false;

  /**
   * 初始化服务（从数据库加载配置）
   */
  async initialize(): Promise<boolean> {
    try {
      const providers = await llmDatabaseService.getEnabledProviders();

      for (const provider of providers) {
        this.providers.set(provider.name, provider);

        if (provider.is_default && !this.defaultProviderName) {
          this.defaultProviderName = provider.name;
        }

        // 初始化客户端
        const client = await this.createClient(provider);
        if (client) {
          this.providerClients.set(provider.name, client);
        }
      }

      this.initialized = true;
      console.log(`[LLM] 已加载 ${providers.length} 个提供商`);
      return true;
    } catch (error: any) {
      console.error('[LLM] 初始化失败:', error.message);
      return false;
    }
  }

  /**
   * 创建 Provider 客户端
   */
  private async createClient(provider: LLMProvider): Promise<ProviderClient | null> {
    // 本地模型不需要 API Key
    if (provider.deployment_type !== 'local' && !provider.api_key_encrypted) {
      console.log(`[LLM] ${provider.name} 未配置 API Key，跳过初始化`);
      return null;
    }

    const apiKey = provider.deployment_type === 'local'
      ? 'ollama'
      : await llmDatabaseService.getProviderApiKey(provider.name);

    if (!apiKey && provider.deployment_type !== 'local') {
      return null;
    }

    const apiFormat = provider.api_format || null;

    if (apiFormat === 'anthropic-messages') {
      return {
        name: provider.name,
        type: 'anthropic',
        client: new Anthropic({ apiKey: apiKey! }),
        config: provider,
      };
    }

    if (apiFormat === 'google-generative-ai') {
      console.warn(`[LLM] ${provider.name} 使用 Google Generative AI，暂不支持`);
      return null;
    }

    // Ollama 本地部署（无 api_format 且 deployment_type=local 时保持兼容）
    if (!apiFormat && provider.deployment_type === 'local') {
      return {
        name: provider.name,
        type: 'ollama',
        client: null,
        config: provider,
      };
    }

    // openai-completions / null / 未知 → OpenAI 兼容接口
    if (provider.api_base_url && apiKey) {
      return {
        name: provider.name,
        type: 'openai',
        client: new OpenAI({
          apiKey: apiKey,
          baseURL: provider.api_base_url,
        }),
        config: provider,
      };
    }

    if (!apiKey) {
      return null;
    }

    // 无 baseURL 但有 apiKey → 用默认 OpenAI
    return {
      name: provider.name,
      type: 'openai',
      client: new OpenAI({ apiKey }),
      config: provider,
    };
  }

  /**
   * 重新加载 Provider 配置
   */
  async reloadConfig(): Promise<void> {
    this.providerClients.clear();
    this.providers.clear();
    this.defaultProviderName = null;
    await this.initialize();
  }

  /**
   * 动态添加/更新 Provider 配置
   */
  async configureProvider(name: string): Promise<boolean> {
    try {
      const provider = await llmDatabaseService.getProviderByName(name);
      if (!provider) return false;

      this.providers.set(name, provider);

      const client = await this.createClient(provider);
      if (client) {
        this.providerClients.set(name, client);
      } else {
        this.providerClients.delete(name);
      }

      if (provider.is_default) {
        this.defaultProviderName = name;
      }

      return true;
    } catch (error) {
      console.error(`[LLM] 配置 ${name} 失败:`, error);
      return false;
    }
  }

  /**
   * 获取可用的 Provider 列表（带能力信息）
   */
  getAvailableProviders(): Array<{
    name: string;
    display_name: string;
    deployment_type: string;
    default_model: string | null;
    models_supported: ModelInfo[] | null;
    context_window: number;
    supports_function_call: boolean;
    supports_vision: boolean;
    enabled: boolean;
    is_default: boolean;
  }> {
    return Array.from(this.providers.values()).map(p => ({
      name: p.name,
      display_name: p.display_name,
      deployment_type: p.deployment_type,
      default_model: p.default_model,
      models_supported: p.models_supported,
      context_window: p.context_window,
      supports_function_call: p.supports_function_call,
      supports_vision: p.supports_vision,
      enabled: p.enabled,
      is_default: p.is_default,
    }));
  }

  /**
   * 智能选择 Provider
   */
  selectProvider(options: {
    requiresFunctionCall?: boolean;
    requiresVision?: boolean;
    minContextWindow?: number;
    preferredName?: string;
  }): LLMProvider | null {
    const providers = Array.from(this.providers.values()).filter(p => p.enabled);

    if (providers.length === 0) {
      return null;
    }

    // 如果指定了首选且可用，直接使用
    if (options.preferredName) {
      const preferred = providers.find(p => p.name === options.preferredName);
      if (preferred && this.meetsRequirements(preferred, options)) {
        return preferred;
      }
    }

    // 默认 Provider 优先
    if (this.defaultProviderName) {
      const defaultProvider = providers.find(p => p.name === this.defaultProviderName);
      if (defaultProvider && this.meetsRequirements(defaultProvider, options)) {
        return defaultProvider;
      }
    }

    // 筛选满足要求的 Provider
    const candidates = providers.filter(p => this.meetsRequirements(p, options));

    if (candidates.length === 0) {
      return providers[0]; // 没有满足要求的，返回第一个
    }

    // 按性价比排序（简单策略：本地 > 云 > API）
    const typePriority = { local: 1, cloud: 2, api: 3 };
    candidates.sort((a, b) => {
      const priorityDiff = typePriority[a.deployment_type] - typePriority[b.deployment_type];
      if (priorityDiff !== 0) return priorityDiff;
      // 同类型按成本排序
      const costA = (a.input_cost_per_1k + a.output_cost_per_1k) / 2;
      const costB = (b.input_cost_per_1k + b.output_cost_per_1k) / 2;
      return costA - costB;
    });

    return candidates[0];
  }

  /**
   * 检查 Provider 是否满足要求
   */
  private meetsRequirements(
    provider: LLMProvider,
    options: {
      requiresFunctionCall?: boolean;
      requiresVision?: boolean;
      minContextWindow?: number;
    }
  ): boolean {
    if (options.requiresFunctionCall && !provider.supports_function_call) {
      return false;
    }
    if (options.requiresVision && !provider.supports_vision) {
      return false;
    }
    if (options.minContextWindow && provider.context_window < options.minContextWindow) {
      return false;
    }
    return true;
  }

  /**
   * 通用 Chat 接口（带用量追踪）
   */
  async chatWithTracking(messages: ChatMessage[], options: ChatOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    let providerName = options.provider || this.defaultProviderName;

    // 智能选择 Provider
    if (!providerName || options.requiresFunctionCall || options.requiresVision || options.minContextWindow) {
      const selected = this.selectProvider({
        requiresFunctionCall: options.requiresFunctionCall,
        requiresVision: options.requiresVision,
        minContextWindow: options.minContextWindow,
        preferredName: providerName || undefined,
      });
      if (!selected) {
        return {
          success: false,
          error: '没有可用的 LLM 提供商',
        };
      }
      providerName = selected.name;
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      return {
        success: false,
        error: `LLM 提供商 '${providerName}' 未配置`,
      };
    }

    const client = this.providerClients.get(providerName);
    if (!client) {
      return {
        success: false,
        error: `LLM 提供商 '${providerName}' 客户端未初始化`,
      };
    }

    try {
      // 调用 LLM
      const result = await this.callLLM(
        client,
        messages,
        {
          model: options.model || provider.default_model,
          temperature: options.temperature ?? provider.temperature ?? 0.7,
          maxTokens: options.maxTokens ?? provider.max_tokens,
          system: options.system,
        }
      );

      const duration_ms = Date.now() - startTime;

      // 计算成本
      const input_tokens = result.usage?.input_tokens || 0;
      const output_tokens = result.usage?.output_tokens || 0;
      const cost_usd = (input_tokens / 1000) * provider.input_cost_per_1k +
                       (output_tokens / 1000) * provider.output_cost_per_1k;

      // 记录用量
      if (options.sessionId) {
        await llmDatabaseService.recordUsage({
          provider_id: provider.id,
          provider_name: provider.name,
          model: result.model || provider.default_model || 'unknown',
          user_id: options.userId,
          session_id: options.sessionId,
          instance_id: options.instanceId,
          input_tokens,
          output_tokens,
          cost_usd,
          duration_ms,
          status: result.success ? 'success' : 'error',
          error_message: result.error || null,
          purpose: options.purpose || null,
        });
      }

      return {
        ...result,
        provider: providerName,
        duration_ms,
        usage: {
          input_tokens,
          output_tokens,
          total_tokens: input_tokens + output_tokens,
          cost_usd,
        },
      };
    } catch (error: any) {
      const duration_ms = Date.now() - startTime;

      // 记录失败
      if (options.sessionId) {
        await llmDatabaseService.recordUsage({
          provider_id: provider.id,
          provider_name: provider.name,
          model: options.model || provider.default_model || 'unknown',
          user_id: options.userId,
          session_id: options.sessionId,
          instance_id: options.instanceId,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          duration_ms,
          status: 'error',
          error_message: error.message,
          purpose: options.purpose || null,
        });
      }

      return {
        success: false,
        error: error.message,
        provider: providerName,
        duration_ms,
      };
    }
  }

  /**
   * 兼容旧版 chat 接口
   */
  async chat(
    messages: ChatMessage[],
    provider?: string,
    model?: string,
    temperature = 0.7,
    maxTokens = 4096,
    system?: string,
    onChunk?: (chunk: string) => Promise<void> | void
  ): Promise<LLMResponse> {
    if (onChunk) {
      // 流式模式
      return this.chatWithStreaming(messages, {
        provider,
        model,
        temperature,
        maxTokens,
        system,
        onChunk,
      });
    }
    return this.chatWithTracking(messages, {
      provider,
      model,
      temperature,
      maxTokens,
      system,
    });
  }

  /**
   * 流式 Chat（支持增量输出）
   */
  async chatWithStreaming(
    messages: ChatMessage[],
    options: ChatOptions & {
      onChunk: (chunk: string) => Promise<void> | void;
    }
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    let providerName = options.provider || this.defaultProviderName;

    // 智能选择 Provider
    if (!providerName) {
      const selected = this.selectProvider({
        requiresFunctionCall: options.requiresFunctionCall,
        requiresVision: options.requiresVision,
        minContextWindow: options.minContextWindow,
        preferredName: providerName || undefined,
      });
      if (!selected) {
        return {
          success: false,
          error: '没有可用的 LLM 提供商',
        };
      }
      providerName = selected.name;
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      return {
        success: false,
        error: `LLM 提供商 '${providerName}' 未配置`,
      };
    }

    const client = this.providerClients.get(providerName);
    if (!client) {
      return {
        success: false,
        error: `LLM 提供商 '${providerName}' 客户端未初始化`,
      };
    }

    try {
      let content = '';
      let usage: { input_tokens: number; output_tokens: number } | undefined;

      // 调用流式 LLM
      switch (client.type) {
        case 'anthropic':
          content = await this.callAnthropicStream(
            client.client as Anthropic,
            messages,
            {
              model: options.model || provider.default_model || 'claude-sonnet-4-6',
              temperature: options.temperature ?? 0.7,
              maxTokens: options.maxTokens,
              system: options.system,
            },
            options.onChunk
          );
          break;
        case 'openai':
          content = await this.callOpenAIStream(
            client.client as OpenAI,
            messages,
            {
              model: options.model || provider.default_model || 'gpt-4o',
              temperature: options.temperature ?? 0.7,
              maxTokens: options.maxTokens,
              system: options.system,
            },
            options.onChunk
          );
          break;
        default:
          return { success: false, error: `流式输出暂不支持 Provider: ${client.type}` };
      }

      const duration_ms = Date.now() - startTime;

      // 计算成本（估算）
      const input_tokens = Math.ceil(messages.reduce((acc, m) => acc + m.content.length / 4, 0));
      const output_tokens = Math.ceil(content.length / 4);
      const cost_usd = (input_tokens / 1000) * provider.input_cost_per_1k +
                       (output_tokens / 1000) * provider.output_cost_per_1k;

      return {
        success: true,
        content,
        model: provider.default_model,
        provider: providerName,
        duration_ms,
        usage: {
          input_tokens,
          output_tokens,
          total_tokens: input_tokens + output_tokens,
          cost_usd,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        provider: providerName,
      };
    }
  }

  /**
   * 调用 LLM
   */
  private async callLLM(
    client: ProviderClient,
    messages: ChatMessage[],
    options: {
      model?: string | null;
      temperature?: number;
      maxTokens?: number;
      system?: string;
    }
  ): Promise<{
    success: boolean;
    content?: string;
    usage?: { input_tokens: number; output_tokens: number };
    model?: string;
    error?: string;
  }> {
    const model = options.model || client.config.default_model;

    try {
      switch (client.type) {
        case 'anthropic':
          return await this.callAnthropic(
            client.client as Anthropic,
            messages,
            {
              model: model || 'claude-sonnet-4-6',
              temperature: options.temperature ?? 0.7,
              maxTokens: options.maxTokens,
              system: options.system,
            }
          );
        case 'openai':
          return await this.callOpenAI(
            client.client as OpenAI,
            messages,
            {
              model: model || 'gpt-4o',
              temperature: options.temperature ?? 0.7,
              maxTokens: options.maxTokens,
              system: options.system,
            }
          );
        case 'ollama':
          return await this.callOllama(
            client.config,
            messages,
            {
              model: model || 'qwen2.5-coder:32b',
              temperature: options.temperature ?? 0.7,
              maxTokens: options.maxTokens,
              system: options.system,
            }
          );
        default:
          return { success: false, error: `不支持的 Provider 类型：${client.type}` };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || `${client.name} 调用失败`,
      };
    }
  }

  /**
   * 调用 Anthropic（流式）
   */
  private async callAnthropicStream(
    client: Anthropic,
    messages: ChatMessage[],
    options: { model: string; temperature: number; maxTokens?: number; system?: string },
    onChunk: (chunk: string) => Promise<void> | void
  ): Promise<string> {
    const userMessages = messages.filter(m => m.role !== 'system');
    const systemMessage = options.system || messages.find(m => m.role === 'system')?.content;

    const stream = await client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature,
      system: systemMessage,
      messages: userMessages as Anthropic.Messages.MessageParam[],
    });

    let content = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const text = event.delta.text;
        content += text;
        await onChunk(text);
      }
    }

    return content;
  }

  /**
   * 调用 OpenAI 兼容接口（流式）
   */
  private async callOpenAIStream(
    client: OpenAI,
    messages: ChatMessage[],
    options: { model: string; temperature: number; maxTokens?: number; system?: string },
    onChunk: (chunk: string) => Promise<void> | void
  ): Promise<string> {
    const allMessages = [...messages];
    if (options.system && !messages.some(m => m.role === 'system')) {
      allMessages.unshift({ role: 'system', content: options.system });
    }

    const stream = await client.chat.completions.create({
      model: options.model,
      messages: allMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
    });

    let content = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        content += delta;
        await onChunk(delta);
      }
    }

    return content;
  }

  /**
   * 调用 Anthropic
   */
  private async callAnthropic(
    client: Anthropic,
    messages: ChatMessage[],
    options: { model: string; temperature: number; maxTokens?: number; system?: string }
  ): Promise<{
    success: boolean;
    content?: string;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number };
    model?: string;
    error?: string;
  }> {
    const userMessages = messages.filter(m => m.role !== 'system');
    const systemMessage = options.system || messages.find(m => m.role === 'system')?.content;

    const response = await client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature,
      system: systemMessage,
      messages: userMessages as Anthropic.Messages.MessageParam[],
    });

    return {
      success: true,
      content: response.content[0].type === 'text' ? response.content[0].text : '',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        cost_usd: 0,
      },
      model: response.model,
    };
  }

  /**
   * 调用 OpenAI 兼容接口
   */
  private async callOpenAI(
    client: OpenAI,
    messages: ChatMessage[],
    options: { model: string; temperature: number; maxTokens?: number; system?: string }
  ): Promise<{
    success: boolean;
    content?: string;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number };
    model?: string;
    error?: string;
  }> {
    const allMessages = [...messages];
    if (options.system && !messages.some(m => m.role === 'system')) {
      allMessages.unshift({ role: 'system', content: options.system });
    }

    const response = await client.chat.completions.create({
      model: options.model,
      messages: allMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    });

    return {
      success: true,
      content: response.choices[0].message.content || '',
      usage: {
        input_tokens: response.usage?.prompt_tokens || 0,
        output_tokens: response.usage?.completion_tokens || 0,
        total_tokens: (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0),
        cost_usd: 0,
      },
      model: response.model,
    };
  }

  /**
   * 调用 Ollama
   */
  private async callOllama(
    provider: LLMProvider,
    messages: ChatMessage[],
    options: { model: string; temperature: number; maxTokens?: number; system?: string }
  ): Promise<{
    success: boolean;
    content?: string;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number };
    model?: string;
    error?: string;
  }> {
    const baseUrl = provider.api_base_url || 'http://localhost:11434';
    const url = `${baseUrl}/api/chat`;

    const allMessages = [...messages];
    if (options.system && !messages.some(m => m.role === 'system')) {
      allMessages.unshift({ role: 'system', content: options.system });
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: allMessages,
        stream: false,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens || 2048,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API 错误：${response.statusText}`);
    }

    const result = await response.json();

    return {
      success: true,
      content: result.message?.content || '',
      usage: {
        input_tokens: result.prompt_eval_count || 0,
        output_tokens: result.eval_count || 0,
        total_tokens: (result.prompt_eval_count || 0) + (result.eval_count || 0),
        cost_usd: 0,
      },
      model: result.model,
    };
  }

  /**
   * 测试连接
   */
  async testConnection(provider?: string): Promise<LLMResponse> {
    const providerName = provider || this.defaultProviderName;
    if (!providerName) {
      return { success: false, error: '没有配置默认的 LLM 提供商' };
    }

    const providerConfig = this.providers.get(providerName);
    if (!providerConfig) {
      return { success: false, error: `LLM 提供商 '${providerName}' 未配置` };
    }

    const client = this.providerClients.get(providerName);
    if (!client) {
      return { success: false, error: `LLM 提供商 '${providerName}' 客户端未初始化` };
    }

    try {
      const result = await this.callLLM(
        client,
        [{ role: 'user', content: '请用一句话回复：你好' }],
        {
          model: providerConfig.default_model,
          temperature: 0.7,
          maxTokens: 20,
        }
      );

      if (result.success) {
        return {
          success: true,
          content: `连接成功！模型：${result.model || 'unknown'}`,
          model: result.model,
          provider: providerName,
          usage: result.usage,
        } as LLMResponse;
      } else {
        return {
          success: false,
          error: result.error,
          provider: providerName,
        } as LLMResponse;
      }
    } catch (error: any) {
      return {
        success: false,
        error: `连接测试异常：${error.message}`,
        provider: providerName,
      } as LLMResponse;
    }
  }

  /**
   * 使用临时配置测试连接
   */
  async testConnectionWithConfig(provider: string, apiKey: string, baseURL?: string, model?: string): Promise<LLMResponse> {
    try {
      // 创建临时客户端
      const providerInfo = await llmDatabaseService.getProviderByName(provider);
      const apiFormat = providerInfo?.api_format || null;
      const deploymentType = providerInfo?.deployment_type || 'api';

      let client;
      if (apiFormat === 'anthropic-messages') {
        client = { name: provider, type: 'anthropic', client: new Anthropic({ apiKey }), config: providerInfo };
      } else if (!apiFormat && deploymentType === 'local') {
        client = { name: provider, type: 'ollama', client: null, config: providerInfo };
      } else {
        // OpenAI 兼容接口（openai-completions / null / 未知）
        client = {
          name: provider,
          type: 'openai',
          client: new OpenAI({
            apiKey,
            baseURL: baseURL || undefined,
          }),
          config: providerInfo,
        };
      }

      const testModel = model || providerInfo?.default_model || 'qwen-plus';

      // 调用测试
      const result = await this.callLLM(
        client,
        [{ role: 'user', content: '请用一句话回复：你好' }],
        {
          model: testModel,
          temperature: 0.7,
          maxTokens: 50,
        }
      );

      if (result.success) {
        return {
          success: true,
          content: `连接成功！模型：${result.model || testModel}`,
          model: result.model,
          provider: provider,
          usage: result.usage,
        } as LLMResponse;
      } else {
        return {
          success: false,
          error: result.error,
          provider: provider,
        } as LLMResponse;
      }
    } catch (error: any) {
      return {
        success: false,
        error: `连接测试异常：${error.message}`,
        provider: provider,
      } as LLMResponse;
    }
  }

  /**
   * 获取 Provider 配置（不含敏感信息）
   */
  getConfig(): Record<string, any> {
    const config: Record<string, any> = {};
    this.providers.forEach((value, key) => {
      config[key] = {
        name: value.name,
        display_name: value.display_name,
        deployment_type: value.deployment_type,
        default_model: value.default_model,
        models_supported: value.models_supported,
        context_window: value.context_window,
        supports_function_call: value.supports_function_call,
        supports_vision: value.supports_vision,
        enabled: value.enabled,
        is_default: value.is_default,
      };
    });
    return config;
  }

  /**
   * 检查服务是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// 全局单例
export const llmService = new LLMService();
