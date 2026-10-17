/** Layout from the user-approved unified-collection-prototype R1 (2026-10-16).
 * Product data, controls and state remain owned by the live components. */
export const collectionLayoutStyles = `
  :host{display:block;min-width:0;color:var(--text)}
  *,*::before,*::after{box-sizing:border-box}
  h2,h3,p{margin:0} h2{font-size:17px;font-weight:600;color:var(--text-strong)}
  h3{font-size:14px;font-weight:600;color:var(--text-strong)} p{margin-top:6px;overflow-wrap:anywhere}
  .muted,small{font-size:12px;color:var(--muted)} small{display:block;margin-top:4px}
  .edit-grid{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:var(--space-xl);align-items:start}
  .stack{display:grid;gap:var(--space-xl);min-width:0}
  .section-title,.template-heading,.editor-actions,.detail-intro{display:flex;gap:var(--space-md);align-items:center;justify-content:space-between}
  .eyebrow{display:block;font-size:11px;color:var(--muted);margin-bottom:6px}
  .section-description{margin:6px 0 var(--space-xl);color:var(--muted);font-size:12px}
  .template-preview{margin-top:var(--space-md);padding:18px;background:var(--accent-subtle);border:1px solid color-mix(in srgb,var(--accent) 18%,var(--border));border-radius:var(--radius-md)}
  .template-heading{justify-content:flex-start;padding-bottom:var(--space-md);border-bottom:1px solid var(--border);margin-bottom:var(--space-sm)}
  .template-heading>div:nth-child(2){flex:1;min-width:0;overflow-wrap:anywhere}.template-heading h3{color:var(--accent-text)}
  .template-icon{width:36px;height:38px;display:grid;place-items:center;background:var(--card);border-radius:var(--radius-sm);color:var(--accent-text)}
  .template-icon svg{width:21px;height:21px}
  .coverage-line{display:flex;gap:var(--space-lg);margin-top:var(--space-sm);font-size:12px;align-items:baseline}
  .coverage-line>:last-child{min-width:0;overflow-wrap:anywhere}.coverage-line>span:first-child{color:var(--muted);min-width:72px}.coverage-line strong{color:var(--accent-text)}
  .section-divider{height:1px;background:var(--border);margin:var(--space-xl) 0}
  .fields{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-lg)}
  input,select{width:100%;min-width:0;border:1px solid var(--border-strong);background:var(--card);color:var(--text);border-radius:var(--radius-sm);padding:9px 11px;font:inherit;font-size:13px}
  .actions{display:flex;gap:var(--space-sm);align-items:center;flex-wrap:wrap}
  .editor-actions{border-top:1px solid var(--border);padding-top:var(--space-lg);margin-top:var(--space-xl)}
  .advanced,.technical{border-top:1px solid var(--border);margin-top:var(--space-lg);padding-top:var(--space-md);font-size:12px}
  summary{cursor:pointer} pre{white-space:pre-wrap;overflow-wrap:anywhere}
  .key-values{margin:var(--space-lg) 0;display:grid;gap:13px;font-size:12px}
  .key-values>div{display:flex;gap:var(--space-md);justify-content:space-between;align-items:baseline}
  .key-values dt{color:var(--muted)}.key-values dd{margin:0;text-align:right;color:var(--text-strong);overflow-wrap:anywhere}
  .quiet-panel{padding:0 var(--space-sm)}
  .vertical-steps{list-style:none;padding:0 0 0 23px;margin:var(--space-lg) 0 0}
  .vertical-steps li{position:relative;border-left:1px solid var(--border-strong);padding:0 0 23px 20px;font-size:12px;color:var(--muted)}
  .vertical-steps li:last-child{border:0;padding-bottom:0}
  .vertical-steps li:before{content:attr(data-step);position:absolute;left:-10px;top:0;width:18px;height:18px;border-radius:var(--radius-full);background:var(--bg-accent);display:grid;place-items:center;font-size:10px;border:1px solid var(--border)}
  .vertical-steps li.done:before{content:'✓';background:var(--accent-subtle);color:var(--accent-text)}
  .vertical-steps li.current{color:var(--accent-text)}.vertical-steps li.current:before{background:var(--accent);color:var(--accent-foreground)}
  .vertical-steps li span{display:block;font-size:11px;color:var(--muted);margin-top:4px}
  .coverage-table>div{display:grid;grid-template-columns:minmax(100px,1fr) 115px minmax(0,1fr);gap:var(--space-md);align-items:center;padding:13px 0;border-top:1px solid var(--border);font-size:12px}
  .coverage-table{margin-top:var(--space-lg)}.coverage-table>div>span{color:var(--muted);font-size:11px}
  .notice{padding:var(--space-md) var(--space-lg);background:var(--accent-subtle);border:1px solid var(--border);border-radius:var(--radius-md);margin-bottom:var(--space-lg);font-size:12px}
  .notice.error{background:var(--danger-subtle);color:var(--danger)}
  .fact-strip{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:var(--space-xl);margin:27px 0}
  .fact-strip>div{border-right:1px solid var(--border);padding-right:var(--space-xl)}.fact-strip>div:last-child{border:0}
  .fact-strip span{font-size:12px;color:var(--muted);display:block}.fact-strip strong{display:block;margin-top:7px;font-size:17px;color:var(--text-strong)}
  .detail-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:var(--space-xl);margin-top:var(--space-xl)}
  .activation-steps{list-style:none;margin:var(--space-xl) 0;padding:0}
  .activation-steps li{display:flex;gap:var(--space-md);padding:var(--space-md) 0;border-bottom:1px solid var(--border);align-items:flex-start;font-size:13px}
  .activation-steps li>div{flex:1}.activation-steps li p{font-size:12px;color:var(--muted)}
  .step-number{width:25px;height:25px;display:grid;place-items:center;border-radius:var(--radius-full);background:var(--bg-accent);font-size:12px;flex-shrink:0}
  .activation-steps li.current .step-number{background:var(--accent);color:var(--accent-foreground)}
  .activation-steps li.done .step-number{color:var(--accent-text);background:var(--accent-subtle)}
  app-card:not(:has([slot=header]))::part(header),app-card:not(:has([slot=footer]))::part(footer){display:none}
  :focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  @media(max-width:1100px){.edit-grid,.detail-grid{grid-template-columns:minmax(0,1fr)}.edit-grid>aside.stack{grid-template-columns:1fr 1fr}}
  @media(max-width:700px){.edit-grid>aside.stack,.fields,.fact-strip{grid-template-columns:minmax(0,1fr)}.editor-actions,.detail-intro{align-items:flex-start;flex-direction:column}.editor-actions>.actions{justify-content:flex-end;width:100%}.template-preview{padding:var(--space-md)}.template-icon{display:none}.coverage-line{gap:var(--space-sm);align-items:flex-start}.coverage-table>div{grid-template-columns:minmax(0,1fr) 115px}.coverage-table>div>span{grid-column:1/-1}.fact-strip>div{border-right:0;border-bottom:1px solid var(--border);padding:0 0 var(--space-md)}}
`;
