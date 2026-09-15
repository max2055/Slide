import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GitSourceConnector } from './git-source-connector.js';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const run = vi.mocked(execFileSync);
const config = { provider: 'gitlab' as const, baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/subgroup/project', commitSha: 'a'.repeat(40), token: 'fixture-token', tokenExpiresAt: '2099-01-01', allowedPaths: ['src/'] };
beforeEach(() => {
  run.mockImplementation((_command, args, options: any) => {
    if (args?.includes('clone')) {
      mkdirSync(join(options.cwd, 'src'));
      writeFileSync(join(options.cwd, 'src/a.ts'), 'export const value = 1;');
      writeFileSync(join(options.cwd, 'excluded.ts'), 'export const excluded = 1;');
    }
    return (args?.includes('rev-parse') ? config.commitSha : '') as any;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); run.mockReset(); });
it.each([['github', 'owner/repo', 'x-access-token'], ['gitlab', 'group/project', 'oauth2'], ['gitlab', 'group/subgroup/project', 'oauth2']])('clones %s %s and authenticates fetch', (provider, repositoryPath, username) => {
  const files = new GitSourceConnector([config.baseUrl]).fetchFiles({ ...config, provider, repositoryPath } as any);
  expect(files.map(file => file.path)).toEqual(['src/a.ts']);
  expect(run.mock.calls.find(call => call[1]?.includes('clone'))?.[1]).toContain(`${config.baseUrl}/${repositoryPath}.git`);
  const auth = Buffer.from(`${username}:${config.token}`).toString('base64');
  for (const call of run.mock.calls.filter(call => call[1]?.includes('clone') || call[1]?.includes('fetch'))) {
    expect(JSON.stringify(call[1])).not.toContain(auth);
    expect(JSON.stringify((call[2] as any).env)).toContain(auth);
  }
});
it.each([
  ['fatal: repository not found', 'SOURCE_REPOSITORY_NOT_FOUND'],
  ['fatal: unable to access: The requested URL returned error: 401', 'SOURCE_CREDENTIAL_INVALID'],
  ['fatal: Authentication failed', 'SOURCE_CREDENTIAL_INVALID'],
  ['fatal: remote error: upload-pack: not our ref abc', 'SOURCE_COMMIT_MISMATCH'],
  ['fatal: Could not resolve host', 'SOURCE_UPSTREAM_UNAVAILABLE'],
])('classifies %s', (stderr, code) => {
  run.mockImplementation(() => { throw Object.assign(new Error('git failed'), { stderr }); });
  expect(() => new GitSourceConnector([config.baseUrl]).fetchFiles(config as any)).toThrow(code);
});
it('clears ambient proxies and credentials; explicitly configures HTTPS proxy', () => {
  vi.stubEnv('HTTPS_PROXY', 'http://stale:9999'); vi.stubEnv('GIT_CONFIG_COUNT', '20');
  new GitSourceConnector([config.baseUrl]).fetchFiles({ ...config, httpProxy: 'http://localhost:8000', httpsProxy: 'http://localhost:8001' } as any);
  const options: any = run.mock.calls[0][2];
  expect(options.env.HTTPS_PROXY).toBe('http://localhost:8001');
  expect(options.env.https_proxy).toBe('http://localhost:8001');
  expect(run.mock.calls[0][1]).toContain('http.proxy=http://localhost:8001');
});
it('never logs raw or encoded credentials on failure', () => {
  const encoded = Buffer.from(`oauth2:${config.token}`).toString('base64');
  run.mockImplementation(() => { throw new Error(`Authorization: Basic ${encoded} ${config.token}`); });
  expect(() => new GitSourceConnector([config.baseUrl]).fetchFiles(config as any)).toThrow();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(config.token);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(encoded);
});

it('uses an explicit deploy token username', () => {
  new GitSourceConnector([config.baseUrl]).fetchFiles({ ...config, gitUsername: 'gitlab+deploy-token-7' });
  expect(JSON.stringify((run.mock.calls[0][2] as any).env)).toContain(Buffer.from(`gitlab+deploy-token-7:${config.token}`).toString('base64'));
});
it('clears inherited proxies when no task proxy is configured', () => {
  vi.stubEnv('http_proxy', 'http://stale:9999'); vi.stubEnv('HTTPS_PROXY', 'http://stale:9999');
  new GitSourceConnector([config.baseUrl]).fetchFiles(config);
  const env = (run.mock.calls[0][2] as any).env;
  expect(env.http_proxy).toBeUndefined(); expect(env.HTTPS_PROXY).toBeUndefined();
  expect(run.mock.calls[0][1]).toContain('http.proxy=');
});
it('does not follow repository symlinks', () => {
  const previous = run.getMockImplementation()!;
  run.mockImplementation((command, args, options: any) => {
    const result = previous(command, args, options);
    if (args?.includes('clone')) symlinkSync(options.cwd, join(options.cwd, 'src/loop'));
    return result;
  });
  expect(new GitSourceConnector([config.baseUrl]).fetchFiles(config).map(file => file.path)).toEqual(['src/a.ts']);
});
