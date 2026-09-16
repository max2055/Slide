import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { assertRepositoryPath } from './source-repository-path.js';
import { sourceOrigin, sourceRef } from './source-policy.js';
import { assertSourceContent, assertSourcePath, MAX_FILE_BYTES, MAX_FILES, MAX_SNAPSHOT_BYTES, type SourceFile, type SkippedSourceFile } from './source-snapshot-service.js';

const run = promisify(execFile);
export interface GitSourceConfig {
  provider: 'github' | 'gitlab'; baseUrl: string; repositoryPath: string; gitUsername?: string; ref?: string;
  allowedPaths: string[]; token: string; tokenExpiresAt: string;
  httpProxy?: string; httpsProxy?: string; allProxy?: string;
}

export class GitSourceConnector {
  constructor(private readonly allowedOrigins: readonly string[], private readonly scratchRoot = tmpdir()) {}
  async fetchFiles(config: GitSourceConfig) {
    const origin = sourceOrigin(config.baseUrl, this.allowedOrigins);
    assertRepositoryPath(config.repositoryPath, config.provider);
    const ref = sourceRef(config.ref);
    const expiry = Date.parse(config.tokenExpiresAt);
    if (!config.token || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('SOURCE_CREDENTIAL_EXPIRED');
    const username = config.provider === 'github' ? 'x-access-token' : config.gitUsername || 'oauth2';
    if (!/^[A-Za-z0-9_.@+-]+$/.test(username)) throw new Error('SOURCE_CONFIG_INVALID');
    const deadline = Math.min(expiry, Date.now() + 120_000);
    const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new Error('SOURCE_SYNC_DEADLINE'); return ms; };
    await mkdir(this.scratchRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(this.scratchRoot, '.slide-git-source-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(?:https?|all|no)_proxy$/i.test(key) || /^GIT_/i.test(key)) delete env[key];
    }
    for (const [key, value] of [['HTTP_PROXY', config.httpProxy], ['HTTPS_PROXY', config.httpsProxy], ['ALL_PROXY', config.allProxy]] as const) {
      if (value) { env[key] = value; env[key.toLowerCase()] = value; }
    }
    // Ignore ambient URL rewrites, proxy settings, credential helpers and templates.
    env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_ALLOW_PROTOCOL = 'http:https';
    const proxyArgs = ['-c', 'http.proxy=' + ((origin.protocol === 'https:' ? config.httpsProxy : config.httpProxy) || config.allProxy || ''),
      '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir='];
    // Command-scoped environment keeps the token out of argv and repository config.
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = 'http.' + origin.origin + '/.extraHeader';
    env.GIT_CONFIG_VALUE_0 = 'Authorization: Basic ' + Buffer.from(username + ':' + config.token).toString('base64');
    env.GIT_CONFIG_KEY_1 = 'credential.helper'; env.GIT_CONFIG_VALUE_1 = '';
    const git = async (args: string[]) => (await run('git', [...proxyArgs, ...args], { cwd: dir, env, encoding: 'utf8', timeout: remaining(), maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
    let stage = 'fetch'; const startedAt = Date.now(); let stageStartedAt = startedAt;
    const reportStage = () => {
      const now = Date.now();
      console.info('[source-sync:git]', { stage, elapsedMs: now - startedAt, stageMs: now - stageStartedAt });
      stageStartedAt = now;
    };
    try {
      await git(['init']);
      await git(['remote', 'add', 'origin', origin.origin + '/' + config.repositoryPath + '.git']);
      // Fetch an advertised ref by default; arbitrary SHA fetching is opt-in via ref.
      await git(['fetch', '--depth=1', '--no-tags', 'origin', ref]);
      reportStage(); stage = 'commit';
      const commitSha = await git(['rev-parse', 'FETCH_HEAD^{commit}']);
      if (!/^[a-f0-9]{40}$/.test(commitSha) || (/^[a-f0-9]{40}$/.test(ref) && ref !== commitSha)) throw new Error('SOURCE_COMMIT_MISMATCH');
      reportStage();
      stage = 'checkout';
      await git(['checkout', '--detach', commitSha]);
      if (await git(['rev-parse', 'HEAD']) !== commitSha) throw new Error('SOURCE_COMMIT_MISMATCH');
      reportStage();
      stage = 'scan';
      const files: SourceFile[] = []; const skippedFiles: SkippedSourceFile[] = [];
      let total = 0; let entries = 0;
      const walk = async (base: string): Promise<void> => {
        for (const name of (await readdir(base)).sort()) {
          remaining(); if (name === '.git') continue;
          const full = join(base, name); const path = relative(dir, full).replaceAll('\\', '/');
          const selected = !config.allowedPaths.length || config.allowedPaths.some(prefix => path.startsWith(prefix));
          const parent = config.allowedPaths.some(prefix => prefix.startsWith(path + '/'));
          if (!selected && !parent) continue;
          if (++entries > MAX_FILES) throw new Error('SOURCE_FILE_COUNT_INVALID');
          const stat = await lstat(full);
          if (stat.isSymbolicLink()) { skippedFiles.push({ path, reason: 'SOURCE_SYMLINK_SKIPPED' }); continue; }
          if (stat.isDirectory()) {
            if (name.startsWith('.') || /^(node_modules|dist|coverage|secrets)$/i.test(name)) {
              skippedFiles.push({ path, reason: 'SOURCE_PATH_INVALID' }); continue;
            }
            await walk(full); continue;
          }
          if (!selected) continue;
          let content: string;
          try {
            assertSourcePath(path);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('SOURCE_FILE_TOO_LARGE');
            content = await readFile(full, 'utf8'); assertSourceContent(content, path);
          } catch (error) {
            const reason = error instanceof Error ? error.message : '';
            if (!['SOURCE_PATH_INVALID', 'SOURCE_FILE_TOO_LARGE', 'SOURCE_SENSITIVE_CONTENT', 'SOURCE_CONFIG_UNSCANNABLE'].includes(reason)) throw error;
            skippedFiles.push({ path, reason }); continue;
          }
          total += Buffer.byteLength(content);
          if (total > MAX_SNAPSHOT_BYTES) throw new Error('SOURCE_SNAPSHOT_TOO_LARGE');
          files.push({ path, content });
        }
      };
      await walk(dir);
      if (!files.length) throw new Error('SOURCE_FILE_COUNT_INVALID');
      reportStage();
      return { commitSha, ref, files, skippedFiles };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : '';
      const diagnostic = message + ' ' + stderr;
      const code = /^SOURCE_[A-Z_]+$/.test(message) ? message
        : /authentication failed|invalid credentials|HTTP Basic: Access denied|bad credentials|returned error: (401|403)|could not read Username/i.test(diagnostic) ? 'SOURCE_CREDENTIAL_INVALID'
        : /repository.*(?:not found|does not exist)|project.*(?:not found|could not be found)|returned error: 404/i.test(diagnostic) ? 'SOURCE_REPOSITORY_NOT_FOUND'
        : /pathspec|not our ref|couldn.t find remote ref|unadvertised object|reference is not a tree|bad object/i.test(diagnostic) ? 'SOURCE_REF_NOT_FOUND'
        : Date.now() >= deadline ? 'SOURCE_SYNC_DEADLINE'
        : /timed out|timeout|ETIMEDOUT|Could not resolve|Failed to connect|unable to access|Proxy CONNECT|SSL certificate|redirect|returned error: 30[1278]/i.test(diagnostic) ? 'SOURCE_UPSTREAM_UNAVAILABLE'
        : 'SOURCE_SYNC_FAILED';
      console.error('[source-sync:git]', { stage, elapsedMs: Date.now() - startedAt, errorCode: code });
      throw new Error(code);
    } finally {
      delete env.GIT_CONFIG_VALUE_0;
      await rm(dir, { recursive: true, force: true });
    }
  }
}
