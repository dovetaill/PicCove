import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('manage', ROOT / 'scripts/manage.py')
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)


class ManageTests(unittest.TestCase):
    def test_release_requires_clean_tree_and_explicit_confirmation(self):
        args = types.SimpleNamespace(yes=False)
        with patch.object(manage, 'current_version', return_value='0.1.0'), patch.object(manage, 'run') as run:
            with patch.object(manage, 'output', return_value='dirty'):
                with self.assertRaisesRegex(ValueError, '提交'):
                    manage.release(args)
            with patch.object(manage, 'output', side_effect=['', 'main']):
                with self.assertRaisesRegex(ValueError, '--yes'):
                    manage.release(args)
            run.assert_not_called()

    def test_release_push_is_atomic_and_tag_is_not_overwritten(self):
        with patch.object(manage, 'current_version', return_value='0.1.0'), patch.object(manage, 'output', side_effect=['', 'main', '', '']), patch.object(manage, 'run') as run:
            manage.release(types.SimpleNamespace(yes=True))
            self.assertEqual(run.call_args_list[-1].args[0], ['git', 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v0.1.0'])
        with patch.object(manage, 'current_version', return_value='0.1.0'), patch.object(manage, 'output', side_effect=['', 'main', 'v0.1.0']), patch.object(manage, 'run') as run:
            with self.assertRaises(ValueError):
                manage.release(types.SimpleNamespace(yes=True))
            run.assert_not_called()

if __name__ == '__main__':
    unittest.main()
