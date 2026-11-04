#!/usr/bin/env python3
"""#290: real Docker regression, using generated, non-sensitive fixtures only.

Run from any directory: python3 scripts/qualification/check-dockerignore.py
Requires Python 3 and a working Docker daemon. No base image, runtime, database,
or real environment file is used. Every generated Docker resource is removed.
"""

import argparse
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[2]
PRIVATE_SENTINEL = b"SLIDE_290_SYNTHETIC_PRIVATE_SENTINEL_NOT_A_SECRET\n"
PUBLIC_SENTINEL = b"SLIDE_290_SYNTHETIC_PUBLIC_FIXTURE\n"
DIRECTORIES = (
    "", "frontend/", "frontend/deep/nested/", "packages/agent-core/",
    "apps/db-ops-skills/", "apps/db-ops-api/", "deploy/", "unknown/a/b/",
)
PRIVATE_NAMES = (
    ".env", ".env.local", ".env.production", ".env.test", ".env.PRODUCTION",
    ".env.unseen-290", ".env.backup", ".env.example.bak",
    ".env.production.example.bak", ".env.vault", ".env.enc",
)
EXAMPLES = (".env.example", "apps/db-ops-api/.env.example", "deploy/.env.production.example")
CONFIGS = ("package.json", "frontend/vite.config.ts", "frontend/nginx.conf",
           "apps/db-ops-api/config.json", "packages/agent-core/package.json",
           "apps/db-ops-skills/README.md", "deploy/compose.yaml")


def run(*command):
    print("$ " + shlex.join(command), flush=True)
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout.decode(errors="replace"), end="", flush=True)
    result.check_returncode()
    return result.stdout


def check_archive(data, label, private, public):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        files = {m.name.removeprefix("./"): archive.extractfile(m).read()
                 for m in archive.getmembers() if m.isfile()}
    failures = []
    for path in private:
        passed = "context/" + path not in files
        print(f"{label}: {'PASS' if passed else 'FAIL'} exclude {path}")
        if not passed:
            failures.append(path)
    for path in public:
        passed = files.get("context/" + path) == PUBLIC_SENTINEL
        print(f"{label}: {'PASS' if passed else 'FAIL'} preserve {path}")
        if not passed:
            failures.append(path)
    content_clean = all(PRIVATE_SENTINEL not in content for content in files.values())
    print(f"{label}: {'PASS' if content_clean else 'FAIL'} private sentinel absent from all file contents")
    print(f"{label}: inventory {json.dumps(sorted(files))}")
    return not failures and content_clean


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ignore-file", type=Path, default=ROOT / ".dockerignore")
    args = parser.parse_args()
    # Read only this rule file; never enumerate or copy worktree environment files.
    rules = args.ignore_file.read_bytes()
    private = [directory + name for directory in DIRECTORIES for name in PRIVATE_NAMES]
    private += ["unknown/.env.example", "unknown/.env.production.example",
                "frontend/.env.example", "unknown/.env/inside.txt",
                "unknown/.env.unseen-dir/inside.txt"]
    public = list(EXAMPLES + CONFIGS)
    tag = "slide-290-check:" + uuid.uuid4().hex
    container = "slide-290-check-" + uuid.uuid4().hex
    image_created = False
    container_created = False
    passed = False
    run("docker", "version")
    with tempfile.TemporaryDirectory(prefix="slide-290-fixtures-") as temporary:
        directory = Path(temporary)
        context = directory / "context"
        context.mkdir()
        (context / ".dockerignore").write_bytes(rules)
        (context / "Dockerfile").write_text("FROM scratch\nCOPY . /context/\n")
        for path in private + public:
            fixture = context / path
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_bytes(PRIVATE_SENTINEL if path in private else PUBLIC_SENTINEL)
        print(f"Generated fixtures: private={len(private)}, public={len(public)}", flush=True)
        try:
            run("docker", "build", "--no-cache", "--progress=plain", "--tag", tag, str(context))
            image_created = True
            run("docker", "image", "inspect", tag)
            run("docker", "create", "--name", container, tag, "/unused-not-executed")
            container_created = True
            exported = directory / "rootfs.tar"
            run("docker", "export", "--output", str(exported), container)
            rootfs_passed = check_archive(exported.read_bytes(), "rootfs", private, public)
            saved = directory / "image.tar"
            run("docker", "image", "save", "--output", str(saved), tag)
            with tarfile.open(saved) as image:
                manifest = json.load(image.extractfile("manifest.json"))
                layers = manifest[0]["Layers"]
                # FROM scratch + one COPY must have one layer: no hidden lower layers.
                if len(layers) != 1:
                    raise RuntimeError(f"Expected exactly one COPY layer, got {len(layers)}")
                layer_passed = check_archive(image.extractfile(layers[0]).read(), "image-layer", private, public)
            passed = rootfs_passed and layer_passed
        finally:
            if container_created:
                run("docker", "container", "rm", container)
            if image_created:
                run("docker", "image", "rm", tag)
    print("CLEANUP: generated context, tar files, container and image removed; synthetic-only COPY cache may remain")
    print(f"RESULT: {'PASS' if passed else 'FAIL'}; private={len(private)}, public={len(public)}; rootfs + all layers")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
