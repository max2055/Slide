import { test, expect, firefox, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

test('trusted HTTPS same-origin WSS authenticates, resumes without replay and withdraws revoked content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slide-investigation-tls-'));
  let env: Awaited<ReturnType<typeof startInvestigationServer>> | undefined;
  let context: BrowserContext | undefined;
  const command = (file: string, args: string[]) => execFileSync(file, args, { cwd: directory, stdio: 'pipe' });
  try {
    // Keys and NSS databases stay outside uploaded test artifacts.
    command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=Slide isolated test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', 'ca.key', '-out', 'ca.crt']);
    command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
      '-keyout', 'server.key', '-out', 'server.csr']);
    await writeFile(join(directory, 'extensions'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    command('openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-days', '1', '-extfile', 'extensions', '-out', 'server.crt']);
    env = await startInvestigationServer({ syntheticPromptTokens: 20,
      tls: { key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'server.crt')) } });
    // Negative control: same browser and endpoint, no imported CA.
    context = await firefox.launchPersistentContext(join(directory, 'untrusted'), { headless: true, timeout: 20_000, ignoreHTTPSErrors: false });
    const untrusted = await context.newPage();
    await expect(untrusted.goto(env.url)).rejects.toThrow(/SEC_ERROR_UNKNOWN_ISSUER|SSL|certificate/i);
    await context.close(); context = undefined;
    const profile = join(directory, 'trusted'); await mkdir(profile);
    command('certutil', ['-N', '--empty-password', '-d', `sql:${profile}`]);
    command('certutil', ['-A', '-d', `sql:${profile}`, '-n', 'Slide isolated test CA', '-t', 'C,,', '-i', 'ca.crt']);
    context = await firefox.launchPersistentContext(profile, { headless: true, timeout: 20_000, ignoreHTTPSErrors: false });
    await context.addInitScript(({ token, actor }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
      localStorage.setItem('permissions', JSON.stringify(actor.permissions));
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
    }, { token: env.token(), actor: env.owner });
    const page = await context.newPage(), errors: string[] = [];
    const sockets: Array<{ url: string; sent: number; received: number }> = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => {
      const record = { url: socket.url(), sent: 0, received: 0 }; sockets.push(record);
      socket.on('framesent', () => record.sent++); socket.on('framereceived', () => record.received++);
    });
    const session = await (await import('../../apps/db-ops-api/src/chat-database-service.js')).chatDatabaseService
      .createSession(env.owner, { title: '可信 TLS 普通对话' });
    await page.goto(`${env.url}/chat?session=${session.session_id}`);
    await page.locator('.agent-chat__input textarea').fill('验证可信 WSS 普通对话');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('普通对话合成回答');
    await page.goto(`${env.url}/investigations`);
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    await page.getByRole('button', { name: '创建手动调查' }).click();
    await page.getByRole('textbox', { name: '调查标题', exact: true }).fill('可信 TLS 调查');
    await page.getByRole('textbox', { name: '调查目标', exact: true }).fill('读取合成只读指标');
    await page.getByRole('textbox', { name: '资源 ID', exact: true }).fill('101');
    await page.getByRole('button', { name: '提交调查', exact: true }).click();
    await expect(page.locator('.investigation-states')).toContainText('执行完成');
    const id = new URL(page.url()).searchParams.get('investigation')!; expect(id).toBeTruthy();
    const online = () => page.evaluate(() => (document.querySelector('investigations-page') as any)?.controller?.online === true);
    await expect.poll(online).toBe(true);
    const resultCount = async () => Number((await env!.pool.query('SELECT COUNT(*) n FROM investigation_results WHERE investigation_id=?', [id]))[0][0].n);
    await expect.poll(resultCount).toBe(1);
    const callsBeforeReconnect = env.counts();
    const priorSockets = sockets.length;
    await context.setOffline(true);
    // Offline emulation alone need not close an already established TCP socket.
    env.disconnectObservers();
    await expect.poll(online).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await context.setOffline(false);
    await expect.poll(online, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => sockets.length).toBeGreaterThan(priorSockets);
    expect(env.counts()).toEqual(callsBeforeReconnect); expect(await resultCount()).toBe(1);
    await page.getByRole('textbox', { name: '继续调查', exact: true }).fill('再次读取合成指标');
    await page.getByRole('button', { name: '提交新 Run', exact: true }).click();
    await expect.poll(resultCount).toBe(2);
    expect(await page.evaluate(async id => (await fetch(`/api/investigations/${id}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })).status, id)).toBe(200);
    const agentSockets = sockets.filter(s => new URL(s.url).pathname === '/agent-ws');
    expect(agentSockets.length).toBeGreaterThanOrEqual(2);
    for (const socket of agentSockets) {
      expect(socket.url).toBe(`${env.url.replace('https:', 'wss:')}/agent-ws`);
      expect(socket.sent).toBeGreaterThan(0); expect(socket.received).toBeGreaterThan(0);
    }
    await env.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
    await expect(page.getByRole('textbox', { name: '继续调查', exact: true })).toHaveCount(0);
    expect(await page.evaluate(async id => (await fetch(`/api/investigations/${id}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })).status, id)).toBe(404);
    expect(errors).toEqual([]); expect(env.workerErrors).toEqual([]); expect(env.observationErrors).toEqual([]);
    await writeFile(test.info().outputPath('trusted-tls.json'), JSON.stringify({
      trust: 'isolated Firefox NSS CA; certificate errors enabled; untrusted profile rejected',
      secureContext: true, sameOriginWssConnections: agentSockets.length,
      ordinaryChatReply: true,
      completedResults: 2, offlineSeconds: 5, reconnectReplayed: false,
      sameJwtRevokedHttpStatus: 404, provider: 'synthetic; zero real model calls',
      topology: 'Vite TLS proxy → real Fastify/MySQL and DirectAdapter; not production Edge qualification',
    }, null, 2));
  } finally {
    try { await context?.close(); } finally {
      try { await env?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
});
