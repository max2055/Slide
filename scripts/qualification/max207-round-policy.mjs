import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mysqlUtcMilliseconds } from './mysql-utc-time.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = value => {
  assert((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), 'ROUND_INTEGER');
  const n = Number(value);
  assert(Number.isSafeInteger(n), 'ROUND_INTEGER');
  return n;
};
const sameExcept = (before, after, columns) => {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'ROUND_ROW_COLUMNS');
  assert.deepEqual(Object.fromEntries(Object.entries(after).map(([k,v]) => [k, columns.includes(k) ? before[k] : v])), before, 'ROUND_UNEXPECTED_COLUMN');
};
const key = (capture, table, row) => JSON.stringify(capture.keys[table].map(k => row[k]));
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

/** Only the current continuation and the two explicitly collected resources may
 * change old operational state. Each exception is checked against new durable
 * messages/events/attempts/observations; no table-wide exemption or DB writes. */
export function reviewRoundMutations(base, current, business, resourceKeys, issuedAt) {
  assert.equal(business.phases.length, 4, 'ROUND_PHASES');
  assert.deepEqual(business.phases.map(p => p.phase), ['continue','collect','investigate','plan'], 'ROUND_PHASES');
  const successor = business.phases[0].result;
  const id = successor.investigationId, requestId = successor.requestId;
  assert.equal(id, business.source.investigationId, 'ROUND_INVESTIGATION');
  assert.equal(requestId, business.source.requestId, 'ROUND_REQUEST');
  assert.equal(business.plan.content.investigationId, id, 'ROUND_PLAN_INVESTIGATION');
  assert.equal(business.phases[2].result.requestId,requestId,'ROUND_RESULT_REQUEST');
  assert.equal(business.phases[1].result.executed,12,'ROUND_COLLECTIONS');
  const investigation = current.rows.investigations.find(r => r.id === id);
  assert(investigation, 'ROUND_INVESTIGATION');
  const scope = new Set(resourceKeys);
  assert.equal(scope.size, 2, 'ROUND_RESOURCE_SCOPE');
  const start = Date.parse(issuedAt), end = Date.parse(current.at);
  assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'ROUND_TIME');
  const window = time => { assert(Number.isFinite(time) && time >= start - 1000 && time <= end + 1000, 'ROUND_TIME'); return time; };
  const sqlTime = value => window(mysqlUtcMilliseconds(value));
  const isoTime = value => { assert(typeof value === 'string' && value.endsWith('Z'), 'ROUND_TIME'); return window(Date.parse(value)); };
  const added = table => {
    const old = new Set(base.rows[table].map(r => key(base,table,r)));
    return current.rows[table].filter(r => !old.has(key(current,table,r)));
  };
  const attempts = new Map(added('metric_attempts').map(r => [r.id, json(r.payload)]));
  const observations = new Map(added('metric_observations').map(r => [r.id, r]));
  const scheduleEvents = added('metric_schedule_events');
  const jobs = new Map(added('workflow_jobs').map(r => [r.id, r]));
  const sample = (sampleId, resourceKey, visiting = new Set()) => {
    assert(!visiting.has(sampleId),'ROUND_LINEAGE_CYCLE');
    visiting = new Set([...visiting,sampleId]);
    const row = observations.get(sampleId), o = row && json(row.payload);
    assert(o && o.id === sampleId && `${o.resource_type}:${o.resource_id}` === resourceKey, 'ROUND_SAMPLE_SCOPE');
    const attempt = attempts.get(o.source.attempt_id);
    assert(attempt && attempt.id === o.source.attempt_id && attempt.binding_id === resourceKey
      && attempt.status === 'succeeded', 'ROUND_SAMPLE_ATTEMPT');
    if (o.source.collector_id.startsWith('derived:')) {
      assert(o.stage === 'normalized' && o.lineage?.length > 0,'ROUND_DERIVED_LINEAGE');
      for (const input of o.lineage) {
        const {o:dependency} = sample(input.id,resourceKey,visiting);
        assert(input.stage === 'normalized' && dependency.stage === 'normalized'
          && dependency.source.attempt_id === o.source.attempt_id,'ROUND_DERIVED_LINEAGE');
      }
    } else {
      assert.equal(o.source.collector_id,attempt.collector_id,'ROUND_SAMPLE_COLLECTOR');
      if (o.stage !== 'raw') {
        assert(attempt.observation_ids.includes(sampleId),'ROUND_SAMPLE_ATTEMPT');
        assert(o.lineage?.length > 0,'ROUND_RAW_LINEAGE');
        for (const input of o.lineage) {
          const {o:raw} = sample(input.id,resourceKey,visiting);
          assert(input.stage === 'raw' && raw.stage === 'raw'
            && raw.source.attempt_id === o.source.attempt_id,'ROUND_RAW_LINEAGE');
        }
      }
    }
    assert(scheduleEvents.some(e => e.resource_key === resourceKey && attempt.id.startsWith(e.job_id + ':')
      && jobs.get(e.job_id)?.job_type === 'metrics.collect' && jobs.get(e.job_id)?.state === 'completed'), 'ROUND_SAMPLE_JOB');
    isoTime(attempt.started_at); isoTime(attempt.ended_at); isoTime(o.collected_at); isoTime(o.observed_at);
    return {row,o};
  };
  const reviewedRows = [], allowedCells = new Set();
  for (const table of Object.keys(base.rows)) {
    const byKey = new Map(current.rows[table].map(r => [key(current,table,r),r]));
    for (const before of base.rows[table]) {
      const rowKey = key(base,table,before), after = byKey.get(rowKey);
      assert(after, 'ROUND_OLD_ROW_REMOVED');
      if (isDeepStrictEqual(before,after)) continue;
      let columns;
      if (table === 'servers' && integer(before.id) === 3 || table === 'alert_rules' && integer(before.id) === 7) {
        columns = ['updated_at']; sameExcept(before,after,columns); sqlTime(after.updated_at);
      } else if (table === 'chat_sessions' && before.session_id === investigation.session_id) {
        columns = ['message_count','last_message_at','updated_at']; sameExcept(before,after,columns);
        const messages = current.rows.chat_messages.filter(r => r.session_id === before.session_id);
        const newMessages = added('chat_messages').filter(r => r.session_id === before.session_id);
        assert.equal(newMessages.length,2,'ROUND_NEW_MESSAGES');
        assert(newMessages.some(r => r.role === 'user' && json(r.metadata).requestId === requestId), 'ROUND_MESSAGE_REQUEST');
        const run = current.rows.agent_runs.find(r => r.idempotency_key === `investigation:${requestId}`);
        assert(run && newMessages.some(r => r.role === 'assistant' && json(r.metadata).canonicalRunId === run.id), 'ROUND_MESSAGE_RUN');
        assert.equal(integer(after.message_count),messages.length,'ROUND_MESSAGE_COUNT');
        const latest = Math.max(...messages.map(r => mysqlUtcMilliseconds(r.created_at)));
        assert.equal(sqlTime(after.last_message_at),latest,'ROUND_LAST_MESSAGE'); sqlTime(after.updated_at);
      } else if (table === 'investigations' && before.id === id) {
        columns = ['version','updated_at']; sameExcept(before,after,columns);
        assert.equal(integer(successor.version),integer(before.version)+1,'ROUND_CONTINUATION_VERSION');
        assert.equal(integer(after.version),integer(successor.version)+1,'ROUND_TERMINAL_VERSION'); sqlTime(after.updated_at);
      } else if (table === 'investigation_stream_heads' && before.investigation_id === id) {
        columns = ['sequence']; sameExcept(before,after,columns);
        const events = added('investigation_stream_events').filter(r => r.investigation_id === id)
          .map(r => integer(r.sequence)).sort((a,b) => a-b);
        assert.deepEqual(events,Array.from({length:events.length},(_,i) => integer(before.sequence)+i+1),'ROUND_STREAM_CONTIGUOUS');
        assert.equal(integer(after.sequence),integer(before.sequence)+events.length,'ROUND_STREAM_HEAD');
      } else if (table === 'metric_policy_bindings' && scope.has(before.resource_key)) {
        columns = ['payload','capabilities']; sameExcept(before,after,columns);
        const oldPayload = json(before.payload), payload = json(after.payload);
        isoTime(payload.application.reported_at);
        assert.deepEqual({...payload,application:{...payload.application,reported_at:oldPayload.application.reported_at}},oldPayload,'ROUND_BINDING_CONFIG');
        const oldCaps = json(before.capabilities), caps = json(after.capabilities);
        assert.equal(caps.length,oldCaps.length,'ROUND_CAPABILITIES');
        caps.forEach((c,i) => {
          const evaluated = isoTime(c.evaluated_at), valid = Date.parse(c.valid_until);
          assert.equal(valid-evaluated,120000,'ROUND_CAPABILITY_TTL');
          assert.deepEqual({...c,evaluated_at:oldCaps[i].evaluated_at,valid_until:oldCaps[i].valid_until},oldCaps[i],'ROUND_CAPABILITY_IDENTITY');
        });
      } else if (table === 'metric_rollout' && scope.has(`${before.resource_type}:${before.resource_id}`)) {
        columns = ['latest_payload','updated_at']; sameExcept(before,after,columns); sqlTime(after.updated_at);
        const payload = json(after.latest_payload), resourceKey = `${before.resource_type}:${before.resource_id}`;
        const {row,o} = sample(payload.id,resourceKey); assert.deepEqual(payload,{...o,stored_at:null},'ROUND_ROLLOUT_OBSERVATION');
        assert(current.rows.metric_publications.some(p => p.observation_id === row.id && p.series_hash === after.series_hash
          && integer(p.generation) === integer(after.generation)), 'ROUND_ROLLOUT_PUBLICATION');
        assert.equal(row.series_hash,after.series_hash,'ROUND_ROLLOUT_SERIES');

      } else if (table === 'metric_schedule' && scope.has(before.resource_key)) {
        columns = ['next_due_ms','last_end_ms','updated_at']; sameExcept(before,after,columns);
        const last = window(integer(after.last_end_ms)); sqlTime(after.updated_at);
        assert.equal(integer(after.next_due_ms)-last,integer(before.next_due_ms)-integer(before.last_end_ms),'ROUND_SCHEDULE_INTERVAL');
        assert(integer(after.next_due_ms)>last,'ROUND_SCHEDULE_INTERVAL');
        assert(scheduleEvents.some(e => e.resource_key === before.resource_key && jobs.get(e.job_id)?.state === 'completed'), 'ROUND_SCHEDULE_EVENT');
      } else if (table === 'metric_source_checks' && scope.has(before.resource_key)) {
        columns = ['payload','checked_at']; sameExcept(before,after,columns); sqlTime(after.checked_at);
        const payload = json(after.payload), old = json(before.payload);
        assert.equal(payload.mode,'same_actual_source_snapshot','ROUND_SOURCE_MODE');
        assert.equal(payload.remote_requests_added,0,'ROUND_SOURCE_REMOTE');
        assert.equal(`${payload.resource.type}:${payload.resource.id}`,before.resource_key,'ROUND_SOURCE_SCOPE');
        assert.equal(integer(payload.revision),integer(before.revision),'ROUND_SOURCE_REVISION'); isoTime(payload.measured_at);
        assert(payload.sample_ids.length>0 && new Set(payload.sample_ids).size === payload.sample_ids.length,'ROUND_SOURCE_SAMPLES');
        payload.sample_ids.forEach(s => sample(s,before.resource_key));
        for (const check of payload.checks) {
          assert(payload.sample_ids.includes(check.sample_id),'ROUND_CHECK_SAMPLE');
          const {o} = sample(check.sample_id,before.resource_key);
          assert.equal(check.state,'passed','ROUND_CHECK_STATE'); assert.equal(check.metric_id,o.metric.id,'ROUND_CHECK_METRIC');
          assert.equal(check.unit,o.unit,'ROUND_CHECK_UNIT'); assert.deepEqual(check.dimensions,o.dimensions,'ROUND_CHECK_DIMENSIONS');
          const value = o.value?.encoding === 'uint64' ? integer(o.value.value) : o.value?.value;
          assert(typeof value === 'number' && Number.isFinite(value),'ROUND_CHECK_VALUE');
          assert.deepEqual(check.value,value,'ROUND_CHECK_VALUE'); assert.deepEqual(check.legacy_value,check.value,'ROUND_CHECK_EQUIVALENCE');
          assert(old.checks.some(c => isDeepStrictEqual({...check,sample_id:c.sample_id,value:c.value,legacy_value:c.legacy_value},c)),'ROUND_CHECK_DEFINITION');
        }
        for (const difference of payload.semantic_differences) {
          assert(payload.sample_ids.includes(difference.sample_id),'ROUND_DIFFERENCE_SAMPLE');
          const {o} = sample(difference.sample_id,before.resource_key); assert.equal(difference.metric_id,o.metric.id,'ROUND_DIFFERENCE_METRIC');
          assert(old.semantic_differences.some(d => isDeepStrictEqual({...difference,sample_id:d.sample_id},d)),'ROUND_DIFFERENCE_DEFINITION');
        }
        assert(payload.sample_ids.every(s => payload.checks.some(c => c.sample_id === s) || payload.semantic_differences.some(d => d.sample_id === s)), 'ROUND_SOURCE_COVERAGE');
        assert.equal(payload.checks.length,old.checks.length,'ROUND_CHECK_DEFINITIONS');
        assert.equal(payload.semantic_differences.length,old.semantic_differences.length,'ROUND_DIFFERENCE_DEFINITIONS');
        assert.deepEqual({...payload,checks:old.checks,semantic_differences:old.semantic_differences,sample_ids:old.sample_ids,measured_at:old.measured_at},old,'ROUND_SOURCE_CONFIG');
      } else assert.fail('ROUND_UNREVIEWED_OLD_ROW:'+table);
      reviewedRows.push({table,before:hash(before),after:hash(after)});
      for (const column of columns) allowedCells.add(`${table}:${rowKey}:${column}`);
    }
  }
  return {reviewedRows,allowedCells};
}

/** Native SQL integer representation is validated only for named control fields;
 * hashes and all raw rows/cells retain their original string/number values. */
export function assertNativePendingPlan(rows, expected) {
  const head = rows.action_plans.find(r => r.id === expected.id);
  const version = rows.action_plan_versions.find(r => r.plan_id === expected.id && integer(r.version) === expected.version);
  assert(head && version,'IMMUTABLE_PLAN_MISSING');
  assert.equal(integer(head.current_version),expected.version,'IMMUTABLE_PLAN_VERSION');
  assert.equal(version.content_hash,expected.contentHash,'IMMUTABLE_PLAN_HASH');
  assert.equal(version.state,'pending_approval','PLAN_MUST_REMAIN_PENDING');
  assert.deepEqual(json(version.content),expected.content,'IMMUTABLE_PLAN_CONTENT');
  assert.equal(head.investigation_id,expected.content.investigationId,'IMMUTABLE_PLAN_INVESTIGATION');
  const approvals = rows.agent_tool_approvals.filter(r => json(r.args_redacted)?.planId === expected.id);
  assert(approvals.length>0 && approvals.every(r => r.status === 'pending' && integer(r.used_count) === 0
    && r.scope === 'once' && r.consumed_at === null),'APPROVAL_CONSUMED');
  return {headHash:hash(head),versionHash:hash(version)};
}

export function compareRoundRows(base,current,reviewedRows) {
  assert.equal(Object.keys(current.rows).length,166,'ALL166_REQUIRED');
  assert.deepEqual(Object.keys(current.rows).sort(),Object.keys(base.rows).sort(),'ROUND_TABLES');
  assert.deepEqual(current.keys,base.keys,'ROUND_PRIMARY_KEYS'); assert.deepEqual(current.columns,base.columns,'ROUND_COLUMN_TYPES');
  const used = new Set(); let added = 0;
  for (const table of Object.keys(base.rows)) {
    const byKey = new Map(current.rows[table].map(r => [key(current,table,r),r]));
    for (const old of base.rows[table]) {
      const after = byKey.get(key(base,table,old)); assert(after,'ROUND_OLD_ROW_REMOVED');
      if (!isDeepStrictEqual(old,after)) {
        const index = reviewedRows.findIndex(r => r.table === table && r.before === hash(old) && r.after === hash(after));
        assert(index>=0 && !used.has(index),'ROUND_UNREVIEWED_ROW_DIGEST'); used.add(index);
      }
      byKey.delete(key(base,table,old));
    }
    added += byKey.size;
    if (table === 'workflow_jobs') for (const row of byKey.values()) assert(['qualification.source','qualification.source.audit','metrics.collect','investigation.execute'].includes(row.job_type),'PRODUCT_ACTION_JOB_FORBIDDEN');
  }
  assert.equal(used.size,reviewedRows.length,'UNUSED_REVIEWED_CHANGE');
  for (const table of ['action_jobs','action_executions','action_dispatch_locks','action_approval_bindings']) assert.deepEqual(current.rows[table],base.rows[table],'PRODUCT_ACTION_FORBIDDEN');
  assert(current.rows.agent_tool_approvals.every(r => integer(r.used_count) === 0),'APPROVAL_CONSUMED');
  assert(current.rows.workflow_jobs.every(r => ['completed','cancelled','dead_letter','failed'].includes(r.state)),'NONTERMINAL_JOB');
  assert(current.rows.agent_runs.every(r => !['running','queued','pending','unknown'].includes(r.state)),'NONTERMINAL_RUN');
  return {all166:true,oldRowsProtected:true,reviewedChanges:reviewedRows,added};
}

const paths = (value,path='$') => [[path,value],...(Array.isArray(value)
  ? value.flatMap((v,i) => paths(v,`${path}[${i}]`))
  : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([k,v]) => paths(v,`${path}.${JSON.stringify(k)}`)) : [])];

/** Every exception remains bound to the native SQL value and its typed JSON
 * leaves. Unchanged leaves retain their exact representation, including numbers
 * that JavaScript would otherwise round. No capture or hash is rewritten. */
export function compareRoundNative(base,current,allowedCells) {
  let checked = 0, reviewed = 0;
  for (const [table,rows] of Object.entries(base.native)) for (const [rowKey,cells] of Object.entries(rows)) {
    const after = current.native[table]?.[rowKey]; assert(after,'OLD_NATIVE_ROW_REMOVED');
    assert.deepEqual(Object.keys(after),Object.keys(cells),'NATIVE_COLUMNS');
    const row = current.rows[table].find(r => key(current,table,r) === rowKey);
    assert(row,'NATIVE_LOGICAL_ROW');
    for (const [column,beforeCell] of Object.entries(cells)) {
      const cell = after[column]; checked++;
      if (!allowedCells.has(`${table}:${rowKey}:${column}`)) {
        assert.deepEqual(cell,beforeCell,`OLD_NATIVE_CELL_CHANGED:${table}.${column}`); continue;
      }
      reviewed++;
      assert.equal(cell.representation,beforeCell.representation,'NATIVE_REPRESENTATION');
      assert.equal(cell.sqlNull,row[column] === null,'NATIVE_NULL');
      if (cell.paths) {
        const value = json(row[column]), raw = json(cell.value);
        assert.deepEqual(raw,value,'NATIVE_JSON_VALUE');
        const leaves = paths(value), byPath = new Map(cell.paths.map(p => [p.path,p]));
        assert.equal(byPath.size,leaves.length,'NATIVE_JSON_PATHS');
        assert.equal(cell.paths.length,leaves.length,'NATIVE_JSON_PATHS');
        const oldValues = new Map(paths(json(beforeCell.value)));
        const oldPaths = new Map((beforeCell.paths ?? []).map(p => [p.path,p]));
        for (const [path,v] of leaves) {
          const p = byPath.get(path); assert(p && p.present === 1,'NATIVE_JSON_PATH');
          if (v && typeof v === 'object') {
            assert.equal(p.type,Array.isArray(v)?'ARRAY':'OBJECT','NATIVE_JSON_TYPE');
            assert.deepEqual(json(p.value),v,'NATIVE_JSON_SUBTREE');
          } else if (oldValues.has(path) && isDeepStrictEqual(oldValues.get(path),v)) {
            assert.deepEqual(p,oldPaths.get(path),'NATIVE_UNCHANGED_LEAF');
          } else {
            if (typeof v === 'number') assert((Number.isInteger(v)?['INTEGER','UNSIGNED INTEGER','DOUBLE']:['DOUBLE']).includes(p.type),'NATIVE_JSON_TYPE');
            else assert.equal(p.type,v === null?'NULL':typeof v === 'string'?'STRING':'BOOLEAN','NATIVE_JSON_TYPE');
            assert(typeof v !== 'number' || Number.isFinite(v) && (!Number.isInteger(v)||Number.isSafeInteger(v)),'NATIVE_UNSAFE_NUMBER');
            assert.equal(p.value,v === null?'null':String(v),'NATIVE_JSON_LEAF');
          }
        }
      } else assert.equal(cell.value,row[column] === null?null:String(row[column]),'NATIVE_SCALAR_VALUE');
    }
  }
  assert.equal(reviewed,allowedCells.size,'UNUSED_NATIVE_EXCEPTION');
  return {checked,reviewed,allOldNativeProtected:true};
}

export function auditRecoveryRound(base,current,business,{resourceKeys,issuedAt}) {
  const review = reviewRoundMutations(base,current,business,resourceKeys,issuedAt);
  const comparison = compareRoundRows(base,current,review.reviewedRows);
  const native = compareRoundNative(base,current,review.allowedCells);
  const plan = assertNativePendingPlan(current.rows,business.plan);
  return {all166:true,allOldNativeProtected:true,configurationRestored:true,
    membershipRestored:true,immutablePendingPlan:true,comparison,native,plan};
}
