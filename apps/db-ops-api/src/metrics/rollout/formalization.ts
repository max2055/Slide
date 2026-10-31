import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { validateObservation, type NormalizedObservation, type RawObservation } from '../../contracts/metrics/index.js';
import { type PackageRegistry, stable } from '../packages/model.js';
import { type Ref, refKey, rule } from '../policy/model.js';
import { seriesHash } from '../storage.js';
import { rolloutAlertLockName } from './alert-publication-fence.js';
import { assetCollectionEnabled } from '../config/effective-state.js';
import { sourceHistory } from './source-history.js';
import { readStoredBinding } from '../bindings/package-reader.js';
import type { DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import type { PackagePin } from '../../contracts/metrics/templates.js';

const decode = <T>(value: string | T): T => typeof value === 'string' ? JSON.parse(value) : value;

/** What one fenced acceptance attempt did; a template row is never cached as formalized. */
type Acceptance = 'formalized' | 'template' | 'skipped';

/** Reconcile persisted, real measurement evidence. Never trusts a caller-supplied all-zero shadow gate.
 * Runs outside collection transactions, taking publication fences BEFORE the policy lock. */
export class MetricFormalization {
  // A restart deliberately revalidates once. This is only a work-elision hint:
  // every changed batch/policy/migration still passes the fenced transaction.
  private readonly reconciled = new Map<string, string>();
  constructor(private pool: Pool, private registry: PackageRegistry, private clock = () => new Date()) {}
  private async fingerprint(c: Pick<Pool | PoolConnection, 'execute'>, ref: Ref, revision: number): Promise<string | null> {
    const [rows] = await c.execute<RowDataPacket[]>(`SELECT SHA2(CAST(JSON_ARRAY(b.payload,s.payload,
      r.phase,r.revision,r.generation,r.gate_json) AS CHAR),256) AS fingerprint
      FROM metric_policy_bindings b
      JOIN metric_source_checks s ON s.resource_key=b.resource_key AND s.revision=?
      LEFT JOIN metric_rollout_resources r ON r.resource_key=b.resource_key
      WHERE b.resource_key=?`, [revision,refKey(ref)]);
    return rows[0]?.fingerprint ?? null;
  }
  async reconcile(ref: Ref, revision: number): Promise<void> {
    const key = refKey(ref);
    if (!await assetCollectionEnabled(this.pool, ref)) { this.reconciled.delete(key); return; }
    const fingerprint = await this.fingerprint(this.pool, ref, revision);
    if (!fingerprint || this.reconciled.get(key) === fingerprint) return;
    const c = await this.pool.getConnection(), held: string[] = [];
    let transaction = false, reusable = true;
    try {
      const [initial] = await c.execute<RowDataPacket[]>('SELECT series_hash FROM metric_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash', [ref.type,String(ref.id)]);
      for (const row of initial) {
        const name = rolloutAlertLockName(row.series_hash);
        const [lock] = await c.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [name]);
        rule(Number(lock[0]?.acquired) === 1, 'SOURCE_FENCE_UNAVAILABLE', 503); held.push(name);
      }
      await c.beginTransaction(); transaction = true;
      const [lock] = await c.execute<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
      rule(lock.length === 1, 'SOURCE_POLICY_LOCK_UNAVAILABLE', 503);
      if (!await assetCollectionEnabled(c, ref, true)) { await c.commit(); transaction = false; return; }
      // Re-read under the policy lock: collection/configuration may have changed
      // while waiting for fences, or another local caller may have reconciled it.
      const current = await this.fingerprint(c, ref, revision);
      let acceptance: Acceptance = 'skipped';
      if (current && this.reconciled.get(key) !== current) acceptance = await this.accept(c, ref, revision, initial.map(r=>String(r.series_hash)));
      // A template row must not be cached as a successfully reconciled package
      // row; it is simply not this path's evidence.
      const completed = acceptance === 'template' ? null : await this.fingerprint(c, ref, revision);
      await c.commit(); transaction = false;
      if (acceptance === 'template') this.reconciled.delete(key);
      if (completed) {
        // Keep at most one digest per resource and bound inactive/deleted entries.
        this.reconciled.delete(key);
        if (this.reconciled.size >= 10000) this.reconciled.delete(this.reconciled.keys().next().value!);
        this.reconciled.set(key, completed);
      }
    } catch(e) { if (transaction) await c.rollback(); throw e; }
    finally {
      for (const name of held.reverse()) {
        try { const [rows] = await c.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released',[name]); if (Number(rows[0]?.released) !== 1) reusable = false; }
        catch { reusable = false; }
      }
      if (reusable) c.release(); else c.destroy();
    }
  }
  /**
   * Formalize one template revision. The samples must come from the plan's own
   * releases (package id/version on each observation), each mapped to that exact
   * release's catalog and its rollout pin. No legacy comparison applies: the
   * direct measurement is the evidence, and the rollout rows carry the release
   * that produced each series.
   */
  private async acceptTemplate(c: PoolConnection, ref: Ref, revision: number,
    decoded: DecodedTemplateBindingPayload, fenced: string[]): Promise<Acceptance> {
    const plan = decoded.pending.plan;
    if (decoded.binding.revision !== revision || !plan.executable || !plan.settings.enabled) return 'skipped';
    const [existing] = await c.execute<RowDataPacket[]>('SELECT * FROM metric_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE', [ref.type, String(ref.id)]);
    rule(stable(existing.map(r => String(r.series_hash))) === stable(fenced), 'SOURCE_SET_CHANGED');
    const [phase] = await c.execute<RowDataPacket[]>('SELECT phase,revision,generation FROM metric_rollout_resources WHERE resource_key = ? FOR UPDATE', [refKey(ref)]);
    const controlled = phase[0] && phase[0].phase !== 'semantic';
    const [accepted] = await c.execute<RowDataPacket[]>('SELECT revision FROM metric_source_acceptance WHERE resource_key = ? AND revision = ?', [refKey(ref), revision]);
    const releases = new Map<string, { pin: PackagePin; catalog: ReturnType<PackageRegistry['catalog']> }>();
    for (const release of plan.releases) {
      const pin = { ...release.release };
      releases.set(`${pin.id}@${pin.version}`, { pin, catalog: this.registry.catalog(pin) });
    }
    const [captures] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_source_checks WHERE resource_key=? AND revision=?', [refKey(ref), revision]);
    if (!captures[0]) return 'skipped';
    const snapshot = decode<{ sample_ids: string[] }>(captures[0].payload);
    if (!Array.isArray(snapshot.sample_ids) || !snapshot.sample_ids.length) return 'skipped';
    rule(snapshot.sample_ids.length <= 10000 && snapshot.sample_ids.every(id => typeof id === 'string'), 'SOURCE_SERIES_LIMIT');
    const [rows] = await c.execute<RowDataPacket[]>(`SELECT payload FROM metric_observations WHERE stage = 'normalized' AND payload IS NOT NULL
      AND id IN (${snapshot.sample_ids.map(() => '?').join(',')})
      AND observed_at >= ? ORDER BY observed_at DESC, id DESC`,
    [...snapshot.sample_ids, new Date(this.clock().getTime() - plan.settings.stale_after_ms)]);
    if (!rows.length) return 'skipped';
    rule(rows.length <= 10000, 'SOURCE_SERIES_LIMIT');
    const samples = new Map<string, NormalizedObservation>();
    const sampleRelease = new Map<string, PackagePin>();
    for (const row of rows) {
      const o = decode<NormalizedObservation>(row.payload), hash = seriesHash(o);
      if (!snapshot.sample_ids.includes(o.id)) continue;
      if (samples.has(hash)) continue;
      const release = releases.get(`${o.versions.package_id}@${o.versions.package_version}`);
      rule(release, 'SOURCE_UNKNOWN_METRIC');
      const definition = release!.catalog.find(d => d.id === o.metric.id && d.semantic_version === o.metric.semantic_version);
      rule(definition, 'SOURCE_UNKNOWN_METRIC');
      validateObservation(o, definition!);
      rule(o.resource_type === ref.type && o.resource_id === String(ref.id)
        && o.versions.config_revision === revision, 'SOURCE_IDENTITY');
      if (o.production === 'measured') {
        const rawIds = o.lineage.filter(i => i.stage === 'raw').map(i => i.id);
        rule(rawIds.length > 0, 'SOURCE_RAW_REQUIRED');
        for (const id of rawIds) {
          const [raw] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_observations WHERE id = ? AND stage = \'raw\'', [id]);
          rule(raw[0]?.payload, 'SOURCE_RAW_REQUIRED');
          validateObservation(decode<RawObservation>(raw[0].payload), definition!);
        }
        const [attempts] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_attempts WHERE id = ?', [o.source.attempt_id]);
        const attempt = attempts[0] ? decode<{ status: string; config_revision: number; observation_ids: string[] }>(attempts[0].payload) : null;
        rule(attempt && attempt.config_revision === revision && ['succeeded', 'partial'].includes(attempt.status)
          && attempt.observation_ids.includes(o.id), 'SOURCE_ATTEMPT_REQUIRED');
      } else {
        rule(false, 'SOURCE_LINEAGE');
      }
      samples.set(hash, o);
      sampleRelease.set(hash, release!.pin);
    }
    if (!samples.size) return 'skipped';
    if (![...samples.values()].some(o => o.production === 'measured' && o.value !== null && o.quality.status === 'good')) return 'skipped';
    if (controlled) return 'skipped';
    const generation = accepted.length ? Math.max(1, ...existing.map(r => Number(r.generation)))
      : Math.max(0, ...existing.map(r => Number(r.generation))) + 1;
    if (!accepted.length) {
      await c.execute(`UPDATE metric_rollout SET source = 'retired', read_mode = 'pending', generation = ?, applied_revision = NULL
        WHERE resource_type = ? AND resource_id = ?`, [generation, ref.type, String(ref.id)]);
    }
    for (const [hash] of samples) {
      const old = existing.find(r => r.series_hash === hash);
      if (accepted.length && old?.published_revision === revision) continue;
      const pin = sampleRelease.get(hash)!;
      await c.execute(`INSERT INTO metric_rollout (series_hash,source,generation,read_mode,package_pin,published_revision,applied_revision,resource_type,resource_id)
        VALUES (?, 'semantic', ?, 'semantic', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE source = 'semantic', generation = VALUES(generation),
        read_mode = 'semantic', package_pin = VALUES(package_pin), published_revision = VALUES(published_revision), applied_revision = VALUES(applied_revision), latest_payload = NULL`,
      [hash, generation, JSON.stringify(pin), revision, revision, ref.type, String(ref.id)]);
    }
    if (!accepted.length) {
      const evidence = {
        validation: 'direct_measurement', template_binding: true,
        template_pins: decoded.binding.template_pins,
        resolution_identity: decoded.pending.resolution_identity,
        plan_identity: plan.identity,
        packages: [...releases.values()].map(entry => entry.pin),
        sample_ids: [...samples.values()].map(o => o.id),
        checks: ['immutable_template_version', 'resource_identity', 'semantic_validation', 'raw_lineage',
          'asset_enabled', 'policy_revision', 'publication_fence'],
      };
      await c.execute('INSERT INTO metric_source_acceptance (resource_key,revision,generation,evidence) VALUES (?,?,?,?)',
        [refKey(ref), revision, generation, JSON.stringify(evidence)]);
      await c.execute(`INSERT INTO metric_rollout_resources (resource_key,resource_type,resource_id,phase,revision,generation,gate_json,actor_id,request_id)
        VALUES (?,?,?,'semantic',?,?,NULL,0,?) ON DUPLICATE KEY UPDATE phase = 'semantic', revision = VALUES(revision), generation = VALUES(generation), gate_json = NULL, actor_id = 0, request_id = VALUES(request_id)`,
      [refKey(ref), ref.type, String(ref.id), revision, generation, `measurement:${refKey(ref)}:${revision}`]);
    }
    return 'formalized';
  }

  private async accept(c: PoolConnection, ref: Ref, revision: number, fenced: string[]): Promise<Acceptance> {
    const [bindings] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    if (!bindings[0]) return 'skipped';
    // Only a legacy single-package row can be formalized here; a template row is
    // reported, never decoded as `Published` nor recorded as reconciled.
    const stored = readStoredBinding(decode(bindings[0].payload));
    // A template row is formalized from its own pending plan and exact releases;
    // the legacy single-package branch never sees it.
    if (stored.source === 'template') return this.acceptTemplate(c, ref, revision, stored.template, fenced);
    const policy = stored.published;
    if (policy.binding.revision !== revision || !policy.resolved.settings.enabled || policy.application.applied_revision !== revision) return 'skipped';
    const [existing] = await c.execute<RowDataPacket[]>('SELECT * FROM metric_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE',[ref.type,String(ref.id)]);
    rule(stable(existing.map(r=>String(r.series_hash))) === stable(fenced), 'SOURCE_SET_CHANGED');
    const [phase] = await c.execute<RowDataPacket[]>('SELECT phase,revision,generation FROM metric_rollout_resources WHERE resource_key = ? FOR UPDATE',[refKey(ref)]);
    // Existing explicitly controlled migrations retain their real shadow/cutover requirements.
    const controlled = phase[0] && phase[0].phase !== 'semantic';
    const [accepted] = await c.execute<RowDataPacket[]>('SELECT revision FROM metric_source_acceptance WHERE resource_key = ? AND revision = ?', [refKey(ref),revision]);
    const catalog = this.registry.catalog(policy.binding.package);
    const [captures] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_source_checks WHERE resource_key=? AND revision=?',[refKey(ref),revision]);
    if (!captures[0]) return 'skipped';
    const snapshot = decode<{sample_ids:string[]}>(captures[0].payload);
    if (!Array.isArray(snapshot.sample_ids) || !snapshot.sample_ids.length) return 'skipped';
    rule(snapshot.sample_ids.length <= 10000 && snapshot.sample_ids.every(id=>typeof id==='string'), 'SOURCE_SERIES_LIMIT');
    // The committed capture already identifies the batch. PRIMARY lookups keep
    // work proportional to that batch rather than all retained normalized rows.
    const [rows] = await c.execute<RowDataPacket[]>(`SELECT payload FROM metric_observations WHERE stage = 'normalized' AND payload IS NOT NULL
      AND id IN (${snapshot.sample_ids.map(()=>'?').join(',')})
      AND observed_at >= ? ORDER BY observed_at DESC, id DESC`,
    [...snapshot.sample_ids,new Date(this.clock().getTime() - policy.resolved.settings.stale_after_ms)]);
    if (!rows.length) return 'skipped';
    rule(rows.length <= 10000, 'SOURCE_SERIES_LIMIT');
    const samples = new Map<string, NormalizedObservation>();
    for (const row of rows) {
      const o = decode<NormalizedObservation>(row.payload), hash = seriesHash(o);
      if (!snapshot.sample_ids.includes(o.id)) continue;
      if (samples.has(hash)) continue;
      const definition = catalog.find(d => d.id === o.metric.id && d.semantic_version === o.metric.semantic_version);
      rule(definition, 'SOURCE_UNKNOWN_METRIC'); validateObservation(o, definition);
      rule(o.resource_type === ref.type && o.resource_id === String(ref.id) && o.versions.config_revision === revision
        && o.versions.package_id === policy.binding.package.id && o.versions.package_version === policy.binding.package.version, 'SOURCE_IDENTITY');
      // Derived output must retain actual normalized inputs. Measured output must retain its raw evidence.
      if (o.production === 'measured') {
        const rawIds = o.lineage.filter(i => i.stage === 'raw').map(i => i.id);
        rule(rawIds.length > 0, 'SOURCE_RAW_REQUIRED');
        for (const id of rawIds) {
          const [raw] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_observations WHERE id = ? AND stage = \'raw\'', [id]);
          rule(raw[0]?.payload, 'SOURCE_RAW_REQUIRED');
          const input = decode<RawObservation>(raw[0].payload);
          validateObservation(input, definition);
          rule(input.resource_id === o.resource_id && input.resource_type === o.resource_type && stable(input.metric) === stable(o.metric)
            && stable(input.dimensions) === stable(o.dimensions) && input.versions.config_revision === revision, 'SOURCE_LINEAGE');
        }
        const [attempts] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_attempts WHERE id = ?', [o.source.attempt_id]);
        const attempt = attempts[0] ? decode<{status:string; config_revision:number; observation_ids:string[]}>(attempts[0].payload) : null;
        rule(attempt && attempt.config_revision === revision && ['succeeded','partial'].includes(attempt.status)
          && attempt.observation_ids.includes(o.id), 'SOURCE_ATTEMPT_REQUIRED');
      } else {
        const formula=this.registry.get(policy.binding.package).derived.find(d=>stable(d.output)===stable(o.metric));
        rule(formula && o.source.collector_id===`derived:${formula.id}` && o.lineage.length>0,'SOURCE_LINEAGE');
        const foundInputs = new Set<string>();
        for (const item of o.lineage) {
          const [inputs] = await c.execute<RowDataPacket[]>('SELECT payload FROM metric_observations WHERE id = ? AND payload IS NOT NULL', [item.id]);
          rule(inputs[0], 'SOURCE_LINEAGE');
          const input = decode<NormalizedObservation>(inputs[0].payload);
          rule(item.stage==='normalized' && input.stage==='normalized' && input.resource_type === o.resource_type && input.resource_id === o.resource_id
            && input.versions.config_revision === revision && input.versions.package_id===o.versions.package_id && input.versions.package_version===o.versions.package_version
            && stable(input.dimensions)===stable(o.dimensions), 'SOURCE_LINEAGE');
          const dependency = formula.inputs.some(i=>stable(i)===stable(input.metric));
          rule(dependency || o.value===null && o.quality.status==='unknown' && o.quality.reason==='missing_input', 'SOURCE_LINEAGE');
          if (dependency) foundInputs.add(stable(input.metric));
        }
        rule(o.value===null || formula.inputs.every(i=>foundInputs.has(stable(i))), 'SOURCE_LINEAGE');
      }
      samples.set(hash,o);
    }
    if (!samples.size) return 'skipped';
    if (![...samples.values()].some(o=>o.production==='measured'&&o.value!==null&&o.quality.status==='good')) return 'skipped';
    const history=await sourceHistory(c,ref,policy.binding.package.id.split('-')[0],[...samples.values()],catalog);
    if (history.legacy_comparison.state === 'failed') return 'skipped';
    // An explicitly controlled historical migration needs an actual comparison before resuming.
    // A rolled-back revision is not re-enabled by a background scan.
    if (controlled && (history.legacy_comparison.state !== 'passed'
      || phase[0].phase === 'legacy' && Number(phase[0].revision) >= revision)) return 'skipped';
    // A newer configuration invalidates every old write ticket, even for unchanged dimensions.
    const generation = accepted.length ? Math.max(1,...existing.map(r => Number(r.generation))) : Math.max(0,...existing.map(r => Number(r.generation))) + 1;
    if (!accepted.length) {
      await c.execute(`UPDATE metric_rollout SET source = 'retired', read_mode = 'pending', generation = ?, applied_revision = NULL
        WHERE resource_type = ? AND resource_id = ?`,[generation,ref.type,String(ref.id)]);
    }
    for (const [hash] of samples) {
      const old = existing.find(r => r.series_hash === hash);
      if (accepted.length && old?.published_revision === revision) continue;
      await c.execute(`INSERT INTO metric_rollout (series_hash,source,generation,read_mode,package_pin,published_revision,applied_revision,resource_type,resource_id)
        VALUES (?, 'semantic', ?, 'semantic', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE source = 'semantic', generation = VALUES(generation),
        read_mode = 'semantic', package_pin = VALUES(package_pin), published_revision = VALUES(published_revision), applied_revision = VALUES(applied_revision), latest_payload = NULL`,
      [hash,generation,JSON.stringify(policy.binding.package),revision,revision,ref.type,String(ref.id)]);
    }
    if (!accepted.length) {
      const evidence = { ...history, validation:'direct_measurement', package:policy.binding.package, sample_ids:[...samples.values()].map(o=>o.id),
        checks:['immutable_package','resource_identity','semantic_validation','raw_lineage','asset_enabled','policy_revision','publication_fence'],
        };
      await c.execute('INSERT INTO metric_source_acceptance (resource_key,revision,generation,evidence) VALUES (?,?,?,?)', [refKey(ref),revision,generation,JSON.stringify(evidence)]);
      await c.execute(`INSERT INTO metric_rollout_resources (resource_key,resource_type,resource_id,phase,revision,generation,gate_json,actor_id,request_id)
        VALUES (?,?,?,'semantic',?,?,NULL,0,?) ON DUPLICATE KEY UPDATE phase = 'semantic', revision = VALUES(revision), generation = VALUES(generation), gate_json = NULL, actor_id = 0, request_id = VALUES(request_id)`,
      [refKey(ref),ref.type,String(ref.id),revision,generation,`measurement:${refKey(ref)}:${revision}`]);
    }
    return 'formalized';
  }
}
