import { describe, expect, it, vi } from 'vitest';
import { GitLabSourceConnector } from './gitlab-source-connector.js';

const sha = 'a'.repeat(40);
const config = { baseUrl: 'https://gitlab.example.test', projectId: '7', commitSha: sha, allowedPaths: ['src/'], token: 'fixture-token', tokenExpiresAt: '2030-01-01T00:00:00Z' };
describe('GitLab source connector', () => {
  it('stops the whole sync when its deadline is exhausted', async () => {
    let now = Date.now();
    const request = vi.fn(async () => { now += 121_000; return new Response(JSON.stringify({ id: sha })); });
    const connector = new GitLabSourceConnector([config.baseUrl], request as typeof fetch, () => now);
    await expect(connector.fetchFiles(config)).rejects.toThrow('SOURCE_SYNC_DEADLINE');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('pins each request and filters paths before downloading blobs', async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error'); expect(new URL(url).origin).toBe(config.baseUrl);
      if (url.includes('/commits/')) return new Response(JSON.stringify({ id: sha }));
      if (url.includes('/tree?')) return new Response(JSON.stringify([{ type: 'blob', path: 'src/ok.ts' }, { type: 'blob', path: '.env' }]), { headers: { 'x-next-page': '' } });
      expect(url).toContain(`ref=${sha}`); return new Response('export const ok = true;');
    });
    const connector = new GitLabSourceConnector([config.baseUrl], request as typeof fetch);
    expect(await connector.fetchFiles(config)).toEqual([{ path: 'src/ok.ts', content: 'export const ok = true;' }]);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('rejects unapproved origins, mutable branches, expired credentials before network', async () => {
    const request = vi.fn(); const connector = new GitLabSourceConnector([config.baseUrl], request);
    await expect(connector.fetchFiles({ ...config, baseUrl: 'https://other.example.test' })).rejects.toThrow('SOURCE_ORIGIN_DENIED');
    await expect(connector.fetchFiles({ ...config, commitSha: 'main' })).rejects.toThrow('SOURCE_COMMIT_INVALID');
    await expect(connector.fetchFiles({ ...config, tokenExpiresAt: '2000-01-01T00:00:00Z' })).rejects.toThrow('SOURCE_CREDENTIAL_EXPIRED');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects mismatched commit and never echoes upstream response bodies', async () => {
    const connector = new GitLabSourceConnector([config.baseUrl], vi.fn(async () => new Response(JSON.stringify({ id: 'b'.repeat(40) }))) as typeof fetch);
    await expect(connector.fetchFiles(config)).rejects.toThrow('SOURCE_COMMIT_MISMATCH');
    const failing = new GitLabSourceConnector([config.baseUrl], vi.fn(async () => new Response('secret upstream detail', { status: 403 })) as typeof fetch);
    await expect(failing.fetchFiles(config)).rejects.toThrow(/^SOURCE_UPSTREAM_UNAVAILABLE$/);
  });
});
