import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'./e2e', testMatch:['max184-workspace-theme.spec.ts'], workers:1,
  timeout:60_000, retries:0, use:{browserName:'chromium',trace:'off'},
  outputDir:process.env.MAX184_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-184/playwright' });
