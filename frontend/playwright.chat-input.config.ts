import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'chat-input.live.spec.ts', workers: 1, retries: 0,
  timeout: 120_000, outputDir: process.env.CHAT_INPUT_OUTPUT ?? './test-results-chat-input',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
