/**
 * Nyquist validation: 92-01-01 — slide_complete_analysis tool accepts Markdown
 *
 * Tests:
 * 1. Parameters are { analysisId: number, markdown: string } (both required)
 * 2. No old summary/findings/recommendations parameters
 * 3. Handler calls aiAnalysisDatabaseService.completeAnalysis with correct args
 * 4. Handler returns { success: true, data: { saved: true, analysisId } } on success
 * 5. Handler returns { success: false, error: '...' } on service failure
 * 6. toolCatalog.register is called in the source file
 * 7. No string references to old params in the source
 *
 * NOTE: We use vi.hoisted() + vi.mock() to mock the ai-analysis-database-service module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const SOURCE_FILE = resolve(__dirname, 'complete_analysis.ts');

// vi.hoisted creates a function reference that survives vi.mock hoisting
const mockCompleteAnalysis = vi.hoisted(() => vi.fn());

vi.mock('../../../ai-analysis-database-service.js', () => ({
  aiAnalysisDatabaseService: { completeAnalysis: mockCompleteAnalysis },
}));

import { completeAnalysisTool } from './complete_analysis.js';
import { toolCatalog } from '../../catalog.js';

describe('92-01-01: slide_complete_analysis tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parameter schema', () => {
    it('has only analysisId (number) and markdown (string) as required parameters', () => {
      const props = completeAnalysisTool.parameters.properties;
      expect(props).toHaveProperty('analysisId');
      expect(props.analysisId.type).toBe('number');
      expect(props).toHaveProperty('markdown');
      expect(props.markdown.type).toBe('string');
      expect(completeAnalysisTool.parameters.required).toEqual(['analysisId', 'markdown']);
    });

    it('has no references to old summary/findings/recommendations in parameters', () => {
      const props = completeAnalysisTool.parameters.properties;
      expect(props).not.toHaveProperty('summary');
      expect(props).not.toHaveProperty('findings');
      expect(props).not.toHaveProperty('recommendations');
    });
  });

  describe('handler behavior', () => {
    it('calls aiAnalysisDatabaseService.completeAnalysis with correct args and returns success', async () => {
      mockCompleteAnalysis.mockResolvedValueOnce({ success: true });

      const result = await completeAnalysisTool.handler({
        analysisId: 42,
        markdown: '# Analysis Result\n\nSome markdown content.',
      });

      expect(mockCompleteAnalysis).toHaveBeenCalledWith(42, {
        result: '# Analysis Result\n\nSome markdown content.',
      });
      expect(result).toEqual({
        success: true,
        data: { saved: true, analysisId: 42 },
        summary: '分析结果已保存',
      });
    });

    it('returns { success: false, error } when service throws', async () => {
      mockCompleteAnalysis.mockRejectedValueOnce(new Error('Database write failed'));

      const result = await completeAnalysisTool.handler({ analysisId: 7, markdown: '# Error test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('保存分析结果失败');
      expect(result.error).toContain('Database write failed');
    });
  });

  describe('source code checks', () => {
    it('calls toolCatalog.register in the source file', () => {
      const source = readFileSync(SOURCE_FILE, 'utf-8');
      expect(source).toContain('toolCatalog.register');
    });

    it('has no old parameter identifiers summary/findings/recommendations as property names in parameters object', () => {
      const source = readFileSync(SOURCE_FILE, 'utf-8');
      // Extract the properties object between the first { and matching }
      const propsMatch = source.match(/properties:\s*\{([\s\S]*?)\n\s*\},?\n/);
      if (propsMatch) {
        const propsContent = propsMatch[1];
        expect(propsContent).not.toMatch(/\bsummary\b/);
        expect(propsContent).not.toMatch(/\bfindings\b/);
        expect(propsContent).not.toMatch(/\brecommendations\b/);
      }
    });

    it('is exported as completeAnalysisTool', () => {
      const source = readFileSync(SOURCE_FILE, 'utf-8');
      expect(source).toContain('export const completeAnalysisTool');
    });

    it('has name slide_complete_analysis', () => {
      expect(completeAnalysisTool.name).toBe('slide_complete_analysis');
    });
  });

  describe('toolCatalog registration', () => {
    it('tool is registered in catalog after module import', () => {
      expect(toolCatalog.has('slide_complete_analysis')).toBe(true);
    });
  });
});
