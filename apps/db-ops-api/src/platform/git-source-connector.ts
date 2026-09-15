import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Buffer } from 'node:buffer';
import { assertRepositoryPath } from './source-repository-path.js';
import { assertSourceContent, assertSourcePath, type SourceFile } from './source-snapshot-service.js';

export interface GitSourceConfig {
  provider: 'github' | 'gitlab'; baseUrl: string; repositoryPath: string; gitUsername?: string; commitSha: string;
  allowedPaths: string[]; token: string; tokenExpiresAt: string;
  httpProxy?: string; httpsProxy?: string; allProxy?: string;
}

export class GitSourceConnector {
  constructor(private readonly allowedOrigins: readonly string[]) {}
  fetchFiles(config: GitSourceConfig): SourceFile[] {
    const origin = new URL(config.baseUrl);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !this.allowedOrigins.includes(origin.origin)) throw new Error('SOURCE_ORIGIN_DENIED');
    assertRepositoryPath(config.repositoryPath, config.provider);
    if (!/^[a-f0-9]{40}$/.test(config.commitSha)) throw new Error('SOURCE_COMMIT_MISMATCH');
    if (!config.token || !Number.isFinite(Date.parse(config.tokenExpiresAt)) || Date.parse(config.tokenExpiresAt) <= Date.now()) throw new Error('SOURCE_CREDENTIAL_EXPIRED');
    const username = config.provider === 'github' ? 'x-access-token' : config.gitUsername || 'oauth2';
    if (!/^[A-Za-z0-9_.@+-]+$/.test(username)) throw new Error('SOURCE_CONFIG_INVALID');
    const repo = `${origin.origin}/${config.repositoryPath}.git`;
    const dir = mkdtempSync(join(tmpdir(), 'slide-git-source-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(?:https?|all|no)_proxy$/i.test(key) || /^GIT_/i.test(key)) delete env[key];
    }
    for (const [key, value] of [['HTTP_PROXY', config.httpProxy], ['HTTPS_PROXY', config.httpsProxy], ['ALL_PROXY', config.allProxy]] as const) {
      if (value) { env[key] = value; env[key.toLowerCase()] = value; }
    }
    // Ignore ambient Git config (URL rewrites, proxy settings and credential helpers).
    env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_TERMINAL_PROMPT = '0';
    const proxyArgs = ['-c', `http.proxy=${config.httpsProxy || config.httpProxy || config.allProxy || ''}`];
    const authorization = `Basic ${Buffer.from(`${username}:${config.token}`).toString('base64')}`;
    // Command-scoped environment keeps the token out of argv and repository config.
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = `http.${origin.origin}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${authorization}`;
    env.GIT_CONFIG_KEY_1 = 'credential.helper'; env.GIT_CONFIG_VALUE_1 = '';
    const git = (args: string[]) => execFileSync('git', [...proxyArgs, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 120_000, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
    try {
      git(['clone', '--no-checkout', '--depth=1', repo, '.']);
      git(['fetch', '--depth=1', 'origin', config.commitSha]); git(['checkout', '--detach', config.commitSha]);
      if (git(['rev-parse', 'HEAD']).trim() !== config.commitSha) throw new Error('SOURCE_COMMIT_MISMATCH');
      const files: SourceFile[] = [];
      const walk = (base: string) => { for (const name of readdirSync(base)) { if (name === '.git') continue; const full = join(base, name); const path = relative(dir, full).replaceAll('\\', '/'); if (lstatSync(full).isSymbolicLink()) continue; if (lstatSync(full).isDirectory()) walk(full); else if ((!config.allowedPaths.length || config.allowedPaths.some(prefix => path.startsWith(prefix))) && (() => { try { assertSourcePath(path); return true; } catch { return false; } })()) { const content = readFileSync(full, 'utf8'); if (process.env.SLIDE_SOURCE_ALLOW_UNSAFE !== 'true') assertSourceContent(content, path); files.push({ path, content }); } } };
      walk(dir); if (!files.length) throw new Error('SOURCE_FILE_COUNT_INVALID'); return files;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : '';
      const diagnostic = `${message} ${stderr}`;
      const code = /authentication failed|invalid credentials|HTTP Basic: Access denied|bad credentials|returned error: (401|403)|could not read Username/i.test(diagnostic) ? 'SOURCE_CREDENTIAL_INVALID'
        : /repository.*(?:not found|does not exist)|project.*(?:not found|could not be found)|returned error: 404/i.test(diagnostic) ? 'SOURCE_REPOSITORY_NOT_FOUND'
        : /pathspec|not our ref|couldn.t find remote ref|unadvertised object|reference is not a tree|bad object/i.test(diagnostic) ? 'SOURCE_COMMIT_MISMATCH'
        : /timed out|timeout|ETIMEDOUT|Could not resolve|Failed to connect|unable to access|Proxy CONNECT|SSL certificate/i.test(diagnostic) ? 'SOURCE_UPSTREAM_UNAVAILABLE'
        : /^SOURCE_[A-Z_]+$/.test(message) ? message : 'SOURCE_SYNC_FAILED';
      console.error('[source-sync] Git transport failed', code);
      throw new Error(code);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
