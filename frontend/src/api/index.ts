/**
 * Slide - API Client
 */

const BASE_URL = '/api'; // 使用 Vite 代理到后端

interface RequestConfig extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

interface ApiResponse<T> {
  code: number;
  data: T;
  message?: string;
}

class ApiClient {
  private baseURL: string;

  constructor(baseURL: string = BASE_URL) {
    this.baseURL = baseURL;
  }

  setToken(token: string | null) {
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }

  getToken(): string | null {
    return localStorage.getItem('token');
  }

  private refreshPromise: Promise<string | null> | null = null;

  /** Try to log in directly via REST API */
  async directLogin(username: string, password: string): Promise<string | null> {
    try {
      const data = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/auth/login');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = () => {
          if (xhr.status >= 500) {
            // Backend or proxy returned a server error — server unreachable or broken
            reject(new Error('server-error'));
            return;
          }
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('parse error')); }
        };
        xhr.onerror = () => reject(new Error('network error'));
        xhr.send(JSON.stringify({ username, password }));
      });
      if (data.token) {
        this.setToken(data.token);
        if (data.refreshToken) this.setRefreshToken(data.refreshToken);
        return data.token;
      }
      return null;
    } catch (err) {
      // Re-throw network/server errors so login UI can show a distinct message.
      // Invalid credentials (null token) are returned as null.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'network error' || msg === 'server-error' || msg === 'parse error') {
        throw err;
      }
      return null;
    }
  }

  setRefreshToken(token: string | null) {
    if (token) {
      localStorage.setItem('refreshToken', token);
    } else {
      localStorage.removeItem('refreshToken');
    }
  }

  getRefreshToken(): string | null {
    return localStorage.getItem('refreshToken');
  }

  private buildURL(endpoint: string, params?: Record<string, string | number | boolean | undefined>): string {
    // 移除 endpoint 开头的斜杠，确保相对于 baseURL
    const path = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;

    // 处理相对路径 baseURL（如 /api）- 需要确保尾部有斜杠
    let base = this.baseURL.startsWith('http')
      ? this.baseURL
      : window.location.origin + this.baseURL;
    if (!base.endsWith('/')) {
      base += '/';
    }

    const url = new URL(path, base);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }
    const result: ApiResponse<T> | T = await response.json();

    // 检查是否是标准格式 { code, data }
    if (typeof result === 'object' && result !== null && 'code' in result && typeof (result as ApiResponse<T>).code === 'number') {
      if ((result as ApiResponse<T>).code !== 200 && (result as ApiResponse<T>).code !== 0) {
        throw new Error((result as ApiResponse<T>).message || 'Request failed');
      }
      return (result as ApiResponse<T>).data;
    }

    // 直接返回数据（兼容简单格式）
    return result as T;
  }

  private async attemptTokenRefresh(): Promise<string | null> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return null;

    try {
      const path = this.baseURL.startsWith('http')
        ? this.baseURL + '/auth/refresh'
        : '/api/auth/refresh';

      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        // Refresh failed — clear everything, user must re-login
        this.setToken(null);
        this.setRefreshToken(null);
        return null;
      }

      const data = await response.json();
      this.setToken(data.token);
      this.setRefreshToken(data.refreshToken);
      return data.token;
    } catch {
      // Network error — don't clear tokens, might succeed later
      return null;
    }
  }

  private async fetchWithAuth<T>(url: string, options: RequestInit): Promise<T> {
    const executeFetch = (token: string | null) => {
      const headers = new Headers(options.headers || {});
      const method = (options.method || 'GET').toUpperCase();
      const hasBody = (method === 'POST' || method === 'PUT' || method === 'PATCH') && options.body != null;
      if (!headers.has('Content-Type') && hasBody) {
        headers.set('Content-Type', 'application/json');
      }
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return fetch(url, { ...options, headers, method });
    };

    let response = await executeFetch(this.getToken());

    if (response.status === 401) {
      // Try token refresh first
      if (!this.refreshPromise) {
        this.refreshPromise = this.attemptTokenRefresh().finally(() => {
          this.refreshPromise = null;
        });
      }
      const newToken = await this.refreshPromise;
      if (newToken) {
        response = await executeFetch(newToken);
      }
    }

    return this.parseResponse<T>(response);
  }

  async get<T>(endpoint: string, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint, config?.params);
    return this.fetchWithAuth<T>(url, { method: 'GET', ...config });
  }

  async post<T>(endpoint: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint);
    return this.fetchWithAuth<T>(url, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
      ...config,
    });
  }

  async put<T>(endpoint: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint);
    return this.fetchWithAuth<T>(url, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
      ...config,
    });
  }

  async delete<T>(endpoint: string, config?: RequestConfig): Promise<T> {
    const url = this.buildURL(endpoint, config?.params);
    return this.fetchWithAuth<T>(url, { method: 'DELETE', ...config });
  }

  async fetchPermissions(): Promise<string[]> {
    try {
      return await this.get<string[]>('/auth/permissions');
    } catch {
      return [];
    }
  }
}

// Shared auth-aware fetch — injects JWT token from localStorage.
// For components that use raw fetch() instead of ApiClient.
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = apiClient.getToken();
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}

// 导出单例
export const apiClient = new ApiClient();
// 暴露给 DirectGatewayClient._getToken() 使用
if (typeof window !== 'undefined') (window as any).__apiClient = apiClient;
export default apiClient;
