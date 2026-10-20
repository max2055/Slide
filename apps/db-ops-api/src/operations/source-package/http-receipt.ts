import { INVESTIGATION_ERROR_STATUS } from '../../investigations/contracts.js';

/** Only allowlisted codes leave the transient, bounded response buffer.
 * No response text, headers, request/token or arbitrary error is retained. */
export class SourceHttpRejection extends Error {
  constructor(code: 'CONTINUATION_HTTP_REJECTED' | 'HTTP_REJECTED', readonly receipt: { status: number; code?: string }) {
    super(`V23_SOURCE_${code}`);
  }
}
export async function rejectSourceHttp(response: Response, code: 'CONTINUATION_HTTP_REJECTED' | 'HTTP_REJECTED'): Promise<never> {
  const receipt: { status: number; code?: string } = { status: response.status };
  const reader = response.body?.getReader();
  if (reader) {
    let buffer = Buffer.alloc(0);
    // A hanging error body must not erase the already received status or hold
    // the operation past its deadline. No timeout triggers another send.
    const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 1000);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (buffer.length + value.byteLength > 1024) { buffer = Buffer.alloc(0); break; }
        buffer = Buffer.concat([buffer, value]);
      }
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (typeof parsed?.error === 'string' && Object.hasOwn(INVESTIGATION_ERROR_STATUS, parsed.error)
        && INVESTIGATION_ERROR_STATUS[parsed.error as keyof typeof INVESTIGATION_ERROR_STATUS] === response.status)
        receipt.code = parsed.error;
    } catch { /* status remains authoritative; body is neither logged nor trusted */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  throw new SourceHttpRejection(code, receipt);
}
