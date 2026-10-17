"""Local qualification fixture, NEVER an installable helper/controller.

Runs the source helper's actual disk/lock/barrier protocol in child processes.
Only fixed paths, root identity and systemctl are replaced for an unprivileged
local fixture. This proves crash semantics, not VM/systemd/SSH qualification.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

SOURCE = Path(__file__).with_name('action-demo-helper.sh')
OP = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


def child(directory, mode, op, plan, config, helper):
    source = SOURCE.read_text().split("<<'PY'\n")[1].split('\nPY')[0]
    ns = {}
    exec(source.split('\ntry:\n    main()')[0], ns)
    ns['STATE'] = directory
    ns['check_path'] = lambda *args: None  # Production check remains unchanged.
    ns['configuration'] = lambda: ({'helperHash': helper}, config)
    ns['os'].geteuid = lambda: 0
    real_fstat = ns['os'].fstat

    def fixture_fstat(fd):
        values = list(real_fstat(fd))
        values[4] = 0  # Unprivileged fixture only; retain mode/nlink/size checks.
        return os.stat_result(values)

    ns['os'].fstat = fixture_fstat
    ns['os'].environ['SUDO_USER'] = 'slide-action'
    count = Path(directory, 'actual-restarts')

    def ctl(*args):
        n = int(count.read_text()) if count.exists() else 0
        if args[0] == 'restart':
            with count.open('w') as f:
                f.write(str(n + 1))
                f.flush()
                os.fsync(f.fileno())
        if args[0] == 'is-active':
            return 'active'
        if args[0] == 'show':
            return format(n + 1, '032x')
        return ''

    ns['ctl'] = ctl
    ns['sys'].argv = ['helper', mode, op, plan, config, helper]
    try:
        ns['main']()
    except Exception:
        print('ACTION_HELPER_REFUSED_OR_UNAVAILABLE', file=sys.stderr)
        sys.exit(1)


def scenario(point, binding=None, timeout=False, invalid=None):
    op, plan, config, helper = binding or (OP, 'b'*64, 'c'*64, 'a'*64)
    with tempfile.TemporaryDirectory(prefix='p07-barrier-') as directory:
        root = Path(directory)
        control = dict(protocol=1, point=point, operationId=op, planHash=plan,
                       configHash=config, helperHash=helper, nonce='d'*32)
        path = root / '.qualification-control'
        if invalid == 'malformed':
            path.write_text('{')
        else:
            if invalid in ('operationId', 'planHash', 'configHash', 'helperHash'):
                control[invalid] = OTHER if invalid == 'operationId' else 'f'*64
            elif invalid == 'point':
                control['point'] = 'shell'
            elif invalid == 'nonce':
                control['nonce'] = '../../bad'
            elif invalid == 'extra':
                control['command'] = 'reboot'
            path.write_text(json.dumps(control))
        path.chmod(0o600)
        if invalid == 'permissions':
            path.chmod(0o644)
        elif invalid == 'symlink':
            path.rename(root / 'control-target')
            path.symlink_to(root / 'control-target')
        elif invalid == 'hardlink':
            os.link(path, root / 'control-link')
        elif invalid == 'absent':
            path.unlink()

        def command(mode, operation=op):
            return [sys.executable, '-I', str(Path(__file__).resolve()), 'child',
                    directory, mode, operation, plan, config, helper]

        def call(mode, operation=op, ok=True):
            result = subprocess.run(command(mode, operation), capture_output=True,
                                    text=True, timeout=15)
            assert (result.returncode == 0) == ok, result.stderr
            return json.loads(result.stdout) if ok else None

        # Control parsing only applies to NEW executes, never read-only receipts.
        assert call('receipt') is None
        marker_path = root / ('.qualification-' + op + '.reached')
        if invalid:
            result = call('execute', ok=invalid == 'absent')
            if invalid == 'absent':
                assert result['outcome'] == 'succeeded'
                assert int((root / 'actual-restarts').read_text()) == 1
            else:
                assert not (root / (op + '.json')).exists()
                assert not (root / 'actual-restarts').exists()
            assert not marker_path.exists()
            return {'rejected': invalid != 'absent', 'control': invalid}

        process = subprocess.Popen(command('execute'), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not marker_path.exists() and time.monotonic() < deadline:
                assert process.poll() is None, 'helper exited before barrier'
                time.sleep(0.01)
            marker = json.loads(marker_path.read_text())
            assert marker['pid'] == process.pid
            assert all(marker[k] == v for k, v in control.items())
            intent_path = root / (op + '.json')
            intent_bytes = intent_path.read_bytes()
            expected = 0 if point == 'after_intent' else 1
            actual = int((root / 'actual-restarts').read_text()) if (root / 'actual-restarts').exists() else 0
            assert actual == expected
            if not timeout:
                process.kill()  # Exact child handle; no port/name/global kills.
            stdout, stderr = process.communicate(timeout=15)
            if timeout:
                assert process.returncode == (1 if point == 'after_intent' else 0), stderr
            else:
                assert process.returncode < 0
            assert intent_path.read_bytes() == intent_bytes
            # Fresh processes only read the original unknown, even on execute.
            receipt = call('receipt')
            assert receipt['outcome'] == 'outcome_unknown' and receipt['after'] is None
            assert call('execute') == receipt
            call('execute', OTHER, ok=False)
            assert intent_path.read_bytes() == intent_bytes
            actual_after = int((root / 'actual-restarts').read_text()) if (root / 'actual-restarts').exists() else 0
            assert actual_after == expected
            return {'point': point, 'timeout': timeout, 'restartCount': actual_after,
                    'receipt': receipt, 'killed': not timeout, 'markerBound': True,
                    'duplicateRestartDelta': 0, 'newOperationBlocked': True}
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


if __name__ == '__main__':
    if sys.argv[1] == 'child':
        child(*sys.argv[2:])
    elif sys.argv[1] == 'scenario':
        print(json.dumps(scenario(sys.argv[2], sys.argv[3:] or None)))
    elif sys.argv[1] == 'timeout':
        print(json.dumps(scenario(sys.argv[2], timeout=True)))
    elif sys.argv[1] == 'invalid':
        print(json.dumps(scenario('after_intent', invalid=sys.argv[2])))
