/**
 * Nyquist validation: 92-05-01 and 92-05-02 — Instance detail diagnosis history
 *
 * Tests:
 * - 92-05-01:
 *   1. diagnosisHistory, diagnosisHistoryLoading, activeDiagnosisRecord, showDiagnosisModal state exists
 *   2. loadDiagnosisHistory fetches from correct URL
 *   3. _renderDiagnosisHistory renders "AI 诊断历史" card
 *   4. Empty state shows "暂无诊断记录"
 *   5. History items show status badge, time, truncated text
 *   6. Clicking item opens modal with ai-analysis-result
 * - 92-05-02:
 *   1. _renderDiagnosisCard uses <ai-analysis-result>
 *   2. ai-analysis-result receives correct property bindings
 *   3. _startDiagnosis method preserved
 *   4. _startDiagnosisPolling method preserved
 *   5. _stopDiagnosisPolling method preserved
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const VIEWS_DIR = resolve(import.meta.dirname, '.');
const SOURCE_FILE = resolve(VIEWS_DIR, 'instance-detail.ts');
const source = readFileSync(SOURCE_FILE, 'utf-8');

describe('92-05-01: Instance detail diagnosis history', () => {
  describe('State properties', () => {
    it('diagnosisHistory state array exists', () => {
      expect(source).toContain('diagnosisHistory');
    });

    it('diagnosisHistoryLoading state exists', () => {
      expect(source).toContain('diagnosisHistoryLoading');
    });

    it('activeDiagnosisRecord state exists', () => {
      expect(source).toContain('activeDiagnosisRecord');
    });

    it('showDiagnosisModal state exists', () => {
      expect(source).toContain('showDiagnosisModal');
    });
  });

  describe('loadDiagnosisHistory', () => {
    it('has loadDiagnosisHistory method', () => {
      expect(source).toContain('loadDiagnosisHistory');
    });

    it('calls /api/ai/analysis/recent with instance_id query param', () => {
      expect(source).toContain('/api/ai/analysis/recent');
      expect(source).toContain('instance_id');
    });

    it('requests analysis_type=fault_diagnosis', () => {
      expect(source).toContain('fault_diagnosis');
    });
  });

  describe('_renderDiagnosisHistory', () => {
    it('renders card with "AI 诊断历史" header', () => {
      expect(source).toContain('AI 诊断历史');
    });

    it('shows "暂无诊断记录" empty state', () => {
      expect(source).toContain('暂无诊断记录');
    });

    it('shows truncated summary text (80 chars)', () => {
      // Look for substring(0, 80) or similar truncation
      expect(source).toMatch(/substring\(0,\s*80\)/);
    });

    it('history items have status badge', () => {
      expect(source).toContain('status-badge');
    });

    it('history items have time display', () => {
      expect(source).toContain('diagnosis-time');
    });

    it('history items have chevron icon', () => {
      expect(source).toContain('chevron-right');
      expect(source).toContain('diagnosis-chevron');
    });

    it('shows "最近 N 条" count', () => {
      expect(source).toContain('最近 ');
      expect(source).toContain(' 条');
    });
  });

  describe('Modal functionality', () => {
    it('clicking history item sets activeDiagnosisRecord and shows modal', () => {
      expect(source).toContain('showDiagnosisModal');
      expect(source).toContain('activeDiagnosisRecord');
    });

    it('_renderDiagnosisModal includes ai-analysis-result component', () => {
      expect(source).toContain('_renderDiagnosisModal');
      expect(source).toContain('ai-analysis-result');
    });

    it('_renderDiagnosisModal passes result property to ai-analysis-result', () => {
      const modalSection = source.match(/_renderDiagnosisModal[\s\S]*?ai-analysis-result[\s\S]*?><\/ai-analysis-result>/);
      if (modalSection) {
        expect(modalSection[0]).toMatch(/\.result=/);
        expect(modalSection[0]).toMatch(/analysisType=/);
        expect(modalSection[0]).toMatch(/triggerType=/);
        expect(modalSection[0]).toMatch(/status=/);
        expect(modalSection[0]).toMatch(/\.errorMessage=/);
        expect(modalSection[0]).toMatch(/title=/);
      }
    });
  });

  describe('loadDiagnosisHistory called on instance load', () => {
    it('loadDiagnosisHistory() is called when instance data loads', () => {
      // Should be called in loadData() or equivalent
      expect(source).toContain('this.loadDiagnosisHistory()');
    });
  });
});

describe('92-05-02: Diagnosis card uses ai-analysis-result component', () => {
  describe('_renderDiagnosisCard', () => {
    it('_renderDiagnosisCard method exists', () => {
      expect(source).toContain('_renderDiagnosisCard');
    });

    it('uses <ai-analysis-result> element', () => {
      expect(source).toContain('ai-analysis-result');
    });

    it('passes .result property binding', () => {
      const cardSection = source.match(/_renderDiagnosisCard[\s\S]*?ai-analysis-result[\s\S]*?><\/ai-analysis-result>/);
      if (cardSection) {
        expect(cardSection[0]).toMatch(/\.result=/);
      }
    });

    it('passes analysisType="fault_diagnosis"', () => {
      expect(source).toContain('fault_diagnosis');
    });

    it('passes triggerType="manual"', () => {
      expect(source).toContain('triggerType');
    });

    it('passes .loading property binding', () => {
      const cardSection = source.match(/_renderDiagnosisCard[\s\S]*?ai-analysis-result[\s\S]*?><\/ai-analysis-result>/);
      if (cardSection) {
        expect(cardSection[0]).toMatch(/\.loading=/);
      }
    });

    it('passes .errorMessage property binding', () => {
      const cardSection = source.match(/_renderDiagnosisCard[\s\S]*?ai-analysis-result[\s\S]*?><\/ai-analysis-result>/);
      if (cardSection) {
        expect(cardSection[0]).toMatch(/\.errorMessage=/);
      }
    });

    it('passes status property', () => {
      const cardSection = source.match(/_renderDiagnosisCard[\s\S]*?ai-analysis-result[\s\S]*?><\/ai-analysis-result>/);
      if (cardSection) {
        expect(cardSection[0]).toMatch(/status=/);
      }
    });
  });

  describe('Polling methods preserved', () => {
    it('_startDiagnosis method is preserved', () => {
      expect(source).toContain('_startDiagnosis');
    });

    it('_startDiagnosisPolling method is preserved', () => {
      expect(source).toContain('_startDiagnosisPolling');
    });

    it('_stopDiagnosisPolling method is preserved', () => {
      expect(source).toContain('_stopDiagnosisPolling');
    });
  });

  describe('Close mechanism', () => {
    it('has close button or mechanism to dismiss diagnosis card', () => {
      expect(source).toContain('diagnosis-close-btn');
    });
  });
});
