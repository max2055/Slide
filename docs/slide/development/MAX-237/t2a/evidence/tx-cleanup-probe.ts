/**
 * MAX-237 / T2A-TX-CLEANUP — review counterexamples replayed against the
 * adapter, with the minimal change the new discard contract needs: the fault
 * wrapper forwards `destroy()` and counts release vs. discard.
 *
 * Source: Chief `chief-transaction-probes.ts` (2026-10-27 review), assertions
 * unchanged apart from also requiring that the failed connection was discarded
 * rather than released. Run against the exact worktree and the disposable
 * `max237_t2a` fixture:
 *
 *   MAX237_T2A_MYSQL_PORT=... MAX237_T2A_MYSQL_USER=... \
 *   MAX237_T2A_MYSQL_PASSWORD=... MAX237_T2A_MYSQL_DATABASE=max237_t2a \
 *   apps/db-ops-api/node_modules/.bin/tsx \
 *   docs/slide/development/MAX-237/t2a/evidence/tx-cleanup-probe.ts "$PWD"
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

async function main() {
  const root = resolve(process.argv[2]);
  const require = createRequire(resolve(root, 'apps/db-ops-api/package.json'));
  const mysql = require('mysql2/promise');
  const load = (path: string) => import(pathToFileURL(resolve(root, 'apps/db-ops-api/src/', path)).href);
  const { MySqlTemplateRepository } = await load('metrics/templates/mysql-repository.ts');
  const { emptyDraftAggregate } = await load('metrics/templates/model.ts');
  const options = {
    host: '127.0.0.1', port: Number(process.env.MAX237_T2A_MYSQL_PORT),
    user: process.env.MAX237_T2A_MYSQL_USER, password: process.env.MAX237_T2A_MYSQL_PASSWORD,
    database: process.env.MAX237_T2A_MYSQL_DATABASE, connectionLimit: 1,
  };
  assert.equal(options.database, 'max237_t2a');
  const observer = mysql.createPool(options);
  const at = '2026-10-27T00:00:00.000Z';
  const record = (id: string) => ({ template_id: id, name: id, status: 'draft',
    current_published_version: null, revision: 0, created_by: null, created_at: at, updated_at: at });
  const draft = (id: string) => ({ template_id: id, revision: 0, aggregate: emptyDraftAggregate(id),
    published_version: null, updated_by: null, updated_at: at });
  const counts = async (id: string) => {
    const [rows] = await observer.execute(`SELECT
      (SELECT COUNT(*) FROM metric_templates_v2 WHERE template_id=?) AS parents,
      (SELECT COUNT(*) FROM metric_template_drafts WHERE template_id=?) AS drafts`, [id, id]);
    return { parents: Number(rows[0].parents), drafts: Number(rows[0].drafts) };
  };
  const reset = async (id: string) => {
    // Probe scope only: the two id pairs this run creates. Leaves every other row
    // in the disposable fixture untouched.
    for (const target of [id, id + '-next']) {
      for (const table of ['metric_template_item_versions', 'metric_template_items', 'metric_template_versions',
        'metric_template_drafts', 'metric_templates_v2']) {
        await observer.execute(`DELETE FROM ${table} WHERE template_id = ?`, [target]);
      }
    }
  };

  const runMode = async (mode: string) => {
    const inner = mysql.createPool(options);
    const id = mode === 'rollback-failure' ? 'cleanup-rollback-leak' : 'cleanup-commit-leak';
    try {
      await reset(id);
      let injected = false;
      let releases = 0;
      let destroys = 0;
      const faulty = {
        async getConnection() {
          const connection = await inner.getConnection();
          return {
            execute: async (sql: string, values?: any[]) => {
              if (mode === 'rollback-failure' && !injected && sql.startsWith('INSERT INTO metric_template_drafts')) {
                injected = true;
                throw new Error('probe: fail draft insert after real parent insert');
              }
              return connection.execute(sql, values);
            },
            beginTransaction: () => connection.beginTransaction(),
            commit: async () => {
              if (mode === 'commit-not-sent-live-connection') {
                throw new Error('probe: commit acknowledgement unavailable before forwarding; socket remains live');
              }
              return connection.commit();
            },
            rollback: async () => {
              if (mode === 'rollback-failure') throw new Error('probe: rollback unavailable; socket remains live');
              return connection.rollback();
            },
            release: () => { releases += 1; connection.release(); },
            destroy: () => { destroys += 1; connection.destroy(); },
          };
        },
      };
      let error: any;
      try { await new MySqlTemplateRepository(faulty).create(record(id), draft(id)); }
      catch (caught) { error = caught; }
      assert.ok(error);
      const independentBefore = await counts(id);
      const reused = new MySqlTemplateRepository(inner);
      const readOnReleasedConnection = await reused.getTemplate(id);
      // START TRANSACTION implicitly commits a still-active transaction in MySQL.
      // A completely different, valid repository write must not commit the
      // previous failed/unknown operation's pending rows.
      await reused.create(record(id + '-next'), draft(id + '-next'));
      const independentAfter = await counts(id);
      const samePoolAfterCreate = await reused.getTemplate(id);
      const expectedUnknownCommit = mode === 'commit-not-sent-live-connection';
      const pass = Boolean(error)
        && (expectedUnknownCommit
          ? error.code === 'TEMPLATE_STORAGE_UNKNOWN_COMMIT'
          : error.name === 'Error' && error.code === undefined)
        && releases === 0 && destroys === 1
        && readOnReleasedConnection === null && samePoolAfterCreate === null
        && independentAfter.parents === 0 && independentAfter.drafts === 0;
      return {
        id: mode, pass,
        error: { name: error.name, code: error.code ?? null },
        released_to_pool: releases,
        discarded: destroys,
        independent_before: independentBefore,
        same_pool_read_saw_uncommitted_parent: readOnReleasedConnection !== null,
        same_pool_after_unrelated_create: samePoolAfterCreate !== null,
        independent_after_unrelated_create: independentAfter,
        expected: 'failed/unknown transaction never returned live to pool; no pending rows visible on reuse or committed by another operation',
      };
    } finally {
      await inner.end();
    }
  };

  const results: any[] = [];
  try {
    for (const mode of ['rollback-failure', 'commit-not-sent-live-connection']) results.push(await runMode(mode));
  } finally {
    await observer.end();
  }
  console.log(JSON.stringify({ source_root: root, fixture: 'new owned max237_t2a; two real independent pools; connectionLimit 1', results }, null, 2));
  process.exitCode = results.every(result => result.pass) ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
