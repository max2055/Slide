/**
 * Slide - User Preferences API
 */
import { apiClient } from './index.ts';

export const preferencesAPI = {
  /** Get current user's preferences from server */
  getPreferences: () => apiClient.get<{ preferences: Record<string, unknown> }>('/user/preferences'),

  /** Save current user's preferences to server */
  savePreferences: (preferences: Record<string, unknown>) =>
    apiClient.put<{ success: boolean }>('/user/preferences', { preferences }),
};
