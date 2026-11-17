import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  // Raw Playwright trace/DOM stay private. CI uploads only the schema-checked summary.
  outputDir: './test-results-agent-runtime-private',
});
