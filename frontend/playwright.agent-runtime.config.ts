import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import base from './playwright.config';

// Keep the authenticated claim fixture available without the evidence runner.
// Workers reload this config, so retain the launcher's per-run identity.
const nonce = process.env.RUNTIME_CLAIM_NONCE ??= randomUUID();
const coordinate = process.env.RUNTIME_CLAIM_COORDINATE ??= join(tmpdir(), `slide-runtime-claim-${nonce}.json`);
const preload = new URL('./e2e/runtime-claim-preload.mjs', import.meta.url).href;
const managedServer = base.webServer;
if (Array.isArray(managedServer)) throw new Error('Runtime fixture requires one managed server');

export default defineConfig({
  ...base,
  webServer: managedServer ? {
    ...managedServer,
    env: {
      ...managedServer.env,
      RUNTIME_CLAIM_NONCE: nonce,
      RUNTIME_CLAIM_COORDINATE: coordinate,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`,
    },
  } : undefined,
  // Authentication frames must not be recorded by automatic Playwright traces.
  use: { ...base.use, trace: 'off' },
  outputDir: './test-results-agent-runtime-private',
});
