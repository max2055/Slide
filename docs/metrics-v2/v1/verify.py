#!/usr/bin/env python3
"""Offline MAX-63 inventory/fixture gate; stdlib only, no service credentials."""
import argparse
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
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
    assert not missing, f'unmapped legacy IDs: {missing}'
    sections = {
        'instance': mapping.split('## 数据库：公共')[1].split('## Server')[0],
        'server': mapping.split('## Server')[1].split('## 网络设备')[0],
        'network_device': mapping.split('## 网络设备')[1].split('## 自定义')[0],
    }
    for row in data['registry']:
        old_column = '\n'.join(line.split('|')[1] for line in sections[row['target_type']].splitlines() if line.startswith('|'))
        assert re.search(rf"(?<![\w]){re.escape(row['id'])}(?![\w])", old_column), row
    keys = [(r['target_type'], r['id']) for r in data['registry']]
    assert len(keys) == len(set(keys)), 'duplicate registry identity'
    assert {r['target_type'] for r in data['registry']} == {'instance', 'server', 'network_device'}
    for rows in [data['registry'], data['provider_cases'], data['realtime_fields'], data['references']]:
        for row in rows:
            assert (ROOT / row['path']).is_file(), row['path']
    # Check every exact full source path mentioned in the consumer table.
    for path in re.findall(r'`((?:apps/db-ops-api|frontend)/[^`]+\.ts)`', text(HERE / 'consumers.md')):
        assert (ROOT / path).is_file(), f'bad consumer path: {path}'
    fixtures = json.loads(text(HERE / 'fixtures.json'))
    assert fixtures['synthetic'] is True
    assert {f['resource_type'] for f in fixtures['resources']} == {'instance', 'server', 'network_device'}
    for resource in fixtures['resources']:
        assert resource['semantic_version'] == data['version']
        assert resource['legacy_ids'] and resource['source'] and resource['candidate_ids']
        for old in resource['legacy_ids']:
            assert old in ids, old
    db, host, network = fixtures['resources']
    assert db['raw']['Uptime'] == db['expected']['db.uptime_seconds']
    assert round(db['raw']['pool_used'] / db['raw']['pool_total'] * 100, 2) == db['expected']['dameng.memory.pool_used_percent']
    assert host['raw']['filesystem']['used'] == host['expected']['host.filesystem.used_bytes']
    assert host['raw']['filesystem']['size'] != host['raw']['filesystem']['used'] + host['raw']['filesystem']['available']
    host_net = host['raw']['network']
    assert (int(host_net['current']) - int(host_net['previous'])) * 8 / host_net['elapsed_seconds'] == host['expected']['comparable_traffic_bps']
    for case in network['counter_cases']:
        current, previous = int(case['current']), int(case['previous'])
        if case['reason'] == 'valid':
            assert current >= previous
            rate = (current - previous) * 8 / case['elapsed_seconds']
            assert rate == case['expected_bps']
        else:
            assert case['expected_bps'] is None
    assert network['counter_cases'][0]['expected_bps'] == network['counter_cases'][1]['expected_bps']
    assert network['counter_cases'][0]['expected_bps'] == host['expected']['comparable_traffic_bps']
    assert any(int(c['current']) > 2**53 for c in network['counter_cases']), 'missing precise Counter64 sample'
    for case in network['utilization_cases']:
        if case['speed_bps'] and not case.get('invalid_denominator'):
            assert case['expected_percent'] == case['bps'] / case['speed_bps'] * 100
        else:
            assert case['expected_percent'] is None
    assert network['dimensions']['direction'] == 'in'
    for case in network['status_cases']:
        assert case['expected'] == {1: 1, 2: 0}.get(case['raw'])
    assert network['vendor_extension']['expected_value'] is None
    assert host['dimensions']['mount'] == '/data'
    assert len(fixtures['non_mappable']) >= 2
    for case in fixtures['non_mappable']:
        assert case['left_semantics'] != case['right_semantics'] and case['mapping_allowed'] is False
    serialized = json.dumps(fixtures).lower()
    assert not re.search(r'password|secret|token|username|community|sql_text|host_address', serialized), 'sensitive fixture field'
    print(f"PASS: {len(keys)} registry identities; {len(data['provider_cases'])} provider cases; "
          f"{len(data['realtime_fields'])} realtime fields; {len(data['references'])} referenced files; "
          '3 resource fixtures; mapping coverage, source paths, arithmetic and negative cases')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    current = snapshot()
    if args.refresh:
        (HERE / 'inventory.json').write_text(json.dumps(current, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    else:
        assert current == json.loads(text(HERE / 'inventory.json')), 'source snapshot drift: review before --refresh'
    verify(current)
