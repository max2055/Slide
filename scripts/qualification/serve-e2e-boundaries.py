#!/usr/bin/env python3
"""Offline validation for stub-only signal boundaries; no process control."""
import json
from decimal import Decimal
from pathlib import Path
import re
import sys

SIGNALS = {'signal-term', 'signal-int', 'signal-during-collect', 'signal-int-during-collect',
           'unrelated-orphan', 'diagnostics-missing', 'diagnostics-unwritable',
           'diagnostics-directory', 'diagnostics-invalidated'}
SIGNAL_TYPES = {name: ('TERM' if name in {'signal-term', 'signal-during-collect', 'unrelated-orphan', 'diagnostics-unwritable'} else 'INT') for name in SIGNALS}
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
            if not (len(f) == 15 and f[11] in EVENTS): raise ValueError("invalid boundary record")
            if not (re.fullmatch(r'\d+\.\d{6}', f[0]) and re.fullmatch(r'\d+\.\d{6}', f[1])): raise ValueError("invalid boundary record")
            if not (float(f[1]) >= float(f[0])): raise ValueError("invalid boundary record")
            for i in (2, 3, 4, 6, 13):
                if not (f[i].isdigit() and int(f[i]) > 0): raise ValueError("invalid boundary record")
            if not (re.fullmatch(r'pid:\[\d+\]', f[5])): raise ValueError("invalid boundary record")
            if not (f[14] in ('INT', 'TERM', 'none')): raise ValueError("invalid boundary record")
            if not (callers.setdefault(f[2], (f[3], f[4], f[5])) == (f[3], f[4], f[5])): raise ValueError("invalid boundary record")
            if not (f[12] == 'na' or f[12].isdigit()): raise ValueError("invalid boundary record")
            if not (int(f[13]) == sequences.get(f[2], 0) + 1): raise ValueError("invalid boundary record")
            sequences[f[2]] = int(f[13])
            if f[7] != 'gone':
                if not (f[7].isdigit() and f[8].isdigit() and f[9] == f[5]): raise ValueError("invalid boundary record")
                if not (identities.setdefault(f[6], (f[7], f[8], f[9])) == (f[7], f[8], f[9])): raise ValueError("invalid boundary record")
            else:
                if not (f[11] == 'wait_after'): raise ValueError("invalid boundary record")
            rows.append(dict(zip(['begin', 'end', 'caller', 'callerStart', 'callerPpid', 'callerNamespace',
                                  'target', 'targetStart', 'targetPpid', 'targetNamespace', 'scenario', 'event', 'rc', 'sequence', 'signal'], f)))
        except (AssertionError, ValueError):
            dropped += 1
    identity_keys = ('caller', 'callerStart', 'callerPpid', 'callerNamespace', 'target', 'targetStart', 'targetPpid', 'targetNamespace')
    def one(selected, event):
        matching = [r for r in selected if r['event'] == event]
        if len(matching) != 1: raise ValueError('missing or duplicate boundary')
        return matching[0]
    def pair(selected, prefix, signal):
        before, after = one(selected, prefix + '_before'), one(selected, prefix + '_after')
        if any(before[k] != after[k] for k in identity_keys): raise ValueError('identity mismatch')
        if before['signal'] != signal or after['signal'] != signal: raise ValueError('signal mismatch')
        if before['rc'] != 'na' or after['rc'] == 'na': raise ValueError('missing return code')
        if int(before['sequence']) >= int(after['sequence']) or Decimal(before['end']) > Decimal(after['begin']): raise ValueError('operation order')
        return before, after
    for scenario in expected:
        selected = [r for r in rows if r['scenario'] == scenario]
        try:
            started, waited = one(selected, 'started'), one(selected, 'wait_after')
            before, after = pair(selected, 'kill', SIGNAL_TYPES.get(scenario, one(selected, 'kill_before')['signal']))
            if any(started[k] != before[k] for k in identity_keys): raise ValueError('start identity mismatch')
            if any(waited[k] != before[k] for k in ('caller', 'callerStart', 'callerPpid', 'callerNamespace', 'target')): raise ValueError('wait identity mismatch')
            if Decimal(started['end']) > Decimal(before['begin']) or Decimal(after['end']) > Decimal(waited['begin']): raise ValueError('scenario order')
            if any(r['event'].startswith('watchdog_kill_') for r in selected):
                wb, wa = pair(selected, 'watchdog_kill', 'TERM')
                if any(wb[k] != started[k] for k in ('target', 'targetStart', 'targetPpid', 'targetNamespace')): raise ValueError('watchdog target mismatch')
                if Decimal(one(selected, 'watchdog_fired')['end']) > Decimal(wb['begin']): raise ValueError('watchdog order')
        except ValueError:
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
