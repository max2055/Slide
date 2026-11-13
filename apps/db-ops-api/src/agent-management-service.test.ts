import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./skills/loader.js', () => ({ skillRegistry: {} }));
vi.mock('./adapter/get-agent-engine.js', () => ({ getAgentEngine: vi.fn() }));
vi.mock('./skills/runtime-policy.js', () => ({ isSkillEnabled: vi.fn(), setSkillEnabled: vi.fn() }));
vi.mock('./tools/security-catalog.js', () => ({ getToolSecurityDefinition: vi.fn() }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: vi.fn() } }));
import { dbConnection } from './db-connection.js';
import { agentManagementService as service, type AgentExtensionRecord } from './agent-management-service.js';
let row: Record<string, unknown>;
const execute = vi.fn(async (sql: string, args: any[]) => {
  if (sql.startsWith('INSERT')) {
    const [kind, name, description, definition_json, source_text, digest] = args;
    row = { id: 1, kind, name, description, definition_json, source_text, digest, status: 'draft', version: 1 };
    return [{ insertId: 1 }];
  }
  if (sql.startsWith('UPDATE')) {
    const [name, description, definition_json, source_text, digest] = args;
    Object.assign(row, { name, description, definition_json, source_text, digest }); return [{ affectedRows: 1 }];
  }
  return [[row]];
});
function check(record: AgentExtensionRecord) {
  const { kind, name, description, definition, sourceText } = record;
  expect(record.digest).toBe(createHash('sha256').update(JSON.stringify({ kind, name, description, definition, sourceText })).digest('hex'));
}
beforeEach(() => { vi.mocked(dbConnection.getPool).mockReturnValue({ execute } as any); });
afterEach(() => vi.clearAllMocks());
it.each([2000, 2001])('#477 create/update digest represents persisted %i character description', async length => {
  const created = await service.createExtension({ kind: 'skill', name: 'sample', description: 'x'.repeat(length), definition: { frontmatter: {} }, sourceText: 'note' }, 1);
  expect(created.description).toHaveLength(2000); check(created);
  const updated = await service.updateExtension(1, { description: 'y'.repeat(length) }, 1);
  expect(updated!.description).toBe('y'.repeat(2000)); expect(updated!.sourceText).toBe('note'); check(updated!);
});
it('#477 omitted/null description preserves current, empty clears; source null clears and definition/name survive', async () => {
  const created = await service.createExtension({ kind: 'skill', name: 'sample', description: 'original', definition: { frontmatter: { a: 1 } }, sourceText: 'note' }, 1); check(created);
  for (const input of [{}, { description: null }]) {
    const updated = await service.updateExtension(1, input as any, 1); expect(updated!.description).toBe('original'); expect(updated!.definition).toEqual(created.definition); check(updated!);
  }
  const cleared = await service.updateExtension(1, { description: '', sourceText: null }, 1); expect(cleared!.description).toBe(''); expect(cleared!.sourceText).toBeNull(); check(cleared!);
});
it('#477 create null/omitted descriptions normalize to empty and long source is hashed after truncation', async () => {
  for (const description of [undefined, null, '']) {
    const created = await service.createExtension({ kind: 'skill', name: 'sample', description: description as any }, 1); expect(created.description).toBe(''); check(created);
  }
  const updated = await service.updateExtension(1, { sourceText: 's'.repeat(256 * 1024 + 1) }, 1); expect(updated!.sourceText).toHaveLength(256 * 1024); check(updated!);
});
