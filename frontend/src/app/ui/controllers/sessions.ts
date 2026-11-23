import { toNumber } from "../format.ts";
import type { DirectGatewayClient } from "../direct-gateway.ts";
import type { SessionsListResult } from "../types.ts";
import { authFetch } from '../../../api/index.js';

export type SessionsState = {
  client: DirectGatewayClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
};

export async function loadSessions(
  state: SessionsState,
  overrides?: {
    activeMinutes?: number;
    limit?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
  },
) {
  if (!state.client || !state.connected) return;
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const token = (window as any).__apiClient?.getToken?.() || '';
    const params = new URLSearchParams();
    const activeMinutes = overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0);
    if (activeMinutes > 0) params.set('activeMinutes', String(activeMinutes));
    const url = `/api/sessions?${params.toString()}`;
    const res = await authFetch(url, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (res.status === 403) {
      state.sessionsError = "无权读取会话，请联系管理员。";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.sessions)) throw new Error("Invalid sessions response");
    state.sessionsResult = data;
  } catch {
    state.sessionsError = "无法读取会话列表，请刷新重试。";
  } finally {
    state.sessionsLoading = false;
  }
}
