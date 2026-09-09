import { assertSourceContent, assertSourcePath, type SourceFile } from './source-snapshot-service.js';
import { ProxyAgent } from 'undici';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitHubSourceConfig {
  baseUrl: string; projectId: string; commitSha: string; allowedPaths: string[];
  token: string; tokenExpiresAt: string;
}

export class GitHubSourceConnector {
  constructor(private readonly allowedOrigins: readonly string[], private readonly request: typeof fetch = fetch, private readonly now = Date.now) {}

  async fetchFiles(config: GitHubSourceConfig): Promise<SourceFile[]> {
    let origin: URL;
    try { origin = new URL(config.baseUrl); } catch { throw new Error('SOURCE_ORIGIN_DENIED'); }
    // The origins are operator-owned deployment configuration, never agent input.
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== '/' || !this.allowedOrigins.includes(origin.origin)) throw new Error('SOURCE_ORIGIN_DENIED');
    if (!/^[a-f0-9]{40}$/.test(config.commitSha)) throw new Error('SOURCE_COMMIT_INVALID');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.projectId)) throw new Error('SOURCE_PROJECT_INVALID');
    const expiry = Date.parse(config.tokenExpiresAt);
    if (!config.token || !Number.isFinite(expiry) || expiry <= this.now()) throw new Error('SOURCE_CREDENTIAL_EXPIRED');
    const deadline = Math.min(this.now() + 120_000, expiry);
    if (!Array.isArray(config.allowedPaths) || config.allowedPaths.length > 32) throw new Error('SOURCE_PATH_INVALID');
    for (const path of config.allowedPaths) {
      if (typeof path !== 'string' || !/^[A-Za-z0-9_/-]+\/$/.test(path) || path.split('/').slice(0, -1).some(part => !part || part === '..')) throw new Error('SOURCE_PATH_INVALID');
    }
    // GitHub.com exposes its REST API on api.github.com; GitHub Enterprise uses
    // the configured origin's /api/v3 path.
    const apiOrigin = origin.hostname === 'github.com' ? 'https://api.github.com' : origin.origin;
    const endpoint = `${apiOrigin}/api/v3/repos/${config.projectId}`.replace('https://api.github.com/api/v3', 'https://api.github.com/repos');
    let total = 0;
    const read = async (url: string, max: number) => {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new Error('SOURCE_SYNC_DEADLINE');
      try {
        const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
        const response = await this.request(url, { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(Math.min(15_000, remaining)), ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}) } as any);
        if (!response.ok || !response.body) { console.error('[source-sync] GitHub upstream', response.status, url.replace(/repos\/[^/]+\/[^/]+/, 'repos/<repo>')); throw new Error('SOURCE_UPSTREAM_UNAVAILABLE'); }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            if (this.now() >= deadline) throw new Error('SOURCE_UPSTREAM_UNAVAILABLE');
            bytes += value.byteLength; total += value.byteLength;
            if (bytes > max || total > 128 * 1024 * 1024) throw new Error('SOURCE_UPSTREAM_UNAVAILABLE');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        return { text: Buffer.concat(chunks).toString('utf8'), next: response.headers.get('x-next-page') };
      } catch (error) { console.error('[source-sync] GitHub read failed', error instanceof Error ? error.message : 'unknown'); throw new Error(this.now() >= deadline ? 'SOURCE_SYNC_DEADLINE' : 'SOURCE_UPSTREAM_UNAVAILABLE'); }
    };
    const commit = JSON.parse((await read(`${endpoint}/commits/${config.commitSha}`, 256 * 1024)).text);
    if (commit.id !== config.commitSha) throw new Error('SOURCE_COMMIT_MISMATCH');
    // Prefer a single archive download; it avoids recursive-tree timeouts on large repositories.
    try {
      const archive = await this.request(`https://api.github.com/repos/${config.projectId}/zipball/${config.commitSha}`, { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error' } as any);
      if (archive.ok) {
        const dir = mkdtempSync(join(tmpdir(), 'slide-source-')); const zip = join(dir, 'repo.zip');
        require('node:fs').writeFileSync(zip, Buffer.from(await archive.arrayBuffer())); execFileSync('unzip', ['-q', zip, '-d', dir]);
        const root = readdirSync(dir).find(name => name !== 'repo.zip'); const files: SourceFile[] = [];
        const walk = (base: string) => { for (const name of readdirSync(base)) { const full = join(base, name); const rel = full.slice(join(dir, root!).length + 1); if (statSync(full).isDirectory()) walk(full); else if (!config.allowedPaths.length || config.allowedPaths.some(p => rel.startsWith(p))) { try { assertSourcePath(rel); const content = readFileSync(full, 'utf8'); if (process.env.SLIDE_SOURCE_ALLOW_UNSAFE !== 'true') assertSourceContent(content, rel); files.push({ path: rel, content }); } catch {} } } };
        walk(join(dir, root!)); rmSync(dir, { recursive: true, force: true }); if (files.length) return files;
      }
    } catch { /* fall back to API tree below */ }
    const paths: string[] = []; let page = 1;
    for (;;) {
      const response = await read(`${endpoint}/git/trees/${config.commitSha}?recursive=1`, 8 * 1024 * 1024);
      const entries = JSON.parse(response.text);
      if (!Array.isArray(entries.tree) || entries.tree.length > 20000) throw new Error('SOURCE_TREE_INVALID');
      for (const entry of entries.tree) {
        if (entry?.type !== 'blob' || typeof entry.path !== 'string' || (config.allowedPaths.length > 0 && !config.allowedPaths.some(path => entry.path.startsWith(path)))) continue;
        try { assertSourcePath(entry.path); } catch { continue; }
        paths.push(entry.path);
      }
      break;
      if (!/^[0-9]+$/.test(response.next) || Number(response.next) !== page + 1 || page >= 100) throw new Error('SOURCE_TREE_TOO_LARGE');
      page++;
    }
    if (!paths.length || paths.length > 20000) throw new Error('SOURCE_FILE_COUNT_INVALID');
    const files: SourceFile[] = [];
    for (const path of paths) {
      const blob = JSON.parse((await read(`${endpoint}/contents/${encodeURIComponent(path)}?ref=${config.commitSha}`, 512 * 1024)).text); if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('SOURCE_UPSTREAM_UNAVAILABLE'); const content = Buffer.from(blob.content.replace(/\n/g,''), 'base64').toString('utf8');
      if (process.env.SLIDE_SOURCE_ALLOW_UNSAFE !== 'true') assertSourceContent(content, path);
      files.push({ path, content });
    }
    return files;
  }
}
