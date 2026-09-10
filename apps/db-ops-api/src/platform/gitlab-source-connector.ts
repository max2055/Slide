import { assertSourceContent, assertSourcePath, type SourceFile } from './source-snapshot-service.js';

export interface GitLabSourceConfig {
  baseUrl: string; projectId: string; commitSha: string; allowedPaths: string[];
  token: string; tokenExpiresAt: string;
}

export class GitLabSourceConnector {
  constructor(private readonly allowedOrigins: readonly string[], private readonly request: typeof fetch = fetch, private readonly now = Date.now) {}

  async fetchFiles(config: GitLabSourceConfig): Promise<SourceFile[]> {
    let origin: URL;
    try { origin = new URL(config.baseUrl); } catch { throw new Error('SOURCE_ORIGIN_DENIED'); }
    // The origins are operator-owned deployment configuration, never agent input.
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== '/' || !this.allowedOrigins.includes(origin.origin)) throw new Error('SOURCE_ORIGIN_DENIED');
    if (!/^[a-f0-9]{40}$/.test(config.commitSha)) throw new Error('SOURCE_COMMIT_INVALID');
    if (!/^[0-9]{1,20}$/.test(config.projectId)) throw new Error('SOURCE_PROJECT_INVALID');
    const expiry = Date.parse(config.tokenExpiresAt);
    if (!config.token || !Number.isFinite(expiry) || expiry <= this.now()) throw new Error('SOURCE_CREDENTIAL_EXPIRED');
    const deadline = Math.min(this.now() + 120_000, expiry);
    if (!Array.isArray(config.allowedPaths) || config.allowedPaths.length > 32) throw new Error('SOURCE_PATH_INVALID');
    for (const path of config.allowedPaths) {
      if (typeof path !== 'string' || !/^[A-Za-z0-9_/-]+\/$/.test(path) || path.split('/').slice(0, -1).some(part => !part || part === '..')) throw new Error('SOURCE_PATH_INVALID');
    }
    const endpoint = `${origin.origin}/api/v4/projects/${config.projectId}/repository`;
    let total = 0;
    const read = async (url: string, max: number) => {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new Error('SOURCE_SYNC_DEADLINE');
      try {
        const response = await this.request(url, { headers: { 'PRIVATE-TOKEN': config.token }, redirect: 'error', signal: AbortSignal.timeout(Math.min(15_000, remaining)) });
        if (!response.ok || !response.body) throw new Error('SOURCE_UPSTREAM_UNAVAILABLE');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            if (this.now() >= deadline) throw new Error('SOURCE_UPSTREAM_UNAVAILABLE');
            bytes += value.byteLength; total += value.byteLength;
            if (bytes > max || total > 32 * 1024 * 1024) throw new Error('SOURCE_UPSTREAM_UNAVAILABLE');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        return { text: Buffer.concat(chunks).toString('utf8'), next: response.headers.get('x-next-page') };
      } catch { throw new Error(this.now() >= deadline ? 'SOURCE_SYNC_DEADLINE' : 'SOURCE_UPSTREAM_UNAVAILABLE'); }
    };
    const commit = JSON.parse((await read(`${endpoint}/commits/${config.commitSha}`, 256 * 1024)).text);
    if (commit.id !== config.commitSha) throw new Error('SOURCE_COMMIT_MISMATCH');
    const paths: string[] = []; let page = 1;
    for (;;) {
      const response = await read(`${endpoint}/tree?ref=${config.commitSha}&recursive=true&per_page=100&page=${page}`, 256 * 1024);
      const entries = JSON.parse(response.text);
      if (!Array.isArray(entries) || entries.length > 100) throw new Error('SOURCE_TREE_INVALID');
      for (const entry of entries) {
        if (entry?.type !== 'blob' || typeof entry.path !== 'string' || (config.allowedPaths.length > 0 && !config.allowedPaths.some(path => entry.path.startsWith(path)))) continue;
        try { assertSourcePath(entry.path); } catch { continue; }
        paths.push(entry.path);
      }
      if (!response.next) break;
      if (!/^[0-9]+$/.test(response.next) || Number(response.next) !== page + 1 || page >= 100) throw new Error('SOURCE_TREE_TOO_LARGE');
      page++;
    }
    if (!paths.length || paths.length > 4000) throw new Error('SOURCE_FILE_COUNT_INVALID');
    const files: SourceFile[] = [];
    for (const path of paths) {
      const content = (await read(`${endpoint}/files/${encodeURIComponent(path)}/raw?ref=${config.commitSha}`, 512 * 1024)).text;
      assertSourceContent(content, path); files.push({ path, content });
    }
    return files;
  }
}
