// Test-process preload. Inspector supplies engine frames; never read exception properties.
import inspector from 'node:inspector';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
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
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const role = /(?:^|\/)server\.ts$/.test(process.argv[1] ?? '') ? 'api' : 'test-process';
    const emit = value => {
      try { process.stderr.write(JSON.stringify({ role, ...value }) + '\n'); } catch { /* Preserve original process behavior. */ }
    };
    emit({ event: 'test-observer-ready' });
    process.on('exit', code => emit({ event: 'test-observer-exit', code }));
    const session = new inspector.Session(); session.connect();
    session.on('Runtime.exceptionThrown', ({ params }) => {
      try {
        const frames = (params.exceptionDetails.stackTrace?.callFrames ?? []).slice(0, 8)
          .map(frame => safeFrame(frame, root)).filter(Boolean);
        emit({ event: 'test-exception', type: 'unknown', frames });
      } catch { /* Diagnostics must not change exception handling. */ }
    });
    session.post('Runtime.enable'); session.unref?.();
    // A Node rejection listener makes V8 classify the rejection as caught.
    // Observe all pauses, emit only Promise rejection locations, always resume.
    // These observations do not themselves establish that a rejection is fatal.
    const scripts = new Map();
    const rejectedScripts = new Map();
    session.on('Debugger.scriptParsed', ({ params }) => {
      if (safeFrame({ url: params.url, lineNumber: 0, columnNumber: 0 }, root)) scripts.set(params.scriptId, params.url);
      else rejectedScripts.set(params.scriptId,
        typeof params.url !== 'string' || !params.url ? 'empty-url'
          : !params.url.startsWith('file:') ? 'non-file-url' : 'path-rejected');
    });
    session.on('Debugger.paused', ({ params }) => {
      try {
        if (params.reason !== 'promiseRejection') return;
        const synchronous = (params.callFrames ?? []).slice(0, 32).map(frame => ({
          url: scripts.get(frame.location.scriptId), lineNumber: frame.location.lineNumber, columnNumber: frame.location.columnNumber,
        }));
        const asynchronous = (params.asyncStackTrace?.callFrames ?? []).slice(0, 32);
        const mapping = { accepted: 0, 'empty-url': 0, 'non-file-url': 0, 'path-rejected': 0, 'unknown-script': 0 };
        for (const frame of (params.callFrames ?? []).slice(0, 32)) {
          const id = frame.location.scriptId;
          const category = scripts.has(id) ? 'accepted' : rejectedScripts.get(id) ?? 'unknown-script';
          mapping[category]++;
        }
        const frames = [...synchronous, ...asynchronous].map(frame => safeFrame(frame, root)).filter(Boolean);
        emit({ event: 'test-engine-pause', type: 'unknown', frameCount: synchronous.length + asynchronous.length, mapping, frames });
      } catch { /* Never inspect the exception remote object. */ }
      finally { try { session.post('Debugger.resume'); } catch { /* Original fatal path remains authoritative. */ } }
    });
    session.post('Debugger.enable');
    session.post('Debugger.setPauseOnExceptions', { state: 'all' });
  } catch { /* Optional observation only. */ }
}
