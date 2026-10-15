import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:['max175-resource-layout.spec.ts'],workers:1,timeout:30000,use:{browserName:'chromium',trace:'off'},outputDir:'/Users/max/Coding/40-Slide/outputs/MAX-175/playwright'});
