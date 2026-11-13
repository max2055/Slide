import { afterEach, expect, it, vi } from 'vitest';
import { SlideApp } from './app.ts';

// Exercise the application's callback, not a stand-in lifecycle host (MAX-653).
afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

it('restores the tab and session from location without writing history', () => {
  const app = new SlideApp();
  app.connected = false;
  const push = vi.spyOn(window.history, 'pushState');
  window.history.replaceState({}, '', '/feedback?session=history-session');
  app.popStateHandler();
  expect(app.tab).toBe('feedback');
  expect(app.sessionKey).toBe('history-session');
  expect(push).not.toHaveBeenCalled();
  window.history.replaceState({}, '', '/dashboard');
  app.popStateHandler();
  expect(app.tab).toBe('dashboard');
  expect(app.sessionKey).toBe('history-session');
  expect(push).not.toHaveBeenCalled();
});

it('retains detail IDs and leaves unknown business locations alone', () => {
  const app = new SlideApp();
  window.history.replaceState({}, '', '/server-detail?tab=server-detail&id=7');
  app.popStateHandler();
  expect(app.tab).toBe('server-detail');
  expect((app as any).serverId).toBe(7);
  window.history.replaceState({}, '', '/network-device-detail?tab=network-device-detail&networkDeviceId=9');
  app.popStateHandler();
  expect(app.tab).toBe('network-device-detail');
  expect((app as any).networkDeviceId).toBe(9);
  const tab = app.tab;
  window.history.replaceState({}, '', '/unrecognized-business-route');
  app.popStateHandler();
  expect(app.tab).toBe(tab);
});
