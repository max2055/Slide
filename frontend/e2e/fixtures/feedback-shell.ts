import { expect, type Page } from '@playwright/test';

export async function openFeedbackFromSidebar(page: Page, token = 'feedback-fixture', permissions = ['*']) {
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
  }, { token, permissions });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route(url => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/feedback'), route =>
    route.fulfill({ json: new URL(route.request().url()).pathname === '/api/auth/permissions' ? permissions : {} }));
  await page.goto('/dashboard');
  await page.locator('.sidebar-utility-group').getByRole('link', { name: '问题反馈', exact: true }).click();
  await expect(page).toHaveURL(/\/feedback(?:\?|$)/);
  return page.locator('feedback-page');
}
