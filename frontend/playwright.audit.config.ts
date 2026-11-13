import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.AUDIT_BROWSER_PORT || 5186);
export default defineConfig({
  testDir: './e2e',
testMatch: ['llm-provider-compatibility.spec.ts', 'reports-time.spec.ts', 'audit-policy-navigation.spec.ts', 'audit-request-race.spec.ts', 'feedback-page-real.spec.ts', 'feedback-page.spec.ts', 'chat-rendering-recovery.spec.ts', 'tool-display-policy.spec.ts', 'app-session-identity.spec.ts', 'chat-deletion.spec.ts', 'chat-content-filtering.spec.ts', 'chat-text-presentation.spec.ts', 'resource-search.spec.ts', 'rbac-delete.spec.ts', 'users-roles.spec.ts', 'users-roles-real.spec.ts', 'settings-permissions.spec.ts', 'settings-permissions-real.spec.ts', 'button-consistency.spec.ts', 'form-fields.spec.ts', 'max157-ui.spec.ts', 'chat-sessions.spec.ts', 'chat-greeting.spec.ts', 'chat-notices.spec.ts', 'tool-stream.spec.ts', 'resource-diagnosis.spec.ts', 'cron-runs.spec.ts', 'cron-creation.spec.ts', 'audit-dialog.spec.ts', 'dashboard-overview.spec.ts', 'network-device-scheduling.spec.ts', 'readability.spec.ts', 'llm-scenes.spec.ts', 'llm-test-feedback.spec.ts', 'source-sync.spec.ts', 'resource-metrics.spec.ts', 'metric-settings.spec.ts', 'log-analysis-observation.spec.ts'],
  outputDir: './test-results-audit',
  timeout: 30_000,
  workers: 2,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
