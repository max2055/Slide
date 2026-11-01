import '../../src/app/ui/components/app-toast-container.ts';
import '../../src/app/ui/components/native-template-configuration.ts';

// The real native-template component, driven only through its own DOM. The API
// behind the Vite proxy is the real Fastify server over a disposable MySQL and
// a real read-only target; no response is routed or fulfilled by the test.
//
// A signed session token supplies the stable principal the component derives
// its recovery key from; the server fixture ignores the signature and attaches
// the seeded principal itself.
const payload = btoa(JSON.stringify({ userId: 1, sessionVersion: 1 }))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
localStorage.setItem('token', `header.${payload}.signature`);

document.body.append(document.createElement('app-toast-container'));
const element = document.createElement('native-template-configuration') as HTMLElement & { resourceType: string; resourceId: number };
element.resourceType = 'instance';
element.resourceId = 1;
document.body.append(element);
