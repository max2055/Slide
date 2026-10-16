import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'./e2e', testMatch:['max187-default-blue.spec.ts'], workers:1,
  timeout:60_000, retries:0, use:{browserName:'chromium',trace:'off',viewport:{width:1440,height:900}},
  outputDir:process.env.MAX187_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-187/playwright' });
