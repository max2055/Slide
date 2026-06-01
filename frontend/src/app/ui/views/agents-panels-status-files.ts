import { html } from "lit";

function renderUnavailablePage(title: string, message: string) {
  return html`<section class="card" style="text-align:center;padding:64px 24px"><h2 style="margin:0 0 8px 0">${title}</h2><p style="color:var(--muted);margin:0">${message}</p></section>`;
}

export function renderAgentFiles(params: any) {
  return renderUnavailablePage('Agent Files', 'DirectAdapter 模式下此功能暂不可用');
}

export function renderAgentCron(params: any) {
  return renderUnavailablePage('Agent Cron', 'DirectAdapter 模式下此功能暂不可用');
}
