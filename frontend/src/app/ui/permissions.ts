import { html, nothing } from 'lit';
import { apiClient, isSessionExpiryInProgress } from '../../api/index.ts';

export interface PermissionsState {
  permissionsLoading?: boolean;
  permissionsError?: string | null;
  userPermissions?: Set<string>;
}

function isPermissions(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function readCachedPermissions(): Set<string> | null {
  const stored = localStorage.getItem('permissions');
  if (stored === null) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (isPermissions(value)) return new Set(value);
  } catch { /* Discard invalid caches from earlier versions. */ }
  localStorage.removeItem('permissions');
  return null;
}

export async function loadPermissions(state: PermissionsState): Promise<void> {
  if (state.permissionsLoading || !apiClient.getToken()) return;
  const user = localStorage.getItem('user');
  const isCurrentSession = () => Boolean(apiClient.getToken())
    && !isSessionExpiryInProgress() && localStorage.getItem('user') === user;
  state.permissionsLoading = true;
  try {
    const response = await apiClient.fetchResponseWithAuth('/api/auth/permissions');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const permissions: unknown = await response.json();
    if (!isPermissions(permissions)) throw new Error('invalid permissions');
    if (!isCurrentSession()) return;
    localStorage.setItem('permissions', JSON.stringify(permissions));
    state.userPermissions = new Set(permissions);
    state.permissionsError = null;
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } }));
  } catch {
    if (isCurrentSession()) {
      state.permissionsError = '权限加载失败，部分功能暂不可用。请重试。';
    }
  } finally {
    state.permissionsLoading = false;
  }
}

export function renderPermissionsError(state: PermissionsState) {
  return state.permissionsError ? html`
    <div class="callout danger" role="alert">
      <span>${state.permissionsError}</span>
      <button class="btn" type="button" .disabled=${Boolean(state.permissionsLoading)}
        @click=${() => void loadPermissions(state)}>
        ${state.permissionsLoading ? '正在重试…' : '重试加载权限'}
      </button>
    </div>
  ` : nothing;
}
