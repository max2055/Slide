#!/usr/bin/env python3
"""Bounded, stub-only supervisor evidence. Never used by serve-e2e.sh."""
import hashlib
import json
import os
import re
from pathlib import Path
import sys
import time

TRACE_LIMIT = 512 * 1024
ARCHIVE_LIMIT = 8 * 1024 * 1024
TRACE_RECORD = re.compile(rb'ts=[0-9]+\.[0-9]{6} pid=[1-9][0-9]* func=[A-Za-z_][A-Za-z_0-9]* line=[1-9][0-9]* event=(?:step|signal_observed)\n')
FILES = ('report', 'stderr', 'stdout', 'signal-sent', 'watchdog-fired',
         'watchdog-processes', 'identities.json', 'bash.trace', 'bash.trace.json', 'trace-support',
         'diagnostic-errors', 'lifecycle.json')


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def identity(pid):
    root = Path('/proc') / str(int(pid))
    # comm may contain spaces or parentheses; fields after the last ')' start at state.
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': int(pid), 'ppid': int(fields[1]), 'start': fields[19]}


def record(directory, script, root, pids):
    if not Path('/proc/self/stat').exists():
        write_json(directory / 'identities.json', {'unsupported': sys.platform})
        return
    supervisor, tracker, api, api_child, vite, vite_child = map(int, pids)
    entries = [identity(pid) for pid in (supervisor, tracker, api, api_child, vite, vite_child)]
    command = (Path('/proc') / str(supervisor) / 'cmdline').read_bytes().split(b'\0')
    if os.fsencode(script) not in command or os.readlink(f'/proc/{supervisor}/cwd') != root:
        raise RuntimeError('supervisor identity mismatch')
    tracker_command = (Path('/proc') / str(tracker) / 'cmdline').read_bytes().split(b'\0')
    if os.fsencode(str(Path(script).with_name('serve-e2e-tracker.py'))) not in tracker_command:
        raise RuntimeError('tracker identity mismatch')
    expected = (None, supervisor, tracker, api, tracker, vite)
    for entry, parent in zip(entries, expected):
        if parent is not None and entry['ppid'] != parent:
            raise RuntimeError('recorded service ancestry mismatch')
        if identity(entry['pid']) != entry:
            raise RuntimeError('process changed during identity capture')
    write_json(directory / 'identities.json', {'capturedAt': time.time(), 'processes': entries})


def snapshot(directory):
    saved = json.loads((directory / 'identities.json').read_text())
    if 'unsupported' in saved:
        write_json(directory / 'watchdog-processes', saved)
        return
    rows = []
    for entry in saved['processes']:
        try:
            current = identity(entry['pid'])
            if current['start'] != entry['start']:
                rows.append({'pid': entry['pid'], 'state': 'identity-changed'})
                continue  # Never inspect the replacement process.
            base = Path('/proc') / str(entry['pid'])
            status = [line for line in (base / 'status').read_text().splitlines()
                      if line.split(':', 1)[0] in ('State', 'PPid', 'SigPnd', 'ShdPnd', 'SigBlk', 'SigIgn', 'SigCgt')]
            wchan = (base / 'wchan').read_text()[:256]
            if identity(entry['pid'])['start'] != entry['start']:
                rows.append({'pid': entry['pid'], 'state': 'identity-changed'})
                continue
            rows.append({**current, 'wchan': wchan, 'status': status})
        except FileNotFoundError:
            rows.append({'pid': entry['pid'], 'state': 'gone'})
    write_json(directory / 'watchdog-processes', {'capturedAt': time.time(), 'processes': rows})


def trace(fifo, destination):
    # A failed evidence destination must not close the pipe and SIGPIPE the service.
    output = None
    error = None
    total = 0
    retained = 0
    pending = b''
    dropping = False
    try:
        output = open(destination, 'wb')
    except OSError as failure:
        error = type(failure).__name__
    with open(fifo, 'rb', buffering=0) as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            total += len(chunk)
            # Reject unstructured data before writing any bytes to the raw trace.
            # Bound pending input as well as disk; keep draining after invalid/long lines.
            for piece in chunk.splitlines(keepends=True):
                if dropping:
                    if piece.endswith(b'\n'):
                        dropping = False
                    continue
                pending += piece
                if len(pending) > 256:
                    error = error or 'InvalidTraceRecord'
                    dropping = not pending.endswith(b'\n')
                    pending = b''
                    continue
                if not pending.endswith(b'\n'):
                    continue
                record = pending
                pending = b''
                if not TRACE_RECORD.fullmatch(record):
                    error = error or 'InvalidTraceRecord'
                    continue
                if output is not None and retained + len(record) <= TRACE_LIMIT:
                    try:
                        output.write(record)
                        retained += len(record)
                    except OSError as failure:
                        error = type(failure).__name__
                        try:
                            output.close()
                        except OSError:
                            pass
                        output = None
    if pending or dropping:
        error = error or 'InvalidTraceRecord'
    if output is not None:
        try:
            output.close()
        except OSError as failure:
            error = type(failure).__name__
    try:
        write_json(str(destination) + '.json', {'bytesSeen': total, 'bytesRetained': retained,
                   'truncated': total > retained, 'error': error})
    except OSError:
        return 1
    return int(error is not None)


def validate(path, signal, script_pid, code):
    records = Path(path).read_bytes().splitlines(keepends=True)
    if not records or not all(TRACE_RECORD.fullmatch(line) for line in records):
        raise RuntimeError('missing structured trace')
    if signal in ('TERM', 'INT'):
        # Bash retains BASH_COMMAND from the interrupted command inside signal/EXIT
        # traps. Observe the original trap's flag at the next DEBUG boundary instead
        # of mislabelling that stale command, and link to the actual wait exit status.
        own = [row for row in records if b' pid=' + script_pid.encode() + b' ' in row]
        for index, line in enumerate(own):
            if b' event=signal_observed' not in line:
                continue
            wanted = [b' func=check_stop ', b' func=cleanup ']
            matched = []
            for row in own[index:]:
                if wanted and wanted[0] in row:
                    matched.append(row.decode().strip())
                    wanted.pop(0)
            if not wanted:
                write_json(Path(path).with_name('lifecycle.json'), {
                    'scriptPid': int(script_pid), 'signal': signal,
                    'trapEffectObserved': line.decode().strip(),
                    'previousBoundary': own[index - 1].decode().strip() if index else None,
                    'checkStopAndCleanup': matched, 'lastBoundary': own[-1].decode().strip(),
                    'exitCode': int(code), 'exitSource': 'harness wait, not a synthetic target event',
                })
                return
        raise RuntimeError('signal/check_stop/cleanup correlation missing')


def preserve(work, destination):
    destination.mkdir(parents=True, exist_ok=True)
    remaining = ARCHIVE_LIMIT
    manifest = []
    for directory in sorted(work.iterdir()):
        if not directory.is_dir() or directory.is_symlink():
            continue
        for name in FILES:
            source = directory / name
            if source.is_symlink() or not source.is_file():
                continue
            size = source.stat().st_size
            with source.open('rb') as stream:
                data = stream.read(min(TRACE_LIMIT, remaining))
            target = destination / directory.name / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(data)
            remaining -= len(data)
            manifest.append({'path': str(target.relative_to(destination)), 'sourceBytes': size,
                             'retainedBytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    write_json(destination / 'manifest.json', manifest)


if __name__ == '__main__':
    try:
        operation, *args = sys.argv[1:]
        if operation == 'trace':
            sys.exit(trace(*args))
        elif operation == 'record':
            record(Path(args[0]), args[1], args[2], args[3:])
        elif operation == 'snapshot':
            snapshot(Path(args[0]))
        elif operation == 'validate':
            validate(*args)
        elif operation == 'preserve':
            preserve(Path(args[0]), Path(args[1]))
        else:
            raise ValueError('unknown evidence operation')
    except Exception as error:
        # No exception text: filesystem paths or argv are not evidence here.
        print('supervisor evidence error: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
