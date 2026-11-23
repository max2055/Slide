import { authFetch } from '../../../api/index.js';

export interface Report {
  id: number;
  name: string;
  type?: string;
  title?: string;
  instance_name?: string;
  server_id?: number | null;
  server_name?: string;
  target_type?: string;
  status: 'completed' | 'running' | 'failed' | 'pending';
  created_at: string;
  format?: string;
}

export type ReportPreviewResult =
  | { state: 'ready'; content: string }
  | { state: 'no-content' | 'empty-response' | 'not-found' | 'forbidden' | 'unavailable' };

export async function readReportDetail(id: number): Promise<ReportPreviewResult> {
  try {
    const response = await authFetch(`/api/reports/${id}`);
    if (response.status === 404) return { state: 'not-found' };
    if (response.status === 403) return { state: 'forbidden' };
    if (!response.ok) return { state: 'unavailable' };

    const body = await response.text();
    if (!body.trim()) return { state: 'empty-response' };
    const detail = JSON.parse(body);
    if (detail?.content === null || detail?.content === '') return { state: 'no-content' };
    if (typeof detail?.content === 'string') return { state: 'ready', content: detail.content };
  } catch {
    // Keep transport and parse errors out of the report UI.
  }
  return { state: 'unavailable' };
}

export const REPORT_HISTORY_BATCH_SIZE = 100;

export async function readReportHistory(page: number): Promise<Report[]> {
  const response = await authFetch(`/api/reports?page=${page}&limit=${REPORT_HISTORY_BATCH_SIZE}`).catch(() => null);
  if (response?.status === 403) throw new Error('无权限查看报表历史。');
  const rows = response?.ok ? await response.json().catch(() => null) : null;
  if (!Array.isArray(rows)) throw new Error('暂时无法读取报表历史，请重试。');
  return rows;
}
