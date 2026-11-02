import { execFileSync } from 'node:child_process';

/** Authorized member reference only. Never return the source comment to a logger. */
export function vendorCredentials() {
  let rows: any[];
  try { rows = JSON.parse(execFileSync('multica', ['issue', 'comment', 'list',
    '01a173ce-91a2-70bf-bf33-a51f0cde67e3', '--thread', '01a19b58-8a36-7a30-9662-f39c97c4406e',
    '--tail', '30', '--compact', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { throw Error('AUTHORIZATION_REFERENCE_UNAVAILABLE'); }
  const row = rows.find((r: any) => r.id === '01a19b58-8a36-7a30-9662-f39c97c4406e');
  if (row?.author_type !== 'member' || row.author_id !== '4a55abf1-f636-4587-a985-3faa44aa0287') throw Error('AUTHORIZATION_REFERENCE_MISMATCH');
  const result = {} as Record<'oracle' | 'dameng', { user: string; password: string }>;
  for (const engine of ['oracle', 'dameng'] as const) {
    const line = row.content.split('\n').find((l: string) => engine === 'oracle' ? /oracle/i.test(l) : /达梦/.test(l));
    const user = line?.match(/(?:用户名|用户|账号)\s*(?:是|为|[:：=])?\s*([A-Za-z0-9_$#]+)/)?.[1];
    const password = line?.match(/密码\s*(?:是|为|[:：=])?\s*([^\s，,；;。]+)/)?.[1];
    if (!user || !password) throw Error('CREDENTIAL_FORMAT_UNRECOGNIZED_' + engine);
    result[engine] = { user, password };
  }
  return result;
}
