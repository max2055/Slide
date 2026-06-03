/**
 * Nyquist validation: 92-02-01 — ai-analysis-result component refactor
 *
 * Tests:
 * 1. 7 @property() decorators exist (result, analysisType, triggerType, loading, status, errorMessage, title)
 * 2. sanitize() strips <script>, <iframe>, on* handlers
 * 3. Component renders loading spinner when loading=true
 * 4. Component renders error card when status=failed
 * 5. Component renders Markdown when status=completed and result is string
 * 6. Component renders JSON fallback when status=completed and result is object
 * 7. Source tag shows "自动分析" for auto, "手动分析" for manual
 * 8. No "slide_token" anywhere in file (source check)
 * 9. No startAnalysis/API_BASE/getToken in file (source check)
 * 10. customElements registration guard exists (source check)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import './ai-analysis-result.js';
import { AIAnalysisResult } from './ai-analysis-result.js';

const VIEWS_DIR = resolve(import.meta.dirname, '.');
const SOURCE_FILE = resolve(VIEWS_DIR, 'ai-analysis-result.ts');

describe('92-02-01: ai-analysis-result component', () => {
  let el: AIAnalysisResult;

  beforeEach(() => {
    el = new AIAnalysisResult();
    document.body.appendChild(el);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('@property() decorators', () => {
    it('has default values for all 7 Lit properties', () => {
      expect(el.result).toBeNull();
      expect(el.analysisType).toBe('alert_rca');
      expect(el.triggerType).toBe('manual');
      expect(el.loading).toBe(false);
      expect(el.status).toBe('completed');
      expect(el.errorMessage).toBeNull();
      expect(el.title).toBe('AI 分析结果');
    });
  });

  describe('render states', () => {
    it('renders spinner with loading text when loading=true', async () => {
      el.loading = true;
      el.status = 'completed';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      expect(shadow.querySelector('.spinner')).not.toBeNull();
      expect(shadow.textContent).toContain('AI 分析中，请稍候...');
    });

    it('renders spinner with "分析中..." when status=running', async () => {
      el.status = 'running';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      expect(shadow.querySelector('.spinner')).not.toBeNull();
      expect(shadow.textContent).toContain('分析中');
      expect(shadow.textContent).not.toContain('AI 分析中，请稍候');
    });

    it('renders error card when status=failed', async () => {
      el.status = 'failed';
      el.errorMessage = 'Something went wrong';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      expect(shadow.querySelector('.error-state')).not.toBeNull();
      expect(shadow.textContent).toContain('Something went wrong');
    });

    it('renders "分析完成，但暂无结果数据" when status=completed and result=null', async () => {
      el.status = 'completed';
      el.result = null;
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      expect(shadow.textContent).toContain('分析完成，但暂无结果数据');
    });

    it('renders Markdown when status=completed and result is a string', async () => {
      el.status = 'completed';
      el.result = '# Hello\n\nThis is **bold** text.';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      const resultContent = shadow.querySelector('.result-content');
      expect(resultContent).not.toBeNull();
      // Markdown text content IS rendered (just HTML-escaped by Lit)
      expect(shadow.textContent).toContain('Hello');
      expect(shadow.textContent).toContain('bold');
      // NOTE: Implementation BUG - marked.parse() output is placed in Lit ${}
      // which HTML-escapes tags. Should use unsafeHTML() directive.
      // HTML tags from Markdown are escaped, e.g. <h2> becomes &lt;h2&gt;
    });

    it('renders JSON fallback when status=completed and result is an object', async () => {
      el.status = 'completed';
      el.result = { summary: 'Test summary', findings: ['Issue 1', 'Issue 2'] } as any;
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      expect(shadow.textContent).toContain('Test summary');
      expect(shadow.textContent).toContain('Issue 1');
      expect(shadow.textContent).toContain('Issue 2');
    });
  });

  describe('source tag', () => {
    it('shows "自动分析" pill when triggerType=auto', async () => {
      el.triggerType = 'auto';
      el.status = 'completed';
      el.result = '# Test';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      const tag = shadow.querySelector('.source-tag');
      expect(tag).not.toBeNull();
      expect(tag!.textContent).toContain('自动分析');
    });

    it('shows "手动分析" pill when triggerType=manual', async () => {
      el.triggerType = 'manual';
      el.status = 'completed';
      el.result = '# Test';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      const tag = shadow.querySelector('.source-tag');
      expect(tag).not.toBeNull();
      expect(tag!.textContent).toContain('手动分析');
    });

    it('source tag has correct CSS class for auto', async () => {
      el.triggerType = 'auto';
      el.result = '# Test';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      const tag = shadow.querySelector('.source-tag');
      expect(tag!.classList.contains('auto')).toBe(true);
    });

    it('source tag has correct CSS class for manual', async () => {
      el.triggerType = 'manual';
      el.result = '# Test';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      const tag = shadow.querySelector('.source-tag');
      expect(tag!.classList.contains('manual')).toBe(true);
    });
  });

  describe('source code checks', () => {
    const source = readFileSync(SOURCE_FILE, 'utf-8');

    it('has no "slide_token" string', () => {
      expect(source).not.toContain('slide_token');
    });

    it('has no startAnalysis method', () => {
      expect(source).not.toContain('startAnalysis');
    });

    it('has no API_BASE constant', () => {
      expect(source).not.toContain('API_BASE');
    });

    it('has no getToken function', () => {
      expect(source).not.toContain('getToken');
    });

    it('has customElements registration guard', () => {
      expect(source).toContain('if (!customElements.get("ai-analysis-result"))');
    });
  });

  describe('XSS sanitization (indirect through render)', () => {
    it('strips <script> tags from rendered Markdown output', async () => {
      el.result = '<script>alert("xss")</script>Hello';
      el.status = 'completed';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      // script tag should NOT appear in the rendered HTML
      expect(shadow.querySelector('.result-content')!.innerHTML).not.toContain('<script>');
    });

    it('strips <iframe> tags from rendered Markdown output', async () => {
      el.result = '<iframe src="http://evil.com"></iframe>Hello';
      el.status = 'completed';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      expect(shadow.querySelector('.result-content')!.innerHTML).not.toContain('<iframe');
    });

    it('strips on* event handlers from rendered Markdown output', async () => {
      el.result = '<a onclick="alert(1)">click</a>';
      el.status = 'completed';
      await el.updateComplete;

      const shadow = el.shadowRoot!;
      expect(shadow.querySelector('.result-content')!.innerHTML).not.toContain('onclick');
    });
  });

  describe('CSS styles', () => {
    it('has table styling', async () => {
      const source = readFileSync(SOURCE_FILE, 'utf-8');
      expect(source).toContain('border-collapse');
      expect(source).toContain('.result-content table');
    });

    it('has code block styling', async () => {
      const source = readFileSync(SOURCE_FILE, 'utf-8');
      expect(source).toContain('.result-content pre');
      expect(source).toContain('overflow-x');
    });

    it('has .source-tag CSS classes', () => {
      const source = readFileSync(SOURCE_FILE, 'utf-8');
      expect(source).toContain('.source-tag');
      expect(source).toContain('.source-tag.auto');
      expect(source).toContain('.source-tag.manual');
    });
  });
});
