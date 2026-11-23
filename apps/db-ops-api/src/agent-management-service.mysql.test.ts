import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerExtensionRoutes } from '../tests/fixtures/extension-routes.js';
import type { AgentExtensionRecord } from './agent-management-service.js';

const control = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: () => control.pool } }));
vi.mock('./skills/loader.js', () => ({ skillRegistry: {} }));
vi.mock('./adapter/get-agent-engine.js', () => ({ getAgentEngine: vi.fn() }));
vi.mock('./skills/runtime-policy.js', () => ({ isSkillEnabled: vi.fn(), setSkillEnabled: vi.fn() }));
vi.mock('./tools/security-catalog.js', () => ({ getToolSecurityDefinition: vi.fn() }));

const port = process.env.AGENT_EXTENSION_TEST_MYSQL_PORT;
const url = '/api/agent/extensions';
const sha256 = (json: string) => createHash('sha256').update(json, 'utf8').digest('hex');

describe.skipIf(port === undefined)('#1027 extension digest with isolated MySQL', () => {
  let owner: Pool | undefined;
  let pool: Pool;
  let app: FastifyInstance | undefined;
  const schema = `max704_${process.pid}_${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    const config = { host: '127.0.0.1', port: Number(port), user: 'root', password: '', charset: 'utf8mb4' };
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid test MySQL port');
    owner = mysql.createPool(config);
    await owner.query(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4`);
    pool = mysql.createPool({ ...config, database: schema });
    await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES (1)');
    await pool.query(readFileSync(new URL('../sql/migrations/076_agent_extensions.sql', import.meta.url), 'utf8'));
    control.pool = pool;
    app = Fastify();
    registerExtensionRoutes(app, async request => {
      Object.assign(request, { user: { userId: 1, username: 'fixture', roles: [], permissions: ['*'] } });
    });
  });

  afterAll(async () => {
    await app?.close();
    control.pool = null;
    await pool?.end();
    if (owner) {
      try {
        await owner.query(`DROP DATABASE IF EXISTS ${schema}`);
      } finally {
        await owner.end();
      }
    }
  });

  async function list() {
    const response = await app!.inject(url);
    expect(response.statusCode).toBe(200);
    return response.json<{ extensions: AgentExtensionRecord[] }>().extensions;
  }

  it('agrees across create, update, MySQL readback and independent audit recomputation', async () => {
    const description = 'x'.repeat(1999) + '�';
    const sourceText = 's'.repeat(256 * 1024 - 1) + '�';
    const rawDefinition = '{"zz":0,"z":null,"frontmatter":{"aLong":1,"z":true,"2":"two","10":"ten","é":1,"é":2},"items":[{"long":false,"a":2},3]}';
    const reordered = '{"items":[{"a":2,"long":false},3],"frontmatter":{"é":2,"é":1,"z":true,"aLong":1,"10":"ten","2":"two"},"z":null,"zz":0}';
    const canonical = '{"frontmatter":{"2":"two","10":"ten","aLong":1,"é":1,"z":true,"é":2},"items":[{"a":2,"long":false},3],"z":null,"zz":0}';
    const kind = 'skill';
    const name = 'digestRoundTrip';
    const definition = JSON.parse(rawDefinition);
    const content = {
      kind, name, definition, description: description.slice(0, -1) + '🛠', sourceText: sourceText.slice(0, -1) + '🛠',
    };
    const response = await app!.inject({ method: 'POST', url, payload: content });
    expect(response.statusCode).toBe(201);
    const { extension: created } = response.json<{ extension: AgentExtensionRecord }>();
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT definition_json, digest FROM agent_extensions WHERE id = ?', [created.id]);
    expect(Object.keys(rows[0].definition_json)).not.toEqual(Object.keys(definition));
    expect(created.definition).toEqual(definition);
    expect(created.description).toBe(description);
    expect(created.sourceText).toBe(sourceText);

    const auditDigest = (record: AgentExtensionRecord, definitionJson: string) => {
      expect(record.definition).toEqual(JSON.parse(definitionJson));
      return sha256(`{"kind":${JSON.stringify(record.kind)},"name":${JSON.stringify(record.name)},"description":${JSON.stringify(record.description)},"definition":${definitionJson},"sourceText":${JSON.stringify(record.sourceText)}}`);
    };
    expect(created.digest).toBe(auditDigest(created, canonical));
    expect(rows[0].digest).toBe(created.digest);

    const updateUrl = `${url}/${created.id}`;
    const reorderedDefinition = JSON.parse(reordered);
    const equivalentCreate = await app!.inject({ method: 'POST', url, payload: { ...content, definition: reorderedDefinition } });
    expect(equivalentCreate.statusCode).toBe(201);
    expect(equivalentCreate.json().extension.digest).toBe(created.digest);
    const equivalent = await app!.inject({ method: 'PUT', url: updateUrl, payload: { definition: reorderedDefinition } });
    expect(equivalent.statusCode).toBe(200);
    expect(equivalent.json().extension.digest).toBe(created.digest);
    const readback = (await list()).find(item => item.id === created.id)!;
    expect(readback.digest).toBe(auditDigest(readback, canonical));

    // An array reorder changes the content, even with the same objects and values.
    reorderedDefinition.items.reverse();
    const changed = await app!.inject({ method: 'PUT', url: updateUrl, payload: { definition: reorderedDefinition } });
    expect(changed.statusCode).toBe(200);
    const updated = (await list()).find(item => item.id === created.id)!;
    const updatedCanonical = canonical.replace('[{"a":2,"long":false},3]', '[3,{"a":2,"long":false}]');
    expect(updated.digest).toBe(auditDigest(updated, updatedCanonical));
    expect(updated.digest).toBe(changed.json().extension.digest);
    expect(updated.digest).not.toBe(created.digest);
  });

  it('retains historical digests until a draft is saved', async () => {
    const definition = { z: 1, a: 2 };
    const seed = async (name: string) => {
      const content = { kind: 'skill', name, description: '', definition, sourceText: null };
      const digest = sha256(JSON.stringify(content));
      const [result] = await pool.execute<ResultSetHeader>(
        "INSERT INTO agent_extensions (kind, name, definition_json, digest, created_by, updated_by) VALUES ('skill', ?, ?, ?, 1, 1)",
        [name, JSON.stringify(definition), digest],
      );
      return { id: result.insertId, digest, content };
    };
    const preserved = await seed('legacyPublished');
    const edited = await seed('legacyDraft');
    expect((await list()).find(item => item.id === preserved.id)?.digest).toBe(preserved.digest);
    const publish = await app!.inject({ method: 'POST', url: `${url}/${preserved.id}/publish` });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().extension.digest).toBe(preserved.digest);
    const archive = await app!.inject({ method: 'DELETE', url: `${url}/${preserved.id}` });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().extension.digest).toBe(preserved.digest);
    const save = await app!.inject({ method: 'PUT', url: `${url}/${edited.id}`, payload: {} });
    expect(save.statusCode).toBe(200);
    const canonicalDigest = sha256(JSON.stringify({ ...edited.content, definition: { a: 2, z: 1 } }));
    expect(canonicalDigest).not.toBe(edited.digest);
    expect(save.json().extension.digest).toBe(canonicalDigest);
    expect((await list()).find(item => item.id === edited.id)?.digest).toBe(canonicalDigest);
  });
});
