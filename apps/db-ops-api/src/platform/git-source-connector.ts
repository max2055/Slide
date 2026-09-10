import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { assertSourceContent, assertSourcePath, type SourceFile } from './source-snapshot-service.js';

export interface GitSourceConfig {
  provider: 'github' | 'gitlab'; baseUrl: string; projectId: string; commitSha: string;
  allowedPaths: string[]; token: string; tokenExpiresAt: string;
  httpProxy?: string; httpsProxy?: string; allProxy?: string;
}

export class GitSourceConnector {
  constructor(private readonly allowedOrigins: readonly string[]) {}
  fetchFiles(config: GitSourceConfig): SourceFile[] {
    const origin = new URL(config.baseUrl);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || !this.allowedOrigins.includes(origin.origin)) throw new Error('SOURCE_ORIGIN_DENIED');
    if (!/^[a-f0-9]{40}$/.test(config.commitSha) || !config.token || Date.parse(config.tokenExpiresAt) <= Date.now()) throw new Error('SOURCE_CREDENTIAL_EXPIRED');
    const repo = config.provider === 'github' ? `${origin.origin}/${config.projectId}.git` : `${origin.origin}/${config.projectId}.git`;
    const dir = mkdtempSync(join(tmpdir(), 'slide-git-source-'));
    const env = { ...process.env, ...(config.httpProxy ? { HTTP_PROXY: config.httpProxy } : {}), ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy } : {}), ...(config.allProxy ? { ALL_PROXY: config.allProxy } : {}) };
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    try {
      execFileSync('git', ['-c', `http.extraHeader=Authorization: Bearer ${config.token}`, 'clone', '--no-checkout', '--filter=blob:none', '--depth=1', repo, '.'], { cwd: dir, env, timeout: 120_000, stdio: 'pipe' });
      git(['fetch', '--depth=1', 'origin', config.commitSha]); git(['checkout', '--detach', config.commitSha]);
      const files: SourceFile[] = [];
      const walk = (base: string) => { for (const name of readdirSync(base)) { if (name === '.git') continue; const full = join(base, name); const path = relative(dir, full).replaceAll('\\', '/'); if (statSync(full).isDirectory()) walk(full); else if ((!config.allowedPaths.length || config.allowedPaths.some(prefix => path.startsWith(prefix))) && (() => { try { assertSourcePath(path); return true; } catch { return false; } })()) { const content = readFileSync(full, 'utf8'); if (process.env.SLIDE_SOURCE_ALLOW_UNSAFE !== 'true') assertSourceContent(content, path); files.push({ path, content }); } } };
      walk(dir); if (!files.length) throw new Error('SOURCE_FILE_COUNT_INVALID'); return files;
    } catch (error) { const message = error instanceof Error ? error.message : ''; if (/timed out|timeout|Could not resolve host|Failed to connect|unable to access/i.test(message)) throw new Error('SOURCE_UPSTREAM_UNAVAILABLE'); if (/pathspec|not found|does not exist/i.test(message)) throw new Error('SOURCE_COMMIT_MISMATCH'); throw error; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
