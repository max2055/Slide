import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apiURL, webBaseURL } from '../e2e/targets';

const apiRoot = resolve(import.meta.dirname, '..');
const specPaths = ['e2e/auth.spec.ts', 'e2e/settings.spec.ts'].map((file) => resolve(apiRoot, file));
const envKeys = ['SLIDE_E2E_BASE_URL', 'SLIDE_E2E_API_URL'] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

type Hit = { port: number; host: string; method: string; url: string };

function restoreEnv() {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

afterEach(() => {
  restoreEnv();
});

function calls(source: string, file: string) {
  const pages: string[] = [];
  const apis: string[] = [];
  for (const match of source.matchAll(/page\.goto\(\s*([^,)]+)/g)) {
    const literal = match[1].trim().match(/^(['"])(\/[^'"]*)\1$/);
    if (!literal) throw new Error(`${file} page.goto must be a relative string literal, got ${match[1].trim()}`);
    pages.push(literal[2]);
  }
  for (const match of source.matchAll(/apiURL\(\s*([^,)]+)/g)) {
    const literal = match[1].trim().match(/^(['"])(\/[^'"]*)\1$/);
    if (!literal) throw new Error(`${file} apiURL must be a relative string literal, got ${match[1].trim()}`);
    apis.push(literal[2]);
  }
  if (/https?:\/\//.test(source)) throw new Error(`${file} still contains an absolute URL`);
  if (/\blocalhost:(5173|3000)\b/.test(source)) throw new Error(`${file} still names a default worktree port`);
  return { pages, apis };
}

function specCalls() {
  const pages: string[] = [];
  const apis: string[] = [];
  for (const file of specPaths) {
    const found = calls(readFileSync(file, 'utf8'), file);
    pages.push(...found.pages);
    apis.push(...found.apis);
  }
  return { pages: [...new Set(pages)], apis: [...new Set(apis)] };
}

async function listen(record: Hit[]) {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 0;
    record.push({
      port,
      host: request.headers.host ?? '',
      method: request.method ?? '',
      url: request.url ?? '',
    });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>max301</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('recorder did not bind a TCP port');
  if (address.port === 5173 || address.port === 3000) {
    server.close();
    throw new Error(`refusing well-known port ${address.port}`);
  }
  return { server, origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function loadConfig(stamp: string) {
  const href = new URL(`../playwright.config.ts?max301=${stamp}`, import.meta.url).href;
  const loaded = await import(href);
  return loaded.default as { use?: { baseURL?: string } };
}

describe('MAX-301 API e2e base URL', () => {
  it('keeps the local defaults and rejects an invalid override', async () => {
    delete process.env.SLIDE_E2E_BASE_URL;
    delete process.env.SLIDE_E2E_API_URL;
    expect(webBaseURL()).toBe('http://localhost:5173');
    expect(apiURL('/api/health')).toBe('http://localhost:3000/api/health');
    const config = await loadConfig(`default-${Date.now()}`);
    expect(config.use?.baseURL).toBe('http://localhost:5173');

    process.env.SLIDE_E2E_BASE_URL = 'not a url';
    await expect(loadConfig(`invalid-${Date.now()}`)).rejects.toThrow(/SLIDE_E2E_BASE_URL/);
    expect(() => webBaseURL()).toThrow(/SLIDE_E2E_BASE_URL/);
  });

  it('sends spec navigation and API calls to the configured isolated origins', async () => {
    const hits: Hit[] = [];
    const web = await listen(hits);
    const api = await listen(hits);
    const { pages, apis } = specCalls();
    expect(pages).toEqual(expect.arrayContaining(['/', '/dashboard', '/settings', '/alerts', '/reports', '/metric-registry', '/cron-jobs']));
    expect(apis).toEqual(expect.arrayContaining([
      '/api/llm/configs',
      '/api/database/instances/1/tables',
      '/api/dashboard/ai-stats',
      '/api/health',
    ]));

    process.env.SLIDE_E2E_BASE_URL = web.origin;
    process.env.SLIDE_E2E_API_URL = api.origin;
    const config = await loadConfig(`isolated-${web.port}-${api.port}`);
    expect(config.use?.baseURL).toBe(web.origin);
    expect(apiURL('/api/health')).toBe(`${api.origin}/api/health`);

    const seen = new Set<string>();
    let transport = 'playwright-request';
    const { request: playwrightRequest, chromium } = await import('@playwright/test');
    const webContext = await playwrightRequest.newContext({ baseURL: config.use?.baseURL });
    const apiContext = await playwrightRequest.newContext();
    try {
      for (const path of pages) {
        const response = await webContext.get(path);
        expect(response.status()).toBe(200);
        expect(new URL(response.url()).origin).toBe(web.origin);
        seen.add(`request ${response.url()}`);
      }
      for (const path of apis) {
        const response = await apiContext.get(apiURL(path));
        expect(response.status()).toBe(200);
        expect(response.url()).toBe(`${api.origin}${path}`);
        seen.add(`request ${response.url()}`);
      }

      try {
        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({ baseURL: config.use?.baseURL });
          const page = await context.newPage();
          page.on('request', (item) => seen.add(`page ${item.url()}`));
          for (const path of pages) await page.goto(path, { waitUntil: 'commit' });
          transport = 'page.goto';
          await context.close();
        } finally {
          await browser.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Executable doesn't exist|Please run the following command/.test(message) || process.env.CI !== 'true') throw error;
      }
    } finally {
      await webContext.dispose();
      await apiContext.dispose();
      web.server.closeAllConnections();
      api.server.closeAllConnections();
      web.server.close();
      api.server.close();
      await Promise.all([once(web.server, 'close'), once(api.server, 'close')]);
    }

    const pageHits = hits.filter((hit) => hit.port === web.port);
    const apiHits = hits.filter((hit) => hit.port === api.port);
    expect(pages.every((path) => pageHits.some((hit) => hit.url.split('?')[0] === path))).toBe(true);
    expect(apis.every((path) => apiHits.some((hit) => hit.url.split('?')[0] === path))).toBe(true);
    expect(hits.every((hit) => hit.port === web.port || hit.port === api.port)).toBe(true);
    expect(hits.some((hit) => hit.port === 5173 || hit.port === 3000 || /:(5173|3000)$/.test(hit.host))).toBe(false);
    const urls = [...seen].map((entry) => entry.slice(entry.indexOf(' ') + 1));
    expect(urls.some((url) => /:(5173|3000)(\/|$)/.test(url))).toBe(false);
    expect(urls.every((url) => {
      const origin = new URL(url).origin;
      return origin === web.origin || origin === api.origin;
    })).toBe(true);
    expect(transport === 'page.goto' || (process.env.CI === 'true' && transport === 'playwright-request')).toBe(true);
    console.info(JSON.stringify({
      transport,
      web: web.origin,
      api: api.origin,
      pageHits: pageHits.map((hit) => `${hit.method} ${hit.host}${hit.url}`),
      apiHits: apiHits.map((hit) => `${hit.method} ${hit.host}${hit.url}`),
    }));
  }, 60_000);
});
