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
    target = root / 'apps/db-ops-api/src/metrics/dry-run'
    target.mkdir(exist_ok=True)
    for name in ['migration-drill.ts', 'migration-drill.test.ts', 'real-migration.ts', 'real-migration.test.ts', 'real-migration-mysql.test.ts']:
        src = Path('apps/db-ops-api/src/metrics/dry-run') / name
        (target / src.name).write_bytes(src.read_bytes())
    for name in ['max236-migrate.ts', 'max236-rollback.ts']:
        src = Path('apps/db-ops-api/scripts') / name
        (root / 'apps/db-ops-api/scripts' / src.name).write_bytes(src.read_bytes())
    for src in Path('docs/slide/development/MAX-236/real-a/sql').glob('*.sql'):
        dst = root / src
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src.read_bytes())
    (target / 'max236-workflow.mysql.test.ts').write_bytes(Path('scripts/max236/workflow.mysql.test.ts').read_bytes())
    (target / 'producer-compat.test.ts').write_bytes(Path('scripts/max236/producer-compat.test.ts').read_bytes())
    patch = Path('scripts/max236/history-envelope.patch').resolve()
    subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(patch)], cwd=root, check=True, timeout=30)
    hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
              for base in ['apps/db-ops-api/src', 'packages/agent-core/src', 'apps/db-ops-api/scripts',
                           'docs/slide/development/MAX-236/real-a/sql']
              for p in (root / base).rglob('*') if p.is_file()}
    hashes['pnpm-lock.yaml'] = hashlib.sha256((root / 'pnpm-lock.yaml').read_bytes()).hexdigest()
    (root / 'max236-sources.json').write_text(json.dumps(dict(event=EVENT, configuration=CONFIG,
        common=BASE, task=git('rev-parse', 'HEAD').decode().strip(), merged=merged,
        compatibility_patch=hashlib.sha256(patch.read_bytes()).hexdigest(), sha256=hashes), indent=2) + '\n')
    print(root)


if __name__ == '__main__':
    prepare(sys.argv[1])
