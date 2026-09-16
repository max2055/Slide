import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GitSourceConnector } from './git-source-connector.js';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: async (...args: any[]) => {
    // Capture credentials before connector cleanup erases its command environment.
    args[2] = { ...args[2], env: { ...args[2].env } };
    return { stdout: run(...args) };
  } }) };
});
const config = { provider: 'gitlab' as const, baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/subgroup/project', ref: 'a'.repeat(40), token: 'fixture-token', tokenExpiresAt: '2099-01-01', allowedPaths: ['src/'] };
beforeEach(() => {
  run.mockImplementation((_command, args, options: any) => {
    if (args?.includes('checkout')) {
      mkdirSync(join(options.cwd, 'src'));
      writeFileSync(join(options.cwd, 'src/a.ts'), 'export const value = 1;');
      writeFileSync(join(options.cwd, 'excluded.ts'), 'export const excluded = 1;');
    }
    return (args?.includes('rev-parse') ? config.ref : '') as any;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); run.mockReset(); });
it.each([['github', 'owner/repo', 'x-access-token'], ['gitlab', 'group/project', 'oauth2'], ['gitlab', 'group/subgroup/project', 'oauth2']])('clones %s %s and authenticates fetch', async (provider, repositoryPath, username) => {
  const result = await new GitSourceConnector([config.baseUrl]).fetchFiles({ ...config, provider, repositoryPath } as any);
  expect(result.files.map(file => file.path)).toEqual(['src/a.ts']);
  expect(run.mock.calls.find(call => call[1]?.includes('remote'))?.[1]).toContain(`${config.baseUrl}/${repositoryPath}.git`);
  const auth = Buffer.from(`${username}:${config.token}`).toString('base64');
  for (const call of run.mock.calls.filter(call => call[1]?.includes('checkout') || call[1]?.includes('fetch'))) {
    expect(JSON.stringify(call[1])).not.toContain(auth);
    expect(JSON.stringify((call[2] as any).env)).toContain(auth);
  }
});
it.each([
  ['fatal: repository not found', 'SOURCE_REPOSITORY_NOT_FOUND'],
  ['fatal: unable to access: The requested URL returned error: 401', 'SOURCE_CREDENTIAL_INVALID'],
  ['fatal: Authentication failed', 'SOURCE_CREDENTIAL_INVALID'],
  ['fatal: remote error: upload-pack: not our ref abc', 'SOURCE_REF_NOT_FOUND'],
  ['fatal: Could not resolve host', 'SOURCE_UPSTREAM_UNAVAILABLE'],
])('classifies %s', async (stderr, code) => {
  run.mockImplementation(() => { throw Object.assign(new Error('git failed'), { stderr }); });
  await expect(new GitSourceConnector([config.baseUrl]).fetchFiles(config as any)).rejects.toThrow(code);
});
it('clears ambient proxies and credentials; explicitly configures HTTPS proxy', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://stale:9999'); vi.stubEnv('GIT_CONFIG_COUNT', '20');
  await new GitSourceConnector([config.baseUrl]).fetchFiles({ ...config, httpProxy: 'http://localhost:8000', httpsProxy: 'http://localhost:8001' } as any);
  const options: any = run.mock.calls[0][2];
  expect(options.env.HTTPS_PROXY).toBe('http://localhost:8001');
  expect(options.env.https_proxy).toBe('http://localhost:8001');
  expect(run.mock.calls[0][1]).toContain('http.proxy=http://localhost:8001');
});
it('never logs raw or encoded credentials on failure', async () => {
  const encoded = Buffer.from(`oauth2:${config.token}`).toString('base64');
  run.mockImplementation(() => { throw new Error(`Authorization: Basic ${encoded} ${config.token}`); });
  await expect(new GitSourceConnector([config.baseUrl]).fetchFiles(config as any)).rejects.toThrow();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(config.token);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(encoded);
});

it('uses an explicit deploy token username', async () => {
  await new GitSourceConnector([config.baseUrl]).fetchFiles({ ...config, gitUsername: 'gitlab+deploy-token-7' });
  expect(JSON.stringify((run.mock.calls[0][2] as any).env)).toContain(Buffer.from(`gitlab+deploy-token-7:${config.token}`).toString('base64'));
});
it('clears inherited proxies when no task proxy is configured', async () => {
  vi.stubEnv('http_proxy', 'http://stale:9999'); vi.stubEnv('HTTPS_PROXY', 'http://stale:9999');
  await new GitSourceConnector([config.baseUrl]).fetchFiles(config);
  const env = (run.mock.calls[0][2] as any).env;
  expect(env.http_proxy).toBeUndefined(); expect(env.HTTPS_PROXY).toBeUndefined();
  expect(run.mock.calls[0][1]).toContain('http.proxy=');
});
it('does not follow repository symlinks', async () => {
  const previous = run.getMockImplementation()!;
  run.mockImplementation((command, args, options: any) => {
    const result = previous(command, args, options);
    if (args?.includes('checkout')) symlinkSync(options.cwd, join(options.cwd, 'src/loop'));
    return result;
  });
  const result = await new GitSourceConnector([config.baseUrl]).fetchFiles(config);
  expect(result.files.map(file => file.path)).toEqual(['src/a.ts']);
  expect(result.skippedFiles).toEqual([{ path: 'src/loop', reason: 'SOURCE_SYMLINK_SKIPPED' }]);
});

it('defaults to remote HEAD and uses the HTTP proxy for an approved HTTP origin', async () => {
  const baseUrl = 'http://gitlab.internal';
  const result = await new GitSourceConnector([baseUrl]).fetchFiles({ ...config, baseUrl, ref: undefined,
    httpProxy: 'http://localhost:8000', httpsProxy: 'http://localhost:8001' });
  expect(result.ref).toBe('HEAD'); expect(result.commitSha).toBe(config.ref);
  const fetch = run.mock.calls.find(call => call[1].includes('fetch'))!;
  expect(fetch[1].slice(-2)).toEqual(['origin', 'HEAD']);
  expect(fetch[1]).toContain('http.proxy=http://localhost:8000');
  expect(fetch[1]).toContain('http.followRedirects=false');
  expect(fetch[2].env.GIT_ALLOW_PROTOCOL).toBe('http:https');
  expect(existsSync(fetch[2].cwd)).toBe(false);
});

it('rejects expired credentials before starting Git', async () => {
  await expect(new GitSourceConnector([config.baseUrl]).fetchFiles({ ...config, tokenExpiresAt: '2000-01-01' })).rejects.toThrow('SOURCE_CREDENTIAL_EXPIRED');
  expect(run).not.toHaveBeenCalled();
});

it('retains unscannable text for advisory scanning at publication', async () => {
  const previous = run.getMockImplementation()!;
  run.mockImplementation((command, args, options) => {
    const result = previous(command, args, options);
    if (args.includes('checkout')) writeFileSync(join(options.cwd, 'src/broken.json'), '{unscannable');
    return result;
  });
  const result = await new GitSourceConnector([config.baseUrl]).fetchFiles(config);
  expect(result.skippedFiles).toEqual([]);
  expect(result.files).toContainEqual({ path: 'src/broken.json', content: '{unscannable' });
});

it('fails when every selected file is rejected and cleans the working copy', async () => {
  const previous = run.getMockImplementation()!;
  run.mockImplementation((command, args, options) => {
    const result = previous(command, args, options);
    if (args.includes('checkout')) writeFileSync(join(options.cwd, 'src/a.ts'), '\0binary');
    return result;
  });
  await expect(new GitSourceConnector([config.baseUrl]).fetchFiles(config)).rejects.toThrow('SOURCE_FILE_COUNT_INVALID');
  expect(existsSync(run.mock.calls[0][2].cwd)).toBe(false);
});
