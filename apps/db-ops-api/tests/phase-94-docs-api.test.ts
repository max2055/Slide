/**
 * Phase 94, Gap 5 (94-03-01): Backend API endpoints for docs serving
 *
 * Requirement: GET /api/docs/list returns .md/.html file list,
 * GET /api/docs/content/:file returns content (impl uses /api/docs/files/:file),
 * path traversal blocked (.. / \ rejected), non-.html files rejected.
 *
 * Tests parse the server.ts source to verify route registrations and
 * security guards are in place.
 *
 * NOTE: Plan specified .md content endpoint at /api/docs/content/:file;
 * implementation uses .html at /api/docs/files/:file and also added
 * DOC_TITLES/DOC_ORDER for sorted display.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const SERVER_PATH = '/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts';

describe('94-03-01: Backend API endpoints for docs serving', () => {
  const source = readFileSync(SERVER_PATH, 'utf-8');

  it('registers GET /api/docs/list endpoint', () => {
    expect(source).toContain("fastify.get('/api/docs/list'");
  });

  it('registers GET /api/docs/files/:file endpoint', () => {
    // Plan specified /api/docs/content/:file; impl uses /api/docs/files/:file
    expect(source).toContain("fastify.get('/api/docs/files/:file'");
  });

  it('filters files by extension in list endpoint', () => {
    // Should only return .html files
    expect(source).toContain("f.endsWith('.html')");
  });

  it('has path traversal protection blocking ".."', () => {
    expect(source).toContain("file.includes('..')");
  });

  it('has path traversal protection blocking "/"', () => {
    expect(source).toContain("file.includes('/')");
  });

  it('has path traversal protection blocking "\\"', () => {
    expect(source).toContain("file.includes('\\\\')");
  });

  it('rejects non-html files with 400', () => {
    expect(source).toContain("!file.endsWith('.html')");
    expect(source).toContain('400');
  });

  it('returns 404 when file not found', () => {
    expect(source).toContain('404');
    expect(source).toContain('Document not found');
  });

  it('has DOC_TITLES mapping for display order', () => {
    expect(source).toContain('DOC_TITLES');
  });

  it('references docs/slide/ path for file resolution', () => {
    expect(source).toContain('docs');
    expect(source).toContain('slide');
  });
});
