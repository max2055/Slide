#!/usr/bin/env python3
"""Offline MAX-63 inventory/fixture gate; stdlib only, no service credentials."""
import argparse
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASE = ROOT / 'apps/db-ops-api/src'
BASELINE = 'f9c1de747890a10d059765aac32712fa4e270372'


def text(path):
    return path.read_text(encoding='utf-8')


def location(path, content, offset):
    return {'path': str(path.relative_to(ROOT)), 'line': content[:offset].count('\n') + 1}


def snapshot():
    path = BASE / 'metric-registry.ts'
    src = text(path)
    registry = []
    # Bounded to the predefined object syntax, not arbitrary runtime TS evaluation.
    for match in re.finditer(r"\{\s+id: '([^']+)'", src):
        start = match.start()
        end = src.find('\n      },', start)
        block = src[start:end]
        def field(name, default=None):
            found = re.search(rf"\b{name}: '([^']*)'", block)
            return found.group(1) if found else default
        engines = re.search(r'db_types: \[([^]]*)\]', block)
        interval = re.search(r'default_interval: (\d+)', block)
        registry.append({
            'id': match.group(1), 'target_type': field('target_type', 'instance'),
            'unit': field('unit'), 'declared_kind': field('value_type', 'unspecified'),
            'aggregation': field('aggregation'),
            'default_interval_seconds': int(interval.group(1)),
            'default_collected': 'is_collected: true' in block,
            'engines': re.findall(r"'([^']+)'", engines.group(1)),
            **location(path, src, start),
        })
    for match in re.finditer(r"serverMetric\('([^']+)', '[^']*', '[^']*', '([^']+)'([^\n]*)", src):
        kind = re.search(r"value_type: '([^']+)'", match.group(3))
        agg = re.search(r"aggregation: '([^']+)'", match.group(3))
        registry.append({
            'id': match.group(1), 'target_type': 'server', 'unit': match.group(2),
            'declared_kind': kind.group(1) if kind else 'gauge',
            'aggregation': agg.group(1) if agg else 'last',
            'default_interval_seconds': 300, 'default_collected': True, 'engines': [],
            **location(path, src, match.start()),
        })
    providers = []
    for engine in ['mysql', 'postgresql', 'oracle', 'dameng']:
        path = BASE / 'collectors' / f'{engine}.provider.ts'
        src = text(path)
        for match in re.finditer(r"case '([^']+)':", src):
            providers.append({'engine': engine, 'id': match.group(1), **location(path, src, match.start())})
    path = BASE / 'database-service.ts'
    src = text(path)
    start = src.index('export interface RealtimeMetrics')
    end = src.index('\nexport interface SlowQuery', start)
    realtime = [{'id': m.group(1), **location(path, src, start + m.start())}
                for m in re.finditer(r'^  (\w+)\??:', src[start:end], re.M)]
    # Include fields emitted but omitted from the explicit TypeScript interface.
    for field in ['threads_running', 'threads_connected', 'bytes_received', 'bytes_sent']:
        match = re.search(rf'^        {field}:', src, re.M)
        realtime.append({'id': field, **location(path, src, match.start())})
    references = []
    pattern = re.compile(r'metrics_history|server_metrics|network_device_observations|'
                         r'getRealtimeMetrics|getHistoricalMetrics|/metrics(?:/|`|\?)|'
                         r'cpu_usage|health_score|device_reachability|filesystem_used_bytes')
    for base in [BASE, ROOT / 'frontend/src']:
        for path in sorted(base.rglob('*.ts')):
            if path.name.endswith('.test.ts') or '__tests__' in path.parts:
                continue
            src = text(path)
            lines = [i for i, line in enumerate(src.splitlines(), 1) if pattern.search(line)]
            if lines:
                rel = str(path.relative_to(ROOT))
                category = ('frontend' if rel.startswith('frontend/') else
                            'agent' if '/tools/' in rel or '/skills/' in rel or 'diagnostic' in rel else
                            'alert' if 'alert' in rel else
                            'producer' if 'collector' in rel or 'database-service' in rel else
                            'query-contract-score-report')
                references.append({'path': rel, 'category': category, 'lines': lines})
    # The monolithic routes are outside src.
    path = ROOT / 'apps/db-ops-api/server.ts'
    references.append({'path': str(path.relative_to(ROOT)), 'category': 'api',
                       'lines': [i for i, line in enumerate(text(path).splitlines(), 1) if pattern.search(line)]})
    source_paths = {r['path'] for r in references}
    source_paths.update(str(p.relative_to(ROOT)) for p in [
        BASE / 'network-devices/huawei-adapter.ts',
        BASE / 'network-devices/huawei-mib-catalog.ts',
        BASE / 'collectors/dameng-memory.ts', BASE / 'collectors/base-provider.ts',
        BASE / 'collectors/custom-sql.provider.ts', BASE / 'linux-host-evidence-service.ts',
        BASE / 'scoring-service.ts', BASE / 'metric-database-service.ts',
    ])
    fingerprints = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(source_paths)}
    return {'version': '1.0.0-candidate.1', 'source_baseline': BASELINE,
            'source_sha256': fingerprints,
            'registry': sorted(registry, key=lambda r: (r['target_type'], r['id'])),
            'provider_cases': providers, 'realtime_fields': realtime, 'references': references}


def verify(data):
    mapping = text(HERE / 'mapping.md')
    # Only the old-ID column can satisfy coverage, not incidental prose/new IDs.
    old_ids = '\n'.join(line.split('|')[1] for line in mapping.splitlines() if line.startswith('|'))
    ids = {r['id'] for rows in [data['registry'], data['provider_cases'], data['realtime_fields']] for r in rows}
    missing = sorted(i for i in ids if not re.search(rf'(?<![\w]){re.escape(i)}(?![\w])', old_ids))
    if missing:
        raise ValueError(f'unmapped legacy IDs: {missing}')
    sections = {
        'instance': mapping.split('## 数据库：公共')[1].split('## Server')[0],
        'server': mapping.split('## Server')[1].split('## 网络设备')[0],
        'network_device': mapping.split('## 网络设备')[1].split('## 自定义')[0],
    }
    for row in data['registry']:
        old_column = '\n'.join(line.split('|')[1] for line in sections[row['target_type']].splitlines() if line.startswith('|'))
        if not re.search(rf"(?<![\w]){re.escape(row['id'])}(?![\w])", old_column):
            raise ValueError(row)
    keys = [(r['target_type'], r['id']) for r in data['registry']]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate registry identity')
    if {r['target_type'] for r in data['registry']} != {'instance', 'server', 'network_device'}:
        raise ValueError('registry must cover instance, server and network_device')
    for rows in [data['registry'], data['provider_cases'], data['realtime_fields'], data['references']]:
        for row in rows:
            if not (ROOT / row['path']).is_file():
                raise ValueError(row['path'])
    # Check every exact full source path mentioned in the consumer table.
    for path in re.findall(r'`((?:apps/db-ops-api|frontend)/[^`]+\.ts)`', text(HERE / 'consumers.md')):
        if not (ROOT / path).is_file():
            raise ValueError(f'bad consumer path: {path}')
    fixtures = json.loads(text(HERE / 'fixtures.json'))
    if fixtures['synthetic'] is not True:
        raise ValueError('fixtures must be synthetic')
    if {f['resource_type'] for f in fixtures['resources']} != {'instance', 'server', 'network_device'}:
        raise ValueError('fixtures must cover instance, server and network_device')
    for resource in fixtures['resources']:
        if resource['semantic_version'] != data['version']:
            raise ValueError('fixture semantic version mismatch')
        if not (resource['legacy_ids'] and resource['source'] and resource['candidate_ids']):
            raise ValueError('fixture requires legacy IDs, source and candidate IDs')
        for old in resource['legacy_ids']:
            if old not in ids:
                raise ValueError(old)
    db, host, network = fixtures['resources']
    if db['raw']['Uptime'] != db['expected']['db.uptime_seconds']:
        raise ValueError('database uptime mismatch')
    if round(db['raw']['pool_used'] / db['raw']['pool_total'] * 100, 2) != db['expected']['dameng.memory.pool_used_percent']:
        raise ValueError('database pool usage mismatch')
    if host['raw']['filesystem']['used'] != host['expected']['host.filesystem.used_bytes']:
        raise ValueError('filesystem used bytes mismatch')
    if host['raw']['filesystem']['size'] == host['raw']['filesystem']['used'] + host['raw']['filesystem']['available']:
        raise ValueError('filesystem fixture must include reserved space')
    host_net = host['raw']['network']
    if (int(host_net['current']) - int(host_net['previous'])) * 8 / host_net['elapsed_seconds'] != host['expected']['comparable_traffic_bps']:
        raise ValueError('host traffic rate mismatch')
    for case in network['counter_cases']:
        current, previous = int(case['current']), int(case['previous'])
        if case['reason'] == 'valid':
            if current < previous:
                raise ValueError('valid counter must not decrease')
            rate = (current - previous) * 8 / case['elapsed_seconds']
            if rate != case['expected_bps']:
                raise ValueError('network counter rate mismatch')
        else:
            if case['expected_bps'] is not None:
                raise ValueError('invalid counter must have no expected rate')
    if network['counter_cases'][0]['expected_bps'] != network['counter_cases'][1]['expected_bps']:
        raise ValueError('Counter32 and Counter64 rates must match')
    if network['counter_cases'][0]['expected_bps'] != host['expected']['comparable_traffic_bps']:
        raise ValueError('network and host comparable rates must match')
    if not any(int(c['current']) > 2**53 for c in network['counter_cases']):
        raise ValueError('missing precise Counter64 sample')
    for case in network['utilization_cases']:
        if case['speed_bps'] and not case.get('invalid_denominator'):
            if case['expected_percent'] != case['bps'] / case['speed_bps'] * 100:
                raise ValueError('network utilization mismatch')
        else:
            if case['expected_percent'] is not None:
                raise ValueError('invalid denominator must have no expected utilization')
    if network['dimensions']['direction'] != 'in':
        raise ValueError('network fixture direction must be in')
    for case in network['status_cases']:
        if case['expected'] != {1: 1, 2: 0}.get(case['raw']):
            raise ValueError('network status mapping mismatch')
    if network['vendor_extension']['expected_value'] is not None:
        raise ValueError('unknown vendor extension must have no expected value')
    if host['dimensions']['mount'] != '/data':
        raise ValueError('host fixture mount must be /data')
    if len(fixtures['non_mappable']) < 2:
        raise ValueError('at least two non-mappable cases are required')
    for case in fixtures['non_mappable']:
        if not (case['left_semantics'] != case['right_semantics'] and case['mapping_allowed'] is False):
            raise ValueError('non-mappable semantics must differ and mapping must be forbidden')
    serialized = json.dumps(fixtures).lower()
    if re.search(r'password|secret|token|username|community|sql_text|host_address', serialized):
        raise ValueError('sensitive fixture field')
    print(f"PASS: {len(keys)} registry identities; {len(data['provider_cases'])} provider cases; "
          f"{len(data['realtime_fields'])} realtime fields; {len(data['references'])} referenced files; "
          '3 resource fixtures; mapping coverage, source paths, arithmetic and negative cases')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    current = snapshot()
    if not args.refresh and current != json.loads(text(HERE / 'inventory.json')):
        raise ValueError('source snapshot drift: review before --refresh')
    verify(current)
    if args.refresh:
        (HERE / 'inventory.json').write_text(json.dumps(current, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
