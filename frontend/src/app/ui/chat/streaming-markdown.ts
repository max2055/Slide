import { html, nothing } from 'lit';
import { directive, Directive } from 'lit/directive.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { md, sanitizeMarkdownHtml } from '../markdown.ts';

type Leaf = { key: number; source: string; html: string; structure?: string };
type Block = Leaf & { references: boolean; children?: Leaf[]; kind?: 'table' | 'ul' | 'ol'; head?: string; start?: string; className?: string };

/** Parser-owned boundaries, never permanent blank-line splits. A growing last
 * block and its predecessor stay mutable (tables, setext, lists and fences).
 * References are document-wide; late definitions invalidate dependent blocks.
 * Cache lifetime follows a Lit part rather than retaining every stream prefix.
 */
export class StreamingMarkdown {
  private input = '';
  private offset = 0;
  private stable: Block[] = [];
  private prefixReferences: Record<string, unknown> = {};
  private referenceKey = '';
  private blocks: Block[] = [];

  update(input: string): readonly Block[] {
    // Same cap as the legacy security/resource boundary. No 40k plain fallback.
    input = input.slice(0, 140_000);
    if (input === this.input) return this.blocks;
    if (!input.startsWith(this.input)) {
      this.offset = 0; this.stable = []; this.prefixReferences = {}; this.referenceKey = '';
    }
    const tail = input.slice(this.offset);
    const env = { references: { ...this.prefixReferences } };
    const tokens = md.parse(tail, env);
    const referenceKey = JSON.stringify(env.references);
    const referencesChanged = referenceKey !== this.referenceKey;
    if (referenceKey !== this.referenceKey) {
      const resolved = new Map<string, string>();
      this.stable = this.stable.map(block => {
        if (!block.references) return block;
        let rendered = resolved.get(block.source);
        if (rendered === undefined) {
          rendered = sanitizeMarkdownHtml(md.render(block.source, { references: { ...env.references } })); resolved.set(block.source, rendered);
        }
        return { ...block, kind: undefined, children: undefined, html: rendered };
      });
      this.referenceKey = referenceKey;
    }
    const lineStarts = [0];
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] === '\n' || tail[i] === '\r' && tail[i + 1] !== '\n') lineStarts.push(i + 1);
    }
    const parsed: Block[] = [];
    for (let i = 0; i < tokens.length;) {
      const start = i;
      const map = tokens[i].map;
      let depth = tokens[i++].nesting;
      while (depth > 0 && i < tokens.length) depth += tokens[i++].nesting;
      if (!map) continue;
      const from = lineStarts[map[0]] ?? tail.length;
      const to = lineStarts[map[1]] ?? tail.length;
      const source = tail.slice(from, to);
      const key = this.offset + from;
      const prior = this.blocks.find(block => block.key === key);
      if (prior?.source === source && (!referencesChanged || !prior.references)) { parsed.push(prior); continue; }
      const group = tokens.slice(start, i);
      const kind = group[0].type === 'table_open' ? 'table' : group[0].type === 'bullet_list_open' ? 'ul' : group[0].type === 'ordered_list_open' ? 'ol' : undefined;
      if (!kind) {
        parsed.push({ key, source, references: source.includes('['), html: sanitizeMarkdownHtml(md.renderer.render(group, md.options, env)) });
        continue;
      }
      // Large tables/lists keep their native container and stable row/item DOM.
      // Sanitize only changed balanced leaves, with table context for tr/td.
      const previous = new Map(prior?.children?.map(child => [child.key, child]));
      const children: Leaf[] = [];
      const hasBody = group.some(token => token.type === 'tbody_open');
      let head = '';
      for (let j = 1; j < group.length - 1;) {
        if (kind === 'table' && group[j].type === 'thead_open') {
          const begin = j++; while (j < group.length && group[j].type !== 'thead_close') j++; j++;
          const header = md.renderer.render(group.slice(begin, j), md.options, env);
          head = sanitizeMarkdownHtml(`<table>${header}</table>`).replace(/^<table>|<\/table>$/g, '');
          continue;
        }
        if (kind === 'table' && group[j].type !== 'tr_open' || kind !== 'table' && group[j].type !== 'list_item_open') { j++; continue; }
        const begin = j, leafMap = group[j].map;
        let nesting = group[j++].nesting;
        while (nesting > 0 && j < group.length) nesting += group[j++].nesting;
        const leafFrom = lineStarts[leafMap?.[0] ?? 0] ?? tail.length;
        const leafTo = lineStarts[leafMap?.[1] ?? 0] ?? tail.length;
        const leafSource = tail.slice(leafFrom, leafTo), leafKey = this.offset + leafFrom;
        const structure = group.slice(begin, j).map(token => token.hidden ? '1' : '0').join('');
        const cached = previous.get(leafKey);
        if (cached?.source === leafSource && cached.structure === structure && (!referencesChanged || !leafSource.includes('['))) { children.push(cached); continue; }
        const rendered = md.renderer.render(group.slice(begin, j), md.options, env);
        const sanitized = kind === 'table' ? sanitizeMarkdownHtml(`<table><tbody>${rendered}</tbody></table>`).replace(/^<table><tbody>|<\/tbody><\/table>$/g, '') : sanitizeMarkdownHtml(rendered);
        children.push({ key: leafKey, source: leafSource, html: sanitized, structure });
      }
      const open = md.renderer.render(group.slice(0, 1), md.options, env);
      const close = md.renderer.render(group.slice(-1), md.options, env);
      parsed.push({ key, source, references: source.includes('['), kind, children, head,
        start: group[0].attrGet('start'), className: group[0].attrGet('class'),
        html: open + head + (hasBody ? '<tbody>\n' : '') + children.map(c => c.html).join('') + (hasBody ? '</tbody>\n' : '') + close });
    }
    this.blocks = [...this.stable, ...parsed];
    if (parsed.length > 2) {
      const boundary = parsed[parsed.length - 2].key;
      const frozenEnv = { references: { ...this.prefixReferences } };
      md.parse(input.slice(this.offset, boundary), frozenEnv);
      this.prefixReferences = frozenEnv.references;
      this.stable = [...this.stable, ...parsed.slice(0, -2)];
      this.offset = boundary;
    }
    this.input = input;
    return this.blocks;
  }
}

class StreamingMarkdownDirective extends Directive {
  private parser = new StreamingMarkdown();
  render(input: string) {
    return html`${repeat(this.parser.update(input), block => block.key, block => {
      const children = repeat(block.children ?? [], child => child.key, child => unsafeHTML(child.html));
      if (block.kind === 'table') return html`<table>${unsafeHTML(block.head ?? '')}<tbody>${children}</tbody></table>`;
      if (block.kind === 'ul') return html`<ul class=${block.className ?? nothing}>${children}</ul>`;
      if (block.kind === 'ol') return html`<ol start=${block.start ?? nothing} class=${block.className ?? nothing}>${children}</ol>`;
      return unsafeHTML(block.html);
    })}${input.length > 140_000 ? html`<p>内容已截断（${input.length} 字符，显示前 140000 字符）。</p>` : nothing}`;
  }
}
export const streamingMarkdown = directive(StreamingMarkdownDirective);
