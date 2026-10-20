import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',testMatch:'operations-ui.spec.ts',workers:1,retries:0,timeout:120000,
  outputDir:process.env.MAX202_OUTPUT_DIR ? `${process.env.MAX202_OUTPUT_DIR}/playwright` : './test-results-operations',
  use:{trace:'retain-on-failure',actionTimeout:15000},
});
