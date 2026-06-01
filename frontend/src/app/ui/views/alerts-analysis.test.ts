/**
 * Nyquist validation: 92-04-01 and 92-04-02 — Alert analysis badges + result modal
 *
 * Tests:
 * - 92-04-01:
 *   1. analyzedStatuses is Map (not Set)
 *   2. _loadAnalyzedStatuses has console.warn in catch block
 *   3. _renderAnalysisBadge exists as method
 *   4. CSS class definitions and colors
 *   5. Badge 4 states with correct labels and CSS
 * - 92-04-02:
 *   1. activeAnalysisRecord @state() exists
 *   2. _renderAnalysisResultModal renders ai-analysis-result element
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const VIEWS_DIR = resolve(import.meta.dirname, '.');
const SOURCE_FILE = resolve(VIEWS_DIR, 'alerts.ts');
const source = readFileSync(SOURCE_FILE, 'utf-8');

describe('92-04-01: Alert analysis badges + error logging', () => {
  describe('analyzedStatuses state', () => {
    it('analyzedStatuses is declared as Map (not Set)', () => {
      expect(source).toMatch(/analyzedStatuses.*Map</);
      // Ensure it's NOT the old Set
      expect(source).not.toMatch(/analyzedAlertIds/);
    });
  });

  describe('error logging', () => {
    it('_loadAnalyzedStatuses has console.warn in catch block', () => {
      expect(source).toContain('console.warn(\'[Alerts] _loadAnalyzedStatuses failed:');
    });
  });

  describe('_renderAnalysisBadge method', () => {
    it('has _renderAnalysisBadge method definition', () => {
      expect(source).toContain('_renderAnalysisBadge(alertId');
    });

    it('has 4 badge states: completed, running, failed, no record', () => {
      expect(source).toContain('analysis-badge--completed');
      expect(source).toContain('analysis-badge--running');
      expect(source).toContain('analysis-badge--failed');
      // The "no record" state should render a dash
      expect(source).toContain('—');
    });

    it('"已分析" label for completed state', () => {
      expect(source).toContain('已分析');
    });

    it('"分析中" label for running state', () => {
      expect(source).toContain('分析中');
    });

    it('"分析失败" label for failed state', () => {
      expect(source).toContain('分析失败');
    });
  });

  describe('CSS badge styles', () => {
    it('has .analysis-badge base class', () => {
      expect(source).toContain('.analysis-badge');
    });

    it('has .analysis-badge--completed class', () => {
      expect(source).toContain('.analysis-badge--completed');
    });

    it('has .analysis-badge--running class', () => {
      expect(source).toContain('.analysis-badge--running');
    });

    it('has .analysis-badge--failed class', () => {
      expect(source).toContain('.analysis-badge--failed');
    });

    it('completed badge uses #22c55e green', () => {
      // Check for the green color value from UI-SPEC spec
      expect(source).toMatch(/22c55e/);
    });

    it('running badge uses #d2befc violet', () => {
      expect(source).toMatch(/d2befc/);
    });

    it('failed badge uses #b08df5 danger/violet', () => {
      expect(source).toMatch(/b08df5/);
    });
  });
});

describe('92-04-02: Alert result modal', () => {
  describe('State properties', () => {
    it('activeAnalysisRecord @state exists', () => {
      expect(source).toContain('activeAnalysisRecord');
    });
  });

  describe('_renderAnalysisResultModal', () => {
    it('has _renderAnalysisResultModal method', () => {
      expect(source).toContain('_renderAnalysisResultModal');
    });

    it('uses ai-analysis-result component in the modal', () => {
      expect(source).toContain('ai-analysis-result');
    });

    it('passes result property to ai-analysis-result', () => {
      expect(source).toContain('.result=');
    });

    it('passes analysisType property', () => {
      expect(source).toContain('analysisType');
    });

    it('passes triggerType property', () => {
      expect(source).toContain('triggerType');
    });
  });

});
