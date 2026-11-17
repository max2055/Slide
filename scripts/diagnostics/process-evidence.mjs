// Test-process preload. Inspector supplies engine frames; never read exception properties.
import inspector from 'node:inspector';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { types } from 'node:util';
export function safeFrame(frame, root) {
  try {
    if (!frame || types.isProxy(frame)) return null;
    const data = Object.getOwnPropertyDescriptors(frame);
    const url = data.url?.value, line = data.lineNumber?.value, column = data.columnNumber?.value;
    if (typeof url !== 'string' || !url.startsWith('file:') || /[?#\r\n]/.test(url)) return null;
    const path = relative(root, fileURLToPath(url));
    if (!path || path.startsWith('..') || path.includes('node_modules') || !/^[a-zA-Z0-9_./-]+\.(?:[cm]?js|ts)$/.test(path)) return null;
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(column) || column < 0) return null;
    return { path, line: line + 1, column: column + 1 };
  } catch { return null; }
}
if (process.env.SLIDE_TEST_PROCESS_EVIDENCE === '1') {
  try {
    const session = new inspector.Session(); session.connect();
    session.on('Runtime.exceptionThrown', ({ params }) => {
      try {
        const frames = (params.exceptionDetails.stackTrace?.callFrames ?? []).slice(0, 8)
          .map(frame => safeFrame(frame, resolve(process.cwd(), '../..'))).filter(Boolean);
        process.stderr.write(JSON.stringify({ event: 'test-exception', type: 'unknown', frames }) + '\n');
      } catch { /* Diagnostics must not change exception handling. */ }
    });
    session.post('Runtime.enable'); session.unref?.();
  } catch { /* Optional observation only. */ }
}
