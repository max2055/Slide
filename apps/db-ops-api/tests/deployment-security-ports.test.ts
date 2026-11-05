import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diagnosticListenerFailures,
  retainedPortConstraintFailures,
} from '../../../tests/qualification/deployment-security.ts';

const LOOPBACK = '${SLIDE_HTTP_BIND:-127.0.0.1}:${SLIDE_HTTP_PORT:-8080}:8080';
const PUBLIC_BIND = '${SLIDE_HTTP_BIND:-0.0.0.0}:${SLIDE_HTTP_PORT:-8080}:8080';
const TLS_HTTPS = '${SLIDE_HTTPS_BIND:-0.0.0.0}:${SLIDE_HTTPS_PORT:-443}:8443';
const TLS_REDIRECT = '${SLIDE_REDIRECT_BIND:-0.0.0.0}:${SLIDE_HTTP_REDIRECT_PORT:-80}:8080';
const TLS_PORTS = [TLS_HTTPS, TLS_REDIRECT];
const MISSING = 'frontend must retain a loopback-only diagnostic listener';
const NOT_LOOPBACK = 'frontend port 8080 must default to loopback';
const API_INTERNAL = 'api and raw Agent WebSocket ports must remain internal';

describe('diagnostic listener gate (#466)', () => {
  it('rejects missing ports', () => {
    expect(diagnosticListenerFailures(undefined)).toEqual([MISSING]);
    expect(diagnosticListenerFailures(null)).toEqual([MISSING]);
  });

  it('rejects an empty ports array', () => {
    expect(diagnosticListenerFailures([])).toEqual([MISSING]);
  });

  it('rejects a listener that is not loopback', () => {
    expect(diagnosticListenerFailures([PUBLIC_BIND])).toEqual([NOT_LOOPBACK]);
    expect(diagnosticListenerFailures([LOOPBACK, PUBLIC_BIND])).toEqual([NOT_LOOPBACK]);
  });

  it('accepts only when every published listener defaults to loopback', () => {
    expect(diagnosticListenerFailures([LOOPBACK])).toEqual([]);
    expect(diagnosticListenerFailures([LOOPBACK, LOOPBACK])).toEqual([]);
  });

  it('rejects a truthy non-array that does not publish a listener', () => {
    expect(diagnosticListenerFailures('SLIDE_HTTP_BIND:-127.0.0.1')).toEqual([MISSING]);
  });
});

describe('retained TLS edge and API port constraints', () => {
  it('keeps API ports internal and still requires both TLS publications', () => {
    expect(retainedPortConstraintFailures(undefined, [LOOPBACK], TLS_PORTS)).toEqual([]);
    expect(retainedPortConstraintFailures(['3000:3000'], [LOOPBACK], TLS_PORTS)).toEqual([API_INTERNAL]);
    expect(retainedPortConstraintFailures([], [LOOPBACK], TLS_PORTS)).toEqual([API_INTERNAL]);
    expect(retainedPortConstraintFailures(undefined, [LOOPBACK], undefined)).toEqual([
      'TLS edge must publish HTTPS and the HTTP redirect',
      'TLS edge must publish HTTPS',
      'TLS edge must publish the HTTP redirect',
    ]);
    expect(retainedPortConstraintFailures(undefined, [LOOPBACK], [])).toEqual([
      'TLS edge must publish HTTPS',
      'TLS edge must publish the HTTP redirect',
    ]);
    expect(retainedPortConstraintFailures(undefined, [], TLS_PORTS)).toEqual([MISSING]);
  });
});

describe('deployment security entrypoint', () => {
  it('passes the repository compose through the documented gate', () => {
    const script = resolve(import.meta.dirname, '../../../tests/qualification/deployment-security.ts');
    const result = spawnSync('pnpm', ['exec', 'tsx', script], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deployment security invariants passed');
  });
});
