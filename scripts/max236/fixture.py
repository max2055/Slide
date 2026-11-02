#!/usr/bin/env python3
"""Nonce-owned MySQL for MAX236. Unknown ownership always preserves the journal."""
import argparse
import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

if not __debug__:
    raise RuntimeError('optimized Python disables ownership assertions; refused')


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=45).strip()


def save(path, data):
    temporary = path.with_suffix('.pending')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def inspect(kind, identity):
    return json.loads(docker(kind, 'inspect', identity))[0]


def verify_storage(h):
    n = inspect('network', h['network_id'])
    v = inspect('volume', h['volume'])
    for obj in (n, v):
        assert all(obj['Labels'].get(k) == val for k, val in h['volume_labels'].items()), 'labels changed'
    assert n['Id'] == h['network_id'] and v['Name'] == h['volume'], 'storage changed'
    assert n['Name'] == h['network'], 'network changed'


def verify(h, stopped=False):
    c = inspect('container', h['container_id'])
    n = inspect('network', h['network_id'])
    v = inspect('volume', h['volume'])
    for obj in (c['Config'], n, v):
        assert all(obj['Labels'].get(k) == val for k, val in h['volume_labels'].items()), 'labels changed'
    assert c['Id'] == h['container_id'] and c['Image'] == h['image'], 'container changed'
    assert n['Id'] == h['network_id'] and v['Name'] == h['volume'], 'storage changed'
    assert len(c['Mounts']) == 1 and c['Mounts'][0]['Name'] == h['volume'], 'mount changed'
    assert c['Mounts'][0]['Type'] == 'volume' and c['Mounts'][0]['Destination'] == '/var/lib/mysql', 'mount changed'
    assert list(c['NetworkSettings']['Networks']) == [h['network']], 'network changed'
    actual_network = c['NetworkSettings']['Networks'][h['network']]['NetworkID']
    assert actual_network == h['network_id'] or (stopped and actual_network == ''), 'network ID changed'
    if stopped:
        verify_storage(h)
        assert c['HostConfig']['NetworkMode'] in (h['network'], h['network_id']), 'network intent changed'
        assert not c['State']['Running'], 'container already running'
        assert c['HostConfig']['PortBindings'] == {'3306/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}, 'port intent changed'
    else:
        assert c['NetworkSettings']['Ports'] == {'3306/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(h['port'])}]}, 'port changed'
    return c


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['create', 'verify', 'drill', 'workflow', 'clean'])
    p.add_argument('handle', type=Path)
    args = p.parse_args()
    path = args.handle.resolve()
    if args.action == 'create':
        path.parent.mkdir(parents=True, exist_ok=True)
        nonce = secrets.token_hex(12)
        name = 'max236-' + nonce
        labels = {'max236.owner': '15coder1-' + nonce, 'max236.phase': 'P0-REAL-A', 'max236.nonce': nonce}
        h = dict(nonce=nonce, cwd=str(Path.cwd()), pid=os.getpid(), owner=labels['max236.owner'],
                 phase=labels['max236.phase'], container_name=name, container_id=None,
                 network=name, network_id=None, volume=name, volume_destination='/var/lib/mysql',
                 volume_labels=labels, database='max236_reala', schemas=['max236_reala', 'max236_reala_test', 'max236_reala_copy'],
                 user='root', password='empty', resources=['instance:9101', 'server:9201'],
                 created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), state='planned')
        # Exclusive creation: never overwrite a previous run's handle.
        with path.open('x') as f:
            json.dump(h, f)
        path.chmod(0o600)
        flags = [part for k, val in labels.items() for part in ('--label', k + '=' + val)]
        h['network_id'] = docker('network', 'create', *flags, name)
        save(path, h)
        docker('volume', 'create', *flags, name)
        save(path, h)
        # Create stopped; record exact ID before starting any server.
        h['container_id'] = docker('create', '--name', name, *flags, '--network', name,
                                   '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-p', '127.0.0.1::3306',
                                   '-v', name + ':/var/lib/mysql', 'mysql:8.4')
        h['image'] = inspect('container', h['container_id'])['Image']
        h['state'] = 'created'
        save(path, h)
        verify(h, stopped=True)
        docker('start', h['container_id'])
        c = inspect('container', h['container_id'])
        h['port'] = int(c['NetworkSettings']['Ports']['3306/tcp'][0]['HostPort'])
        assert h['port'] != 3306
        save(path, h)
        # Docker resolves the ephemeral port in NetworkSettings.
        for _ in range(90):
            verify(h)
            r = subprocess.run(['docker', 'exec', h['container_id'], 'mysqladmin', 'ping', '-h127.0.0.1', '-uroot', '--silent'], capture_output=True, timeout=5)
            if r.returncode == 0:
                h['state'] = 'ready'
                save(path, h)
                print(json.dumps({'handle': str(path), 'port': h['port'], 'container_id': h['container_id']}))
                return
            time.sleep(1)
        raise RuntimeError('readiness unknown; preserve handle')
    h = json.loads(path.read_text())
    verify(h, stopped=h['state'] == 'created')
    if args.action == 'drill':
        assert h['state'] == 'ready' and h['cwd'] == str(Path.cwd()), 'wrong run or cwd'
        env = dict(os.environ, MAX236_REALA_HANDLE=str(path),
                   MAX236_REALA_MYSQL_DSN=f"mysql://root@127.0.0.1:{h['port']}")
        subprocess.run(['pnpm', '--filter', 'slide-api', 'exec', 'vitest', 'run',
                        'src/metrics/dry-run/real-migration-mysql.test.ts'], env=env, check=True, timeout=300)
    if args.action == 'workflow':
        assert h['state'] == 'ready' and h['cwd'] == str(Path.cwd()), 'wrong run or cwd'
        source = path.parent / ('source-' + h['nonce'])
        output = path.parent / ('results-' + h['nonce'])
        # Existing assemblies are never silently reused or overwritten.
        subprocess.run(['python3', 'scripts/max236/prepare.py', str(source)], check=True, timeout=120)
        verify(h)
        env = dict(os.environ, MAX236_REALA_HANDLE=str(path), MAX236_WORKFLOW='1', MAX236_OUTPUT=str(output))
        with (path.parent / ('workflow-' + h['nonce'] + '.log')).open('x') as log:
            subprocess.run(['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
                           cwd=source / 'apps/db-ops-api', check=True, timeout=180,
                           stdout=log, stderr=subprocess.STDOUT)
            subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
                            'src/metrics/dry-run/max236-workflow.mysql.test.ts'],
                           cwd=source / 'apps/db-ops-api', env=env, check=True, timeout=1860,
                           stdout=log, stderr=subprocess.STDOUT)
        verify(h)
        print(json.dumps({'source': str(source), 'results': str(output)}))
    if args.action == 'clean':
        docker('stop', '--time', '30', h['container_id'])
        verify(h, stopped=True)
        docker('rm', h['container_id'])
        verify_storage(h)
        docker('network', 'rm', h['network_id'])
        v = inspect('volume', h['volume'])
        assert v['Name'] == h['volume'] and all(v['Labels'].get(k) == val for k, val in h['volume_labels'].items()), 'volume changed'
        docker('volume', 'rm', h['volume'])
        # Successful list calls distinguish confirmed absence from inspect
        # failure/daemon outage. Compare exact identities, never prefixes.
        assert h['container_id'] not in docker('container', 'ls', '-aq', '--no-trunc').splitlines()
        assert h['network_id'] not in docker('network', 'ls', '-q', '--no-trunc').splitlines()
        assert h['volume'] not in docker('volume', 'ls', '-q').splitlines()
        h['state'] = 'cleaned'
        save(path, h)
    print(h['state'])


if __name__ == '__main__':
    main()
