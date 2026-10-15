import { css, html } from 'lit';

/** Local browsing only: callers must describe a partial remote dataset explicitly. */
export class ListBrowser {
  query = '';
  page = 1;
  size = 25;
  descending = false;

  select<T>(rows: readonly T[], text: (row: T) => string, key: (row: T) => string) {
    const query = this.query.trim().toLocaleLowerCase();
    const matches = rows.filter(row => text(row).toLocaleLowerCase().includes(query))
      .sort((a, b) => (this.descending ? -1 : 1) * key(a).localeCompare(key(b), 'zh-CN', { numeric: true }));
    const pages = Math.max(1, Math.ceil(matches.length / this.size));
    this.page = Math.min(Math.max(1, this.page), pages);
    return { rows: matches.slice((this.page - 1) * this.size, this.page * this.size), total: matches.length, pages };
  }
}

export const listBrowserStyles = css`
  :host { min-width:0; }
  :host(schema-management-page) .table-container > table,
  :host(index-management-page) .table-container > table,
  :host(permission-management-tab) .table-container > table,
  :host(reports-page) .table-container > table { min-width:720px; }
  .table-container { max-width:100%; overflow-x:auto; }

  .list-browser { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-sm); padding:var(--space-md); color:var(--muted); font-size:var(--text-sm); }
  .list-browser input, .list-browser select { box-sizing:border-box; max-width:100%; min-width:0; padding:var(--space-sm); background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:var(--radius-sm); font:inherit; }
  .list-browser input { flex:1 1 12rem; width:12rem; }
  .list-browser label { display:flex; align-items:center; gap:var(--space-xs); }
  .list-browser .list-range { flex:1 1 100%; overflow-wrap:anywhere; }
  .list-browser :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
`;

export function renderListBrowser(browser: ListBrowser, total: number, loaded: number, label: string, update: () => void, scope = '已载入') {
  const pages = Math.max(1, Math.ceil(total / browser.size));
  const change = (action: () => void) => { action(); update(); };
  return html`<div class="list-browser" role="group" aria-label=${`${label}浏览`}>
    <input type="search" aria-label=${`搜索${label}`} placeholder="按名称或标识搜索" .value=${browser.query}
      @input=${(event: Event) => change(() => { browser.query = (event.target as HTMLInputElement).value; browser.page = 1; })}>
    <label>排序<select aria-label=${`${label}排序`} .value=${browser.descending ? 'desc' : 'asc'}
      @change=${(event: Event) => change(() => { browser.descending = (event.target as HTMLSelectElement).value === 'desc'; browser.page = 1; })}>
      <option value="asc">名称升序</option><option value="desc">名称降序</option>
    </select></label>
    <label>每页<select aria-label=${`${label}每页条数`} .value=${String(browser.size)}
      @change=${(event: Event) => change(() => { browser.size = Number((event.target as HTMLSelectElement).value); browser.page = 1; })}>
      ${[25, 50, 100].map(size => html`<option value=${size}>${size}</option>`)}
    </select></label>
    <button class="btn" aria-label=${`${label}：上一页`} ?disabled=${browser.page <= 1} @click=${() => change(() => browser.page--)}>上一页</button>
    <span>第 ${browser.page} / ${pages} 页</span>
    <button class="btn" aria-label=${`${label}：下一页`} ?disabled=${browser.page >= pages} @click=${() => change(() => browser.page++)}>下一页</button>
    <span class="list-range" role="status">${scope} ${loaded} 条 · 匹配 ${total} 条 · 当前 ${total ? (browser.page - 1) * browser.size + 1 : 0}–${Math.min(browser.page * browser.size, total)}${total === 0 ? ' · 无匹配结果' : ''}</span>
  </div>`;
}
