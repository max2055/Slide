#!/usr/bin/env python3
"""Offline validation for stub-only signal boundaries; no process control."""
import json
from pathlib import Path
import re
import sys

SIGNALS = {'signal-term', 'signal-int', 'signal-during-collect', 'signal-int-during-collect',
           'unrelated-orphan', 'diagnostics-missing', 'diagnostics-unwritable',
           'diagnostics-directory', 'diagnostics-invalidated'}
EVENTS = {'started', 'unlink_before', 'unlink_after', 'mkdir_before', 'mkdir_after',
          'kill_before', 'kill_after', 'watchdog_fired', 'watchdog_kill_before', 'watchdog_kill_after', 'wait_after'}


def validate(directory, supported, expected=SIGNALS):
    directory = Path(directory)
    if not supported:
        result = {'supported': False, 'dropped': None, 'reason': 'clock_or_proc_unavailable'}
        (directory / 'boundary-summary.json').write_text(json.dumps(result) + '\n')
        return result
    rows = []
    sequences = {}
    identities = {}
    callers = {}
    dropped = 0
    for line in (directory / 'signal-boundaries.tsv').read_text().splitlines():
        try:
            f = line.split('|')
            assert len(f) == 15 and f[11] in EVENTS
            assert re.fullmatch(r'\d+\.\d{6}', f[0]) and re.fullmatch(r'\d+\.\d{6}', f[1])
            assert float(f[1]) >= float(f[0])
            for i in (2, 3, 4, 6, 13):
                assert f[i].isdigit() and int(f[i]) > 0
            assert re.fullmatch(r'pid:\[\d+\]', f[5])
            assert f[14] in ('INT', 'TERM', 'none')
            assert callers.setdefault(f[2], (f[3], f[4], f[5])) == (f[3], f[4], f[5])
            assert f[12] == 'na' or f[12].isdigit()
            assert int(f[13]) == sequences.get(f[2], 0) + 1
            sequences[f[2]] = int(f[13])
            if f[7] != 'gone':
                assert f[7].isdigit() and f[8].isdigit() and f[9] == f[5]
                assert identities.setdefault(f[6], (f[7], f[8], f[9])) == (f[7], f[8], f[9])
            else:
                assert f[11] == 'wait_after'
            rows.append(dict(zip(['begin', 'end', 'caller', 'callerStart', 'callerPpid', 'callerNamespace',
                                  'target', 'targetStart', 'targetPpid', 'targetNamespace', 'scenario', 'event', 'rc', 'sequence', 'signal'], f)))
        except (AssertionError, ValueError):
            dropped += 1
    for scenario in expected:
        selected = [r for r in rows if r['scenario'] == scenario]
        for event in ('started', 'kill_before', 'kill_after', 'wait_after'):
            if sum(r['event'] == event for r in selected) != 1:
                dropped += 1
    errors = directory / 'boundary-errors'
    if errors.exists():
        dropped += len(errors.read_text().splitlines())
    result = {'supported': True, 'dropped': dropped, 'records': rows,
              'clock': 'EPOCHREALTIME/CLOCK_REALTIME; begin/end bound observation overhead; not kernel delivery',
              'maxObservationSeconds': max([float(r['end']) - float(r['begin']) for r in rows] or [0])}
    (directory / 'boundary-summary.json').write_text(json.dumps(result, indent=2) + '\n')
    if dropped:
        raise ValueError('incomplete boundary evidence')
    return result


if __name__ == '__main__':
    try:
        result = validate(sys.argv[1], sys.argv[2] == '1')
        print(json.dumps({k: v for k, v in result.items() if k != 'records'}))
        if not result['supported'] and sys.platform.startswith('linux'): sys.exit(1)
    except Exception:
        print('EVIDENCE_ERROR signal boundaries', file=sys.stderr)
        sys.exit(1)
