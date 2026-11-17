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
                return ['|'.join(['1.000001', '1.000002', '10', '100', '1', 'pid:[1]', '20', '200', '10', 'pid:[1]', 'probe', event, rc, str(i + 1), 'INT'])
                        for i, (event, rc) in enumerate([('started', 'na'), ('kill_before', 'na'), ('kill_after', '0'), ('wait_after', '0')])]
            path.write_text('\n'.join(rows()) + '\n')
            result = module.validate(root, True, {'probe'})
            self.assertEqual(result['dropped'], 0)
            for invalid in [rows()[:-1], [r.replace('|100|', '|invalid|') for r in rows()]]:
                path.write_text('\n'.join(invalid) + '\n')
                with self.assertRaises(ValueError): module.validate(root, True, {'probe'})

    def test_unsupported_is_explicit(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(module.validate(root, False)['dropped'])


if __name__ == '__main__': unittest.main()
