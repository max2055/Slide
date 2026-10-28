import '../../src/app/ui/components/app-toast-container.ts';
import '../../src/app/ui/components/metric-configuration.ts';

// The real metric-configuration component, driven only through its own DOM.
// Every /api/ response is supplied by the Playwright spec; no development
// backend, provider, target database or trial is used here.
document.body.append(document.createElement('app-toast-container'));
const element = document.createElement('metric-configuration') as HTMLElement & { resourceType: string; resourceId: number };
element.resourceType = 'instance';
element.resourceId = 1;
document.body.append(element);
