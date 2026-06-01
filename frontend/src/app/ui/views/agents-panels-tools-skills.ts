import { html } from "lit";

function renderUnavailablePage(title: string, message: string) {
  return html`<section class="card" style="text-align:center;padding:64px 24px"><h2 style="margin:0 0 8px 0">${title}</h2><p style="color:var(--muted);margin:0">${message}</p></section>`;
}

export function renderAgentTools(params: any) {
  return renderUnavailablePage('Tool Access', 'DirectAdapter 模式下此功能暂不可用');
}

export function renderAgentSkills(params: any) {
  return renderUnavailablePage('Skills', 'DirectAdapter 模式下此功能暂不可用');
}
