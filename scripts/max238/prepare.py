#!/usr/bin/env python3
"""Assemble pinned owner sources privately; never replace the task branch files."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

EVENT = '0a9eec2e13b03c7665c025080fce799f769247fe'
CONFIG = 'b5c140c1d646bfb5581ff88da7498b4793e7322d'
BASE = '88fc15e2bce814218ff2f1836a33d57ff236eef6'


def git(*args):
    return subprocess.check_output(['git', *args], timeout=60)


def prepare(destination):
    root = Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=False)
    tarfile.open(fileobj=io.BytesIO(git('archive', EVENT))).extractall(root, filter='data')
    merged = []
    for p in git('diff', '--name-only', BASE, CONFIG).decode().splitlines():
        if not p.startswith('apps/db-ops-api/src/'):
            continue
        dst = root / p
        dst.parent.mkdir(parents=True, exist_ok=True)
        new = git('show', CONFIG + ':' + p)
        old = subprocess.run(['git', 'show', BASE + ':' + p], capture_output=True, timeout=30).stdout
        if dst.exists() and dst.read_bytes() not in (old, new):
            files = []
            for name, data in [('ours', dst.read_bytes()), ('base', old), ('theirs', new)]:
                f = root / ('merge-' + name)
                f.write_bytes(data)
                files.append(str(f))
            r = subprocess.run(['git', 'merge-file', '-p', *files], capture_output=True, timeout=30)
            if r.returncode:
                # Both owners add imports at line 1. Preserve the complete union.
                assert p == 'apps/db-ops-api/src/contracts/metrics/public-api.ts' and r.returncode == 1
                lines = r.stdout.decode().splitlines(True)
                assert sum(line.startswith('<<<<<<<') for line in lines) == 1
                r.stdout = ''.join(line for line in lines if not line.startswith(('<<<<<<<', '=======', '>>>>>>>'))).encode()
            dst.write_bytes(r.stdout)
            merged.append(p)
        else:
            dst.write_bytes(new)
    for p in ['node_modules', 'packages/agent-core/node_modules', 'frontend/node_modules']:
        (root / p).symlink_to(Path(p).resolve(), target_is_directory=True)
    # External packages are the frozen lockfile install; workspace code resolves
    # to this private assembly, not whichever task files the install links to.
    modules = root / 'apps/db-ops-api/node_modules'
    modules.mkdir()
    for dep in Path('apps/db-ops-api/node_modules').iterdir():
        if dep.name == '@slide':
            (modules / dep.name).mkdir()
            (modules / dep.name / 'agent-core').symlink_to(root / 'packages/agent-core', target_is_directory=True)
        else:
            (modules / dep.name).symlink_to(dep.resolve(), target_is_directory=dep.is_dir())
    target = root / 'apps/db-ops-api/src/metrics/policy'
    for name in ['configuration-history.ts', 'configuration-history.test.ts', 'configuration-history.mysql.test.ts']:
        (target / name).write_bytes((Path('apps/db-ops-api/src/metrics/policy') / name).read_bytes())
    for name in ['producer-compat.test.ts', 'consecutive.mysql.test.ts']:
        (target / name).write_bytes((Path('scripts/max238') / name).read_bytes())
    harness = Path('frontend/e2e/max238-unbind-preview.sh').read_text()
    command = 'MAX238_HISTORY_MYSQL_PORT="$port" pnpm --filter slide-api exec vitest run src/metrics/policy/configuration-history.mysql.test.ts'
    assert command in harness
    harness = harness.replace(command, '(cd ../apps/db-ops-api && MAX238_HISTORY_MYSQL_PORT="$port" node node_modules/vitest/vitest.mjs run src/metrics/policy/consecutive.mysql.test.ts src/metrics/policy/producer-compat.test.ts)')
    (root / 'frontend/e2e/max238-unbind-preview.sh').write_text(harness)
    hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (root / 'apps/db-ops-api/src').rglob('*') if p.is_file()}
    (root / 'max238-sources.json').write_text(json.dumps(dict(event=EVENT, configuration=CONFIG,
        common=BASE, task=git('rev-parse', 'HEAD').decode().strip(), merged=merged, sha256=hashes), indent=2) + '\n')
    print(root)

if __name__ == '__main__':
    prepare(sys.argv[1])
