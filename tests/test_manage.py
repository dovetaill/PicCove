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
    def bundle(self, root, extra=None, version='0.1.0'):
        name = f'piccove-v{version}-linux-x86_64'
        archive = root / (name + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as tar:
            files = {'bin/piccove-api': b'binary', 'web/index.html': b'html', 'compose.yml': b'compose',
                     'install.sh': b'exit 0', 'configure.py': b'config',
                     'release.json': json.dumps({'version': version, 'target': 'x86_64-unknown-linux-musl', 'dirty': False}).encode()}
            for path, data in files.items():
                info = tarfile.TarInfo(name + '/' + path)
                info.size = len(data)
                info.mode = 0o755 if path == 'bin/piccove-api' else 0o644
                tar.addfile(info, io.BytesIO(data))
            if extra:
                tar.addfile(extra)
        (root / 'SHA256SUMS').write_text(manage.checksum(archive) + '  ' + archive.name + '\n')
        return archive

    def test_archive_validation_and_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self.bundle(root)
            bundle = manage.unpack(archive, root / 'stage')
            self.assertTrue((bundle / 'bin/piccove-api').stat().st_mode & 0o100)
            archive.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                manage.unpack(archive, root / 'bad')

    def test_reject_traversal_links_and_secrets(self):
        for name, kind in [('outside/../../escaped', tarfile.REGTYPE),
                           ('piccove-v0.1.0-linux-x86_64/link', tarfile.SYMTYPE),
                           ('piccove-v0.1.0-linux-x86_64/.env', tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                member = tarfile.TarInfo(name); member.type = kind; member.linkname = '/tmp'
                archive = self.bundle(root, member)
                with self.assertRaises(ValueError):
                    manage.unpack(archive, root / 'stage')
                self.assertFalse((root / 'stage').exists())

    def test_existing_install_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.env').write_text('untouched')
            with self.assertRaisesRegex(ValueError, '已存在'):
                manage.install(types.SimpleNamespace(directory=root))
            self.assertEqual((root / '.env').read_text(), 'untouched')

    def test_backup_failure_resumes_only_previously_running_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); calls = []
            def compose(directory, *args, **kwargs):
                calls.append(args)
                if args[0] == 'ps':
                    return types.SimpleNamespace(stdout='api\npostgres\n')
                if args[0] == 'exec':
                    raise subprocess.CalledProcessError(1, args)
            with patch.object(manage, 'compose', side_effect=compose):
                with self.assertRaises(subprocess.CalledProcessError):
                    manage.backup(root, root / 'backup')
            self.assertEqual(calls[-1], ('start', 'api'))
            self.assertFalse((root / 'backup/SHA256SUMS').exists())

    def test_upgrade_backup_does_not_reopen_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); calls = []
            (root / '.env').write_text('secret')
            def compose(directory, *args, **kwargs):
                calls.append(args)
                if args[0] == 'ps':
                    return types.SimpleNamespace(stdout='api\nweb\npostgres\n')
                if 'stdout' in kwargs:
                    kwargs['stdout'].write(b'backup')
            with patch.object(manage, 'compose', side_effect=compose):
                manage.backup(root, root / 'backup', resume=False)
            self.assertNotIn(('start', 'api', 'web'), calls)
            self.assertTrue((root / 'backup/SHA256SUMS').is_file())
            self.assertEqual((root / 'backup/.env').stat().st_mode & 0o777, 0o600)

    def test_upgrade_rejects_old_version_before_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); install = root / 'installed'; install.mkdir()
            (install / 'release.json').write_text(json.dumps({'version': '0.1.0'}))
            args = types.SimpleNamespace(directory=install, archive=self.bundle(root), backup=root / 'backup')
            with patch.object(manage, 'backup') as backup:
                with self.assertRaisesRegex(ValueError, '更高版本'):
                    manage.upgrade(args)
                backup.assert_not_called()

    def test_upgrade_failure_stops_app_without_overwriting_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); install = root / 'installed'; install.mkdir()
            (install / 'release.json').write_text(json.dumps({'version': '0.1.0'}))
            (install / '.env').write_text('keep these credentials')
            args = types.SimpleNamespace(directory=install, archive=self.bundle(root, version='0.1.1'), backup=root / 'backup')
            calls = []
            def compose(directory, *command, **kwargs):
                calls.append(command)
                if command[0] == 'up':
                    raise subprocess.CalledProcessError(1, command)
            with patch.object(manage, 'backup') as backup, patch.object(manage, 'compose', side_effect=compose):
                with self.assertRaises(subprocess.CalledProcessError):
                    manage.upgrade(args)
                backup.assert_called_once_with(install, args.backup, resume=False)
            self.assertEqual(calls[-1], ('stop', 'api', 'web'))
            self.assertEqual((install / '.env').read_text(), 'keep these credentials')

    def test_foreign_compose_project_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'bin').mkdir()
            for name in ['.env', 'compose.yml', 'bin/piccove-api']:
                (root / name).write_text('fixture')
            config = {'name': 'piccove', 'services': {'api': {}, 'web': {}, 'postgres': {}}}
            with patch.object(manage, 'compose', return_value=types.SimpleNamespace(stdout=json.dumps(config))), patch.object(manage, 'output', side_effect=['container-id', '/another/installation']):
                with self.assertRaisesRegex(ValueError, '其他安装目录'):
                    manage.validate_install(root)

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
