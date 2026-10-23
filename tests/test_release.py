import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

release = load('release')
sys.modules['release'] = release
publish = load('publish')

class ReleaseTests(unittest.TestCase):
    def test_current_version(self):
        self.assertRegex(release.version(), r'^\d+\.\d+\.\d+$')
        release.validate_tag('v' + release.version())
        with self.assertRaises(ValueError):
            release.validate_tag('v999.0.0')

    def test_version_update_all_manifests(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['apps/api/Cargo.toml', 'apps/api/Cargo.lock', 'admin/package.json', 'admin/package-lock.json']:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, root / name)
            self.assertEqual(release.set_version('1.2.3', root), '1.2.3')
            self.assertEqual(release.version(root), '1.2.3')
            with self.assertRaises(ValueError):
                release.set_version('v1.2.3', root)

    def test_publish_checks_download_before_publishing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            tag = 'v' + release.version()
            (root / ('piccove-' + tag + '-linux-x86_64.tar.gz')).write_bytes(b'archive')
            (root / 'piccovectl-linux-x86_64').write_bytes(b'cli')
            (root / 'SHA256SUMS').write_text('test fixture')
            (root / 'release.json').write_text(json.dumps({
                'commit': 'abc', 'dirty': False, 'target': 'x86_64-unknown-linux-musl'}))
            calls = []
            def run(command, **kwargs):
                calls.append(command)
                if command[:3] == ['gh', 'release', 'download']:
                    destination = Path(command[command.index('--dir') + 1])
                    for item in root.iterdir():
                        shutil.copy2(item, destination / item.name)
                return type('Result', (), {'returncode': 1, 'stdout': ''})()
            with patch.object(publish.subprocess, 'run', side_effect=run):
                publish.publish(root, tag, 'dovetaill/PicCove', 'abc')
            self.assertEqual(calls[-1][:3], ['gh', 'release', 'edit'])
            def corrupt(command, **kwargs):
                result = run(command, **kwargs)
                if command[:3] == ['gh', 'release', 'download']:
                    (Path(command[command.index('--dir') + 1]) / 'release.json').write_text('corrupt')
                return result
            calls.clear()
            with patch.object(publish.subprocess, 'run', side_effect=corrupt):
                with self.assertRaises(ValueError):
                    publish.publish(root, tag, 'dovetaill/PicCove', 'abc')
            self.assertFalse(any(c[:3] == ['gh', 'release', 'edit'] for c in calls))

if __name__ == '__main__':
    unittest.main()
