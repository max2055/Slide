import { describe, it, expect } from 'vitest';
import { html, render } from 'lit';
import { md, sanitizeMarkdownHtml } from '../markdown.ts';
import { StreamingMarkdown, streamingMarkdown } from './streaming-markdown.ts';

const full = (s: string) => sanitizeMarkdownHtml(md.render(s));
describe('incremental Markdown', () => {
  const cases = [
    '标题\n======\n\n正文 **bold** English。\n\n尾部',
    '前言\n\n```sql\nSELECT 1;\n\nSELECT 2;\n```\n\n后文',
    '前言\n\n| a | b |\n| --- | --- |\n| 中 | en |\n\n结束',
    '- first\n\n- second\n  - nested\n\n    continuation\n\nend',
    '> first\n>\n> second\n\nend',
    '[late][id]\n\nfirst\n\nsecond\n\nthird\n\n[id]: https://example.com "safe"\n',
    '<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n- [x] safe',
    '标题\r======\r\r前文\r\r| a | b |\r| --- | --- |\r| 中 | en |\r\r结尾',
    '标题\r\n======\r\n\r\n- first\r\n- second\r\n\r\n结尾',
  ];
  for (const source of cases) it(`matches parser at every fragment: ${source.slice(0, 25)}`, () => {
    const parser = new StreamingMarkdown();
    for (let n = 1; n <= source.length; n++) {
      expect(parser.update(source.slice(0, n)).map(b => b.html).join('')).toBe(full(source.slice(0, n)));
    }
  });
  it('invalidates late references and a replaced/reset tail', () => {
    const parser = new StreamingMarkdown();
    parser.update(cases[5]);
    expect(parser.update('reset **answer**').map(b => b.html).join('')).toBe(full('reset **answer**'));
  });
  it('retains stable nodes, selection and expanded code on append and completion', () => {
    const root = document.createElement('div'); document.body.append(root);
    const source = '```json\n{"ok": true}\n```\n\nstable paragraph\n\nsecond\n\ntail';
    const update = (s: string) => render(html`${streamingMarkdown(s)}`, root);
    update(source);
    const details = root.querySelector('details')!; details.open = true;
    const text = root.querySelector('p')!.firstChild!;
    const selection = window.getSelection()!; const range = document.createRange();
    range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range);
    update(source + ' added'); update(source + ' added');
    expect(root.querySelector('details')).toBe(details);
    expect(details.open).toBe(true); expect(selection.toString()).toBe('stable paragraph');
    root.remove();
  });
});
