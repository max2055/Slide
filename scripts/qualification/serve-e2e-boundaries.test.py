import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('boundaries', Path(__file__).with_name('serve-e2e-boundaries.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BoundaryValidation(unittest.TestCase):
    def test_complete_and_lost_or_invalid_identity(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'signal-boundaries.tsv'
            def rows():
                return ['|'.join([f'1.{i*10+1:06}', f'1.{i*10+2:06}', '10', '100', '1', 'pid:[1]', '20', '200', '10', 'pid:[1]', 'probe', event, rc, str(i + 1), 'INT'])
                        for i, (event, rc) in enumerate([('started', 'na'), ('kill_before', 'na'), ('kill_after', '0'), ('wait_after', '0')])]
            path.write_text('\n'.join(rows()) + '\n')
            result = module.validate(root, True, {'probe'})
            self.assertEqual(result['dropped'], 0)
            for invalid in [rows()[:-1], [r.replace('|100|', '|invalid|') for r in rows()]]:
                path.write_text('\n'.join(invalid) + '\n')
                with self.assertRaises(ValueError): module.validate(root, True, {'probe'})

    def test_mismatched_operation_is_rejected_and_nonzero_rc_retained(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'signal-boundaries.tsv'
            rows = [[f'1.{i*10+1:06}', f'1.{i*10+2:06}', '10', '100', '1', 'pid:[1]', '20', '200', '10', 'pid:[1]', 'probe', event, rc, str(i+1), 'INT']
                    for i, (event, rc) in enumerate([('started', 'na'), ('kill_before', 'na'), ('kill_after', '7'), ('wait_after', '0')])]
            def write(data): path.write_text('\n'.join('|'.join(r) for r in data) + '\n')
            write(rows)
            result = module.validate(root, True, {'probe'})
            self.assertEqual(result['records'][2]['rc'], '7')
            import copy
            for column, value in [(6, '21'), (3, '101'), (7, '201'), (14, 'TERM'), (2, '30'), (0, '0.000001')]:
                bad = copy.deepcopy(rows); bad[2][column] = value; write(bad)
                with self.assertRaises(ValueError): module.validate(root, True, {'probe'})
            bad = copy.deepcopy(rows); bad[2][0]='1.000003'; bad[2][1]='1.000004'; write(bad)
            with self.assertRaises(ValueError): module.validate(root, True, {'probe'})

    def test_unsupported_is_explicit(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(module.validate(root, False)['dropped'])


if __name__ == '__main__': unittest.main()
