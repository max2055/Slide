import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const BASE_CSS_PATH = '/Users/max/Coding/39-Slide/frontend/src/openclaw/styles/base.css';
const VIEWS_DIR = '/Users/max/Coding/39-Slide/frontend/src/openclaw/ui/views';

const EXPECTED_TOKENS: Record<string, string> = {
  '--text-xs': '11px',
  '--text-sm': '12px',
  '--text-base': '13px',
  '--text-md': '14px',
  '--text-lg': '16px',
  '--text-xl': '18px',
  '--text-2xl': '22px',
  '--space-xs': '4px',
  '--space-sm': '8px',
  '--space-md': '12px',
  '--space-lg': '16px',
  '--space-xl': '24px',
};

const MIGRATED_PAGES = [
  'dashboard.ts',
  'approval-dashboard.ts',
  'sql-console.ts',
  'alerts.ts',
  'instance-detail.ts',
  'instances-db.ts',
  'rbac-page.ts',
  'users-management.ts',
  'event-management.ts',
  'reports.ts',
  'metric-registry.ts',
  'schema-management.ts',
  'index-management.ts',
];

describe('UI-01: Design tokens defined in base.css :root block', () => {
  const cssContent = readFileSync(BASE_CSS_PATH, 'utf8');

  // Extract only the main :root block content (stops at the first unmatched })
  const rootMatch = cssContent.match(/:root\s*\{([\s\S]*?)\}/);
  expect(rootMatch).not.toBeNull();
  const rootContent = rootMatch![1];

  for (const [token, expectedValue] of Object.entries(EXPECTED_TOKENS)) {
    it(`defines ${token}: ${expectedValue} in :root`, () => {
      // Match the variable definition with optional whitespace
      const varPattern = new RegExp(
        `${token.replace('--', '--')}\\s*:\\s*${expectedValue.replace('px', 'px')}`
      );
      expect(rootContent).toMatch(varPattern);
    });
  }
});

describe('UI-01: Design tokens are theme-independent', () => {
  const cssContent = readFileSync(BASE_CSS_PATH, 'utf8');

  for (const token of Object.keys(EXPECTED_TOKENS)) {
    it(`${token} is defined exactly once across the entire file (not overridden per theme)`, () => {
      const regex = new RegExp(token.replace('--', '--') + '\\s*:', 'g');
      const matches = cssContent.match(regex);
      expect(matches ? matches.length : 0).toBe(1);
    });
  }
});

describe('UI-01: Migrated pages use design tokens', () => {
  for (const page of MIGRATED_PAGES) {
    it(`${page} uses var(--text-*) or var(--space-*)`, () => {
      const content = readFileSync(`${VIEWS_DIR}/${page}`, 'utf8');
      const usesTextTokens = /var\(--text-(?:xs|sm|base|md|lg|xl|2xl)\)/.test(content);
      const usesSpaceTokens = /var\(--space-(?:xs|sm|md|lg|xl)\)/.test(content);
      expect(usesTextTokens || usesSpaceTokens).toBe(true);
    });
  }
});
